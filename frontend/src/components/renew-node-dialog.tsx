'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Banknote, Ticket as TicketIcon, XCircle, CheckCircle2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface Props {
  node: any;
  open: boolean;
  onClose: () => void;
  onDone: () => void; // 续费成功后刷新节点列表
}

const GB = 1024 * 1024 * 1024;

/** 节点续期 / 流量续费弹窗：选套餐 → 支付（余额直付 / 微信 / 支付宝 / 卡密充值）。 */
export default function RenewNodeDialog({ node, open, onClose, onDone }: Props) {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [plans, setPlans] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [method, setMethod] = useState<string>('');
  const [orderNo, setOrderNo] = useState<string>('');
  const [payQr, setPayQr] = useState<string | null>(null);
  const [cardCode, setCardCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false); // 网关支付成功但节点还在应用
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const renewable = useCallback(
    (p: any) => {
      const hasDays = Number(p.duration) > 0;
      const hasTraffic = Number(p.traffic) > 0;
      const daysOk = hasDays && !!node?.expiryTime; // 不限时节点无法续期（面板会跳过）
      const trafficOk = hasTraffic && Number(node?.trafficLimit) > 0; // 不限流量节点无法续流量
      return (daysOk || trafficOk) && !p.isTrial;
    },
    [node],
  );

  useEffect(() => {
    if (!open) return;
    setPlans([]);
    setSelected(null);
    setMethod('');
    setOrderNo('');
    setPayQr(null);
    setCardCode('');
    setPaid(false);
    api
      .get('/plans')
      .then((res) => setPlans((res.data.data || []).filter(renewable)))
      .catch(() => setPlans([]));
  }, [open, renewable]);

  // 清理轮询：组件卸载 / 关闭弹窗 / 重新打开
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = (no: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get(`/payments/status/${no}`);
        const d = res.data.data;
        if (d.status === 'COMPLETED') {
          clearInterval(pollRef.current!);
          toast.success('续费成功，节点已更新并恢复');
          onDone();
          onClose();
          return;
        }
        if (d.paid && !paid) {
          setPaid(true);
          toast.success('支付成功，正在应用续费...');
        }
      } catch {
        // 轮询瞬间错误静默
      }
    }, 3000);
  };

  // 下单 + 支付
  const confirmRenew = async (m: string) => {
    if (!selected) return;
    setMethod(m);
    // 卡密：充进余额，不建单（后续用户改用余额支付）
    if (m === 'card') {
      setCardCode('');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post('/orders', {
        planId: selected.id,
        renewalOfInboundId: node.id, // 后端校验归属 + 面板 bulkAdjust 加量 + 自动重启
      });
      const order = res.data.data;
      setOrderNo(order.orderNo);

      if (m === 'balance') {
        const payRes = await api.post(`/orders/${order.id}/pay/balance`);
        await refreshUser(); // 扣款成功，立即刷新余额
        const d = payRes.data?.data;
        if (d?.activationFailed) {
          toast.error('支付成功，但续费应用暂时失败，系统将自动重试，稍后可在「我的节点」查看');
          onClose();
          return;
        }
        toast.success('续费成功，节点已更新并恢复');
        onDone();
        onClose();
        return;
      }

      // 微信 / 支付宝 → 真实二维码 + 轮询
      const payRes = await api.post(`/payments/orders/${order.id}`, { method: m });
      const qr = payRes.data.data?.qrContent;
      if (!qr) throw new Error('支付网关未返回二维码内容，请确认支付已配置');
      setPayQr(qr);
      startPolling(order.orderNo);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
      setMethod('');
      setPayQr(null);
    } finally {
      setBusy(false);
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>节点续费 / 续流量</DialogTitle>
        </DialogHeader>

        {/* 节点现状 */}
        <div className="rounded-lg bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{node.server?.name} · {node.protocol}</span>
            {statusLabel[node.status] || <Badge variant="secondary">{node.status}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            {node.expiryTime ? (
              <span>到期：{new Date(node.expiryTime).toLocaleDateString()}</span>
            ) : (
              <span>不限时</span>
            )}
            {Number(node.trafficLimit) > 0 ? (
              <span>额度：{((Number(node.totalTraffic) || 0) / GB).toFixed(2)} / {(Number(node.trafficLimit) / GB).toFixed(1)}GB 已用</span>
            ) : (
              <span>不限流量</span>
            )}
          </div>
        </div>

        {payQr ? (
          // 二维码支付中
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG value={payQr} size={200} />
            </div>
            <p className="text-sm text-muted-foreground">请用 {method === 'wechat' ? '微信' : '支付宝'} 扫码支付</p>
            {paid && <p className="text-sm font-medium text-primary">支付成功，正在应用续费...</p>}
            <span className="text-xs text-muted-foreground">{orderNo}</span>
            <Button variant="outline" size="sm" onClick={() => { setPayQr(null); }}>返回</Button>
          </div>
        ) : (
          <>
            {/* 套餐选择 */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">选择续费套餐（时长在现有到期时间上累加，剩余时间不浪费）：</p>
              {plans.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <p>当前没有可续费的套餐</p>
                  <p className="mt-1 text-xs">（需要含时长或流量，且与节点能力匹配的套餐）</p>
                </div>
              )}
              {plans.map((p) => {
                const active = selected?.id === p.id;
                const parts: string[] = [];
                if (Number(p.duration) > 0 && node.expiryTime) parts.push(`+${Number(p.duration)} 天有效期`);
                if (Number(p.traffic) > 0 && Number(node.trafficLimit) > 0) parts.push(`+${(Number(p.traffic) / GB).toFixed(0)}GB 流量`);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setSelected(p); setMethod(''); setPayQr(null); }}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      active ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent'
                    }`}
                  >
                    <div>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{parts.join(' · ')}</div>
                    </div>
                    <span className="font-semibold text-primary">¥{Number(p.price)}</span>
                  </button>
                );
              })}
            </div>

            {/* 支付方式 */}
            {selected && !payQr && (
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

                {/* 卡密充值（充进余额，后续用余额支付） */}
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
                    当前余额：<span className="font-semibold text-primary">¥{Number(user?.balance ?? 0)}</span>，选中套餐后可直接用余额支付
                  </p>
                )}
              </div>
            )}

            <div className="pt-2 text-xs text-muted-foreground">续费后节点将自动恢复并重启（面板侧自动生效）</div>
            <div className="pt-1 text-xs text-muted-foreground">续费订单不支持申请退款（退款仅限购买订单），费用问题请联系客服。</div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}