'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Banknote, Ticket as TicketIcon, XCircle, CheckCircle2, Cable } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface Props {
  socks: any; // 来自 /socks-panel/mine 的节点台账行
  open: boolean;
  onClose: () => void;
  onDone: () => void; // 续费成功后刷新节点列表
}

const DAY_MS = 24 * 3600 * 1000;

/** SOCKS 节点续费弹窗：与 renew-node-dialog 同支付/轮询/防重出口机制，但仅「到期续费」（时长制不限流量）：
 * - 续费对象 = SOCKS_PANEL 虚拟商品（可换商品，与 Inbound 续费可换套餐同语义）
 * - 严格周期锚：新到期 = 原到期 + 商品时长（不因续费时刻顺延）；已到期节点在一天宽限期内也可续费
 * - 下单 = POST /orders { virtualProductId, renewalOfSocksNodeId, renewType:'EXPIRY' }
 * - 本地先行（renewalAppliedAt 幂等）→ 面板复活，轮询终态 COMPLETED 才收起
 */
export default function RenewSocksDialog({ socks, open, onClose, onDone }: Props) {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [products, setProducts] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [method, setMethod] = useState<string>('');
  const [orderNo, setOrderNo] = useState<string>('');
  const [orderId, setOrderId] = useState<number | null>(null);
  const [payQr, setPayQr] = useState<string | null>(null);
  const [cardCode, setCardCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);
  const paidRef = useRef(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  // 轮询链统一停表（与 renew-node-dialog 同款对抗复核）：防关闭弹窗后在途 await 复活轮询
  const stoppedRef = useRef(false);

  const node = socks;
  const isTimeExpired = !!node?.expiryTime && new Date(node.expiryTime).getTime() <= Date.now();
  // 管理员暂停的节点后端禁止续费（不复活管理停用节点）
  const suspended = node?.status === 'SUSPENDED';

  // 可选商品：在售 SOCKS_PANEL + 时长，且「续费后新到期 > 现在」（过期超过一个完整周期后端拒绝）
  const availableProducts = useCallback(() => {
    if (!node?.expiryTime) return [];
    const old = new Date(node.expiryTime).getTime();
    return products.filter((p: any) => {
      const dur = Number(p.duration);
      if (p.deliveryType !== 'SOCKS_PANEL' || p.status !== 'ACTIVE' || !(dur > 0)) return false;
      return old + dur * DAY_MS > Date.now();
    });
  }, [products, node]);

  // 续费后到期预览（严格周期锚：原到期 + 商品时长）
  const nextExpiryOf = useCallback(
    (p: any) => {
      if (!node?.expiryTime) return null;
      return new Date(new Date(node.expiryTime).getTime() + Number(p.duration) * DAY_MS);
    },
    [node],
  );

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setMethod('');
    setOrderNo('');
    setOrderId(null);
    setPayQr(null);
    setCardCode('');
    setPaid(false);
    paidRef.current = false;
    api
      .get('/virtual-products')
      .then((res) => setProducts((res.data.data || []).filter((p: any) => p.deliveryType === 'SOCKS_PANEL')))
      .catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 清理轮询：关闭弹窗 / 卸载时停表 + 停表开关（对抗复核 F10 同款）
  useEffect(() => {
    if (!open) return undefined;
    return () => {
      stoppedRef.current = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [open]);

  const stopPolling = () => {
    stoppedRef.current = true;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // 防重出口：拉回该节点在途续费单（PENDING/PAID/PROCESSING）继续支付，不重复建单
  const findExistingRenewalOrder = useCallback(async (): Promise<any | null> => {
    for (let page = 1; page <= 3; page++) {
      const res = await api.get(`/orders/mine?page=${page}&limit=50`);
      const data = res.data?.data;
      const orders: any[] = data?.orders || [];
      const hit = orders.find(
        (o: any) =>
          o?.renewalOfSocksNodeId === node?.id &&
          o?.renewType === 'EXPIRY' &&
          ['PENDING', 'PAID', 'PROCESSING'].includes(o?.status),
      );
      if (hit) return hit;
      if (!orders.length || page >= (data?.totalPages ?? 1)) break;
    }
    return null;
  }, [node]);

  const startPolling = (no: string) => {
    stopPolling();
    stoppedRef.current = false;
    let stopped = false;
    const tick = async () => {
      if (stopped || stoppedRef.current) return;
      try {
        const res = await api.get(`/payments/status/${no}`);
        const d = res.data.data;
        if (d.status === 'COMPLETED') {
          stopped = true;
          stopPolling();
          toast.success(t('myProducts.socksRenewed'));
          onDone();
          onClose();
          return;
        }
        if (d.status === 'FAILED' || d.status === 'EXPIRED' || d.status === 'CANCELLED') {
          stopped = true;
          stopPolling();
          setPayQr(null);
          setMethod('');
          setOrderId(null);
          setOrderNo('');
          toast.error(
            d.status === 'FAILED'
              ? '订单未通过审核或续费应用被拒（若已付款请联系客服核实），请重新发起续费'
              : '订单已终止（未支付订单超时自动关闭），请重新发起续费',
          );
          return;
        }
        if (d.paid && !paidRef.current) {
          paidRef.current = true;
          setPaid(true);
          toast.success('支付成功，正在应用续费...');
        }
      } catch {
        // 瞬时错误静默，下一跳重试
      }
      if (stopped || stoppedRef.current) return;
      pollRef.current = setTimeout(tick, 3000);
    };
    pollRef.current = setTimeout(tick, 3000);
  };

  // 下单 + 支付
  const confirmRenew = async (m: string) => {
    if (!selected || !node) return;
    setMethod(m);
    if (m === 'card') {
      setCardCode('');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post('/orders', {
        virtualProductId: selected.id,
        renewalOfSocksNodeId: node.id,
        renewType: 'EXPIRY',
      });
      const order = res.data.data;
      setOrderNo(order.orderNo);
      setOrderId(order.id);

      if (m === 'balance') {
        // 余额支付走同步激活：面板复活→重启可能超时，单独给足 90s
        const payRes = await api.post(`/orders/${order.id}/pay/balance`, undefined, { timeout: 90000 });
        await refreshUser();
        const d = payRes.data?.data;
        if (d?.activationFailed) {
          // PROCESSING 类失败 cron 会重试；终态 FAILED 类展示后端真实原因
          toast.error(d.message || '支付成功，但续费应用暂时失败，请稍后在「我的商品」查看');
          onClose();
          return;
        }
        toast.success(t('myProducts.socksRenewed'));
        onDone();
        onClose();
        return;
      }

      const payRes = await api.post(`/payments/orders/${order.id}`, { method: m });
      const qr = payRes.data.data?.qrContent;
      if (!qr) throw new Error('支付网关未返回二维码内容，请确认支付已配置');
      setPayQr(qr);
      startPolling(order.orderNo);
    } catch (err: any) {
      const msg = getErrorMessage(err);
      if (msg.includes('未完成的续费订单') && m !== 'card') {
        await continueExistingRenewal(m);
        return;
      }
      toast.error(msg);
      setMethod('');
      setPayQr(null);
    } finally {
      setBusy(false);
    }
  };

  // 撞防重后捞回已有单继续支付
  const continueExistingRenewal = async (m: string) => {
    try {
      const existing = await findExistingRenewalOrder();
      if (!existing) {
        toast.error('未找到可继续的续费订单，请稍后重试');
        setMethod('');
        return;
      }
      setOrderId(existing.id);
      setOrderNo(existing.orderNo);
      if (existing.status !== 'PENDING') {
        toast('已有续费正在处理中，请勿重复支付，稍后在「我的商品」查看');
        setMethod('');
        return;
      }
      if (m === 'balance') {
        const payRes = await api.post(`/orders/${existing.id}/pay/balance`, undefined, { timeout: 90000 });
        await refreshUser();
        const d = payRes.data?.data;
        if (d?.activationFailed) {
          toast.error(d.message || '支付成功，但续费应用暂时失败，请稍后在「我的商品」查看');
          onClose();
          return;
        }
        toast.success(t('myProducts.socksRenewed'));
        onDone();
        onClose();
        return;
      }
      const payRes = await api.post(`/payments/orders/${existing.id}`, { method: m });
      const qr = payRes.data.data?.qrContent;
      if (!qr) throw new Error('支付网关未返回二维码内容，请确认支付已配置');
      setPayQr(qr);
      startPolling(existing.orderNo);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
      setMethod('');
      setPayQr(null);
    }
  };

  const redeemCard = async () => {
    setBusy(true);
    try {
      const res = await api.post('/payments/card/redeem', { code: cardCode });
      toast.success(`充值成功 +¥${res.data.data.amount}`);
      await refreshUser();
      setCardCode('');
      setMethod('');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // 二维码视图「返回」：尝试取消未支付单；带支付方式的单取消失败则保留视图继续轮询
  const backFromQr = async () => {
    if (!orderId) {
      stopPolling();
      setOrderId(null);
      setOrderNo('');
      setPayQr(null);
      return;
    }
    try {
      await api.post(`/orders/${orderId}/cancel-self`);
      stopPolling();
      setOrderId(null);
      setOrderNo('');
      setPayQr(null);
      setMethod('');
    } catch {
      toast.error('该订单已生成支付码，无法自行取消。您可以继续扫码完成支付；或关闭后等待订单超时自动释放，再重新续费（也可联系客服取消）。');
    }
  };

  if (!node) return null;

  const methods = [
    { id: 'wechat', label: t('purchase.wechat'), icon: '💚' },
    { id: 'alipay', label: t('purchase.alipay'), icon: '💙' },
    { id: 'card', label: t('purchase.cardKey'), icon: <TicketIcon className="h-5 w-5" /> },
    { id: 'balance', label: t('purchase.balance'), icon: <Banknote className="h-5 w-5" /> },
  ];

  const statusLabel: Record<string, any> = {
    ACTIVE: <Badge variant="success">活跃</Badge>,
    EXPIRED: <Badge variant="danger">已过期</Badge>,
    SUSPENDED: <Badge variant="warning">已暂停</Badge>,
  };

  const curProducts = availableProducts();
  const serverName = node.server?.name || `#${node.serverId}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>SOCKS 节点续费（到期续费）</DialogTitle>
        </DialogHeader>

        {/* 节点现状 */}
        <div className="rounded-lg bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium">
              <Cable className="h-4 w-4 text-primary" />
              {serverName} · :{node.port}
            </span>
            {statusLabel[node.status] || <Badge variant="secondary">{node.status}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            {node.expiryTime ? (
              <span>{t('myProducts.socksExpiresAt')}：{new Date(node.expiryTime).toLocaleString()}</span>
            ) : (
              <span>不限时</span>
            )}
            <span>不限流量</span>
          </div>
        </div>

        {isTimeExpired && !suspended && (
          <p className="mt-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            {t('myProducts.socksGraceNote')}
          </p>
        )}

        {suspended && (
          <p className="mt-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            该节点已被管理员暂停，暂无法续费，请联系客服。
          </p>
        )}

        {payQr ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG value={payQr} size={200} />
            </div>
            <p className="text-sm text-muted-foreground">请用 {method === 'wechat' ? '微信' : '支付宝'} 扫码支付</p>
            {paid && <p className="text-sm font-medium text-primary">支付成功，正在应用续费...</p>}
            <span className="text-xs text-muted-foreground">{orderNo}</span>
            <Button variant="outline" size="sm" onClick={backFromQr}>返回</Button>
          </div>
        ) : (
          <>
            {/* 商品选择（SOCKS_PANEL 在售且能恢复有效性） */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                选择续费商品（新到期 = 当前到期日 + 商品时长，不在续费时刻顺延）
              </p>
              {curProducts.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <p>当前没有可续费的 SOCKS 商品</p>
                  <p className="mt-1 text-xs">（该节点已过期超过一个完整周期，无法通过续费恢复；请重新购买商品）</p>
                </div>
              ) : (
                curProducts.map((p) => {
                  const active = selected?.id === p.id;
                  const nextExpiry = nextExpiryOf(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={suspended}
                      onClick={() => { setSelected(p); setMethod(''); setPayQr(null); setOrderNo(''); setOrderId(null); }}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                        active ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent'
                      }`}
                    >
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="mt-0.5 text-xs text-primary">
                          续费后到期：{nextExpiry ? nextExpiry.toLocaleString() : '—'}
                        </div>
                      </div>
                      <span className="font-semibold text-primary">¥{Number(p.price)}</span>
                    </button>
                  );
                })
              )}
            </div>

            {/* 支付方式 */}
            {selected && !suspended && !payQr && (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-2">
                  {methods.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => confirmRenew(m.id)}
                      disabled={busy}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs transition-colors ${
                        method === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                      } disabled:opacity-60`}
                    >
                      <span className="text-base">{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>

                {method === 'card' && (
                  <div className="flex gap-2">
                    <Input
                      placeholder="请输入卡密"
                      value={cardCode}
                      onChange={(e) => setCardCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && redeemCard()}
                    />
                    <Button variant="outline" onClick={redeemCard} disabled={busy || !cardCode}>
                      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                      充值
                    </Button>
                  </div>
                )}

                {busy && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> 正在处理...
                  </div>
                )}
                {orderNo && !payQr && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <XCircle className="h-3 w-3" /> 订单 {orderNo} · 未支付
                  </span>
                )}
                {Number(user?.balance) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    当前余额：<span className="font-semibold text-primary">¥{Number(user?.balance ?? 0)}</span>，选中商品后可直接用余额支付
                  </p>
                )}
              </div>
            )}

            <div className="pt-2 text-xs text-muted-foreground">
              续费后到期日 = 当前到期日 + 商品时长（不因续费时刻顺延）；已到期节点须在 1 天宽限期内续费，超过将被自动删除，只能重新购买。
            </div>
            <div className="pt-1 text-xs text-muted-foreground">续费订单不支持申请退款（退款仅限购买订单），费用问题请联系客服。</div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}