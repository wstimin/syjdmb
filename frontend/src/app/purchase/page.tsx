'use client';

import { useEffect, useState, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import toast from 'react-hot-toast';
import { Banknote, Ticket as TicketIcon, Loader2, XCircle } from 'lucide-react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function PurchaseContent() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const planId = searchParams.get('plan');

  const [plan, setPlan] = useState<any>(null);
  const [servers, setServers] = useState<any[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<any>(null);
  const [method, setMethod] = useState<string>('');
  const [relay, setRelay] = useState(false);
  // 开启中转后：用户填写自己 SOCKS 节点的信息（出口 = 该 SOCKS 节点 IP）
  const [relayHost, setRelayHost] = useState('');
  const [relayPort, setRelayPort] = useState('');
  const [relayUser, setRelayUser] = useState('');
  const [relayPass, setRelayPass] = useState('');
  const [payQr, setPayQr] = useState<string | null>(null);
  const [cardCode, setCardCode] = useState('');
  const [processing, setProcessing] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!planId) return;
    api.get(`/plans/${planId}`)
      .then((res) => setPlan(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));

    // 拉套餐可用服务器（供用户选择在哪台服务器上建节点）
    api.get(`/plans/${planId}/servers`)
      .then((res) => {
        const list = res.data.data || [];
        setServers(list);
        if (list.length > 0) setSelectedServerId(list[0].id);
      })
      .catch(() => setServers([]))
      .finally(() => setServersLoaded(true));
  }, [planId]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startPolling = (orderNo: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    let notified = false;
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get(`/payments/status/${orderNo}`);
        const d = res.data.data;
        // 节点创建完成才跳转；仅收到支付（PAID/PROCESSING）说明节点还在建，继续轮询
        if (d.status === 'COMPLETED') {
          clearInterval(pollRef.current!);
          toast.success(t('purchase.orderSuccess') || '支付成功，节点已就绪');
          setTimeout(() => router.push('/user/nodes'), 1200);
          return;
        }
        if (!notified && d.paid) {
          notified = true;
          toast.success(t('purchase.paySuccess') || '支付成功！正在创建节点...');
          return;
        }
        // 兜底超时：10 分钟节点还没建出来，别让用户无限等待
        if (Date.now() - startedAt > 10 * 60 * 1000) {
          clearInterval(pollRef.current!);
          toast.error('等待节点创建超时，请稍后到「我的节点」查看，或联系客服');
        }
      } catch {
        // Silently ignore transient errors during polling
      }
    }, 3000);
  };

  const methods = [
    { id: 'wechat', label: t('purchase.wechat'), icon: '💚' },
    { id: 'alipay', label: t('purchase.alipay'), icon: '💙' },
    { id: 'card', label: t('purchase.cardKey'), icon: <TicketIcon className="h-5 w-5" /> },
    { id: 'balance', label: t('purchase.balance'), icon: <Banknote className="h-5 w-5" /> },
  ];

  const createOrder = async (m: string) => {
    setMethod(m);
    // 卡密走「充值余额」，不是订单支付：不建单，直接展开卡密输入面板
    if (m === 'card') {
      setProcessing(false);
      return;
    }
    setProcessing(true);
    try {
      const res = await api.post('/orders', {
        planId: Number(planId),
        payMethod: m === 'card' ? undefined : m,
        serverId: selectedServerId ?? undefined, // 用户选择在这台服务器上建节点
        relay,
        ...(relay
          ? {
              relaySocksHost: relayHost,
              relaySocksPort: Number(relayPort),
              relaySocksUser: relayUser || undefined,
              relaySocksPass: relayPass || undefined,
            }
          : {}),
      });
      const newOrder = res.data.data;
      setOrder(newOrder);

      // Balance: pay directly, skip QR
      if (m === 'balance') {
        const payRes = await api.post(`/orders/${newOrder.id}/pay/balance`);
        await refreshUser(); // 扣款成功，立即刷新余额等用户信息
        const data = payRes.data?.data;
        if (data?.activationFailed) {
          // 扣款成功、激活失败（如面板瞬时故障）：订单已是 PAID/PROCESSING，
          // 后台会每分钟自动重试建节点，用户无需重新下单
          toast.error('支付成功，但节点创建暂时失败，系统将自动重试，稍后可在「我的节点」查看');
          setTimeout(() => router.push('/user/nodes'), 1500);
          return;
        }
        toast.success(t('purchase.paySuccess') || '支付成功！正在创建节点...');
        setTimeout(() => router.push('/user/nodes'), 1500);
        return;
      }

      // Gateway (WeChat / Alipay): get real QR content
      const payRes = await api.post(`/payments/orders/${newOrder.id}`, { method: m });
      const qr = payRes.data.data?.qrContent;
      if (!qr) {
        throw new Error('支付网关未返回二维码内容，请确认支付已配置');
      }
      setPayQr(qr);
      setProcessing(false);
      // Start polling for payment confirmation
      startPolling(newOrder.orderNo);
    } catch (err: any) {
      // 下单或拉起支付失败：回到支付方式选择，避免卡在空白页（还没支付就不显示支付方式）
      toast.error(getErrorMessage(err));
      setProcessing(false);
      setMethod('');
      setOrder(null);
      setPayQr(null);
    }
  };

  const cancelPayment = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setPayQr(null);
    setOrder(null);
  };

  const redeemCard = async (code: string) => {
    setProcessing(true);
    try {
      const res = await api.post('/payments/card/redeem', { code });
      toast.success(`${t('purchase.redeemSuccess')} +¥${res.data.data.amount}`);
      await refreshUser();
      setCardCode('');
      setPayQr(null);
      setOrder(null);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setProcessing(false);
    }
  };

  if (loading) return <div className="py-32 text-center">{t('common.loading')}</div>;
  if (!plan) return <div className="py-32 text-center">Plan not found</div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold">{t('purchase.title')}</h1>

      {/* Plan summary */}
      <Card className="mt-6 border-border/60">
        <CardContent className="flex items-center justify-between p-6">
          <div>
            <div className="text-lg font-semibold">{plan.name}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {plan.duration > 0 ? `${t('products.duration')}: ${plan.duration}${t('products.days')}` : t('products.unlimited')}
              {' · '}
              {t('products.traffic')}: {Number(plan.traffic) > 0 ? `${Number(plan.traffic)/1024/1024/1024}GB` : t('products.unlimited')}
            </div>
          </div>
          <div className="text-2xl font-bold text-primary">¥{Number(plan.price)}</div>
        </CardContent>
      </Card>

      {/* 选择服务器 — 用户选在哪台服务器上建节点（协议为系统默认 VLESS+Reality，不在购买页展示） */}
      {servers.length > 0 && (
        <Card className="mt-6 border-border/60">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">选择服务器</div>
              <span className="text-xs text-muted-foreground">节点类型默认 VLESS + Reality</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {servers.map((s: any) => {
                const active = selectedServerId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedServerId(s.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-input text-foreground hover:bg-accent'
                    }`}
                  >
                    {s.flag || ''} {s.name} · {s.country || '—'}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 开启中转（选装） — 在该源节点上挂 SOCKS，节点全程走中转，出口 = 用户填写的 SOCKS 节点 IP */}
      <Card className="mt-6 border-border/60">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <input
                id="relay-toggle"
                type="checkbox"
                checked={relay}
                onChange={(e) => setRelay(e.target.checked)}
                className="h-5 w-5 accent-primary"
              />
              <label htmlFor="relay-toggle" className="cursor-pointer">
                <div className="text-sm font-semibold">开启中转（SOCKS 线路）</div>
                <div className="text-xs text-muted-foreground">
                  节点流量全程经 SOCKS 链路转发，出口 IP 为你填写的 SOCKS 节点所在地址
                </div>
              </label>
            </div>
            <span className="text-xs text-muted-foreground">选装</span>
          </div>

          {/* 勾选中转后展开：填写自有 SOCKS 节点信息 */}
          {relay && (
            <div className="mt-4 space-y-3 rounded-xl bg-muted/40 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>SOCKS 地址 *</Label>
                  <Input
                    value={relayHost}
                    onChange={(e) => setRelayHost(e.target.value)}
                    placeholder="1.2.3.4 或域名"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>SOCKS 端口 *</Label>
                  <Input
                    value={relayPort}
                    onChange={(e) => setRelayPort(e.target.value)}
                    placeholder="1080"
                    type="number"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>用户名（可选）</Label>
                  <Input value={relayUser} onChange={(e) => setRelayUser(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>密码（可选）</Label>
                  <Input value={relayPass} onChange={(e) => setRelayPass(e.target.value)} type="password" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                请填写你自有的 SOCKS5 节点；节点创建后将全程经由该 SOCKS 出站，出口 IP 为该节点地址。
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment method selection */}
      {!order && !payQr && (
        <div className="mt-6">
          <h2 className="mb-4 text-lg font-semibold">{t('purchase.paymentMethod')}</h2>
          {serversLoaded && servers.length === 0 && (
            <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              该套餐暂无可用服务器，暂不可购买，请联系客服
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {methods.map((m) => (
              <button
                key={m.id}
                onClick={() => createOrder(m.id)}
                disabled={processing || (serversLoaded && servers.length === 0)}
                className="flex items-center gap-3 rounded-xl border p-4 text-left transition-all hover:border-primary hover:shadow-md disabled:opacity-50"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-xl">
                  {typeof m.icon === 'string' ? m.icon : m.icon}
                </span>
                <span className="font-medium">{m.label}</span>
                {processing && <Loader2 className="ml-auto h-4 w-4 animate-spin" />}
              </button>
            ))}
          </div>

          {user && Number(user.balance) > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              {t('purchase.balanceNow')}: <span className="font-semibold text-primary">¥{Number(user.balance)}</span>
            </p>
          )}
        </div>
      )}

      {/* Card redemption */}
      {!order && method === 'card' && !payQr && (
        <Card className="mt-6 border-border/60">
          <CardHeader>
            <CardTitle className="text-lg">{t('purchase.cardRedeem')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder={t('purchase.cardPlaceholder')}
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value)}
              />
              <Button onClick={() => redeemCard(cardCode)} disabled={!cardCode || processing}>
                {t('purchase.redeem')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Real QR — WeChat/Alipay — with status polling */}
      {payQr && (
        <div className="mt-6">
          <Card className="border-border/60">
            <CardContent className="flex flex-col items-center p-8">
              <h2 className="mb-2 text-lg font-semibold">{t('purchase.scanToPay')}</h2>
              <p className="mb-4 text-xs text-muted-foreground">付款完成后此页面将自动跳转，请勿关闭</p>
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={payQr} size={220} />
              </div>
              <p className="mt-4 text-sm font-semibold text-muted-foreground">¥{Number(order.amount)}</p>
              <div className="mt-5 flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>等待支付确认中...</span>
              </div>
              <button
                onClick={cancelPayment}
                className="mt-5 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-destructive"
              >
                <XCircle className="h-4 w-4" />
                {t('common.cancel')}
              </button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Balance / gateway setup loading — 已下单但支付信息尚未就绪时的过渡态 */}
      {order && processing && !payQr && (
        <div className="mt-6 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-muted-foreground">{t('common.loading')}</p>
        </div>
      )}
    </div>
  );
}

export default function PurchasePage() {
  return (
    <Suspense fallback={<div className="py-32 text-center">Loading...</div>}>
      <PurchaseContent />
    </Suspense>
  );
}
