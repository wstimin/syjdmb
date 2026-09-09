'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Wallet, Loader2, XCircle, Plus, Minus, Ticket as TicketIcon } from 'lucide-react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

// 流水类型 → 中文（管理端编辑后台也用这套语义）
const TX_LABELS: Record<string, string> = {
  RECHARGE: '余额充值',
  PURCHASE: '购买方案',
  REFUND: '退款',
  CARD_REDEEM: '卡密兑换',
  REFERRAL: '邀请返利',
  ADMIN_ADJUST: '人工调整',
};

const QUICK_AMOUNTS = [50, 100, 200, 500];

const paymentMethods = [
  { id: 'wechat', label: '微信支付', icon: '💚' },
  { id: 'alipay', label: '支付宝', icon: '💙' },
  { id: 'card', label: '卡密兑换', icon: <TicketIcon className="h-5 w-5" /> },
];

export default function BalancePage() {
  const { user, refreshUser } = useAuth();
  const [amount, setAmount] = useState<string>('100');
  const [creating, setCreating] = useState(false);
  const [payQr, setPayQr] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('');
  const [cardCode, setCardCode] = useState<string>('');
  const [redeeming, setRedeeming] = useState(false);
  const redeemingRef = useRef(false); // Enter/按钮双击防重入（按钮 disabled 挡不住 Enter 提交）
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // 余额明细
  const [txs, setTxs] = useState<any[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txPage, setTxPage] = useState(1);
  const [txLoading, setTxLoading] = useState(true);
  const [trigger, setTrigger] = useState(0); // 充值成功后刷新明细

  const pageSize = 20;

  const fetchTxs = useCallback(async () => {
    setTxLoading(true);
    try {
      const res = await api.get('/transactions/mine', { params: { page: txPage, limit: pageSize } });
      setTxs(res.data.data.list);
      setTxTotal(res.data.data.total);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setTxLoading(false);
    }
  }, [txPage]);

  useEffect(() => {
    fetchTxs();
  }, [fetchTxs, trigger]);

  // 卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((orderNo: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    let paid = false;
    let notified = false; // 2 分钟提醒只弹一次，避免每 3 秒重复轰炸
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get(`/recharges/status/${orderNo}`);
        const d = res.data.data;
        if (d.paid) {
          clearInterval(pollRef.current!);
          if (!paid) {
            paid = true;
            toast.success(`充值成功！余额已到账`);
            await refreshUser();
            setPayQr(null);
            setTrigger((v) => v + 1);
          }
          return;
        }
        // 2 分钟后还没支付，提示用户可以关闭页面稍后查看（只提示一次）
        if (Date.now() - startedAt > 2 * 60 * 1000 && !notified) {
          notified = true;
          toast('还在等待支付确认，你已可以在「余额明细」中查看到账情况', { icon: '⏳' });
        }
      } catch {
        // 网络抖动忽略
      }
    }, 3000);
  }, [refreshUser]);

  const createRecharge = async (m: string) => {
    setMethod(m);
    // 卡密兑换不是网关支付：不校验充值金额、不建 RC 单，直接展开卡密输入面板（兑换进余额）
    if (m === 'card') {
      setPayQr(null);
      return;
    }
    const amt = Number(amount);
    if (!(amt > 0)) {
      toast.error('请输入充值金额（大于 0）');
      return;
    }
    if (amt > 50000) {
      toast.error('单笔充值金额不能超过 50000 元');
      return;
    }
    setCreating(true);
    try {
      const recharge = await api.post('/recharges', { amount: amt });
      const { orderNo } = recharge.data.data;
      const payRes = await api.post(`/recharges/${orderNo}/payment`, { method: m });
      const qr = payRes.data.data?.qrContent;
      if (!qr) {
        throw new Error('支付方式未正确配置，请联系客服确认（微信/支付宝）');
      }
      setPayQr(qr);
      startPolling(orderNo);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const cancelRecharge = async () => {
    // 取消支付展示态；若尚未支付，后台 RC 单保持 PENDING，稍后可再次拉起或由用户忽略
    if (pollRef.current) clearInterval(pollRef.current);
    setPayQr(null);
  };

  // 卡密兑换 → 余额入账（后端 POST /payments/card/redeem：原子占卡 + 递增入账 + 记流水）
  const redeemCard = async () => {
    if (redeemingRef.current) return; // ref 锁：连按 Enter/按钮不会并发重复兑换同一张卡
    const code = cardCode.trim();
    if (!code) {
      toast.error('请输入卡密');
      return;
    }
    redeemingRef.current = true;
    setRedeeming(true);
    try {
      const res = await api.post('/payments/card/redeem', { code });
      toast.success(`卡密兑换成功，余额 +¥${fmtMoney(res.data.data.amount)}`);
      await refreshUser();
      setCardCode('');
      setTrigger((v) => v + 1); // 刷新余额明细
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setRedeeming(false);
      redeemingRef.current = false;
    }
  };

  const fmtMoney = (n: any) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 流水金额展示：按类型定号（PURCHASE 恒为支出；REFUND 是退款=钱退回，记正数显示绿色 +；其余看数值正负）
  const txSign = (t: any) =>
    ['PURCHASE'].includes(t.type) ? '-' : Number(t.amount) < 0 ? '-' : '+';

  if (!user) {
    return <div className="py-32 text-center text-muted-foreground"><Skeleton className="mx-auto h-40 w-full max-w-2xl" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* 余额总览 */}
      <Card className="bg-gradient-to-br from-primary/10 via-background to-background">
        <CardContent className="flex items-center justify-between p-6">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15">
              <Wallet className="h-7 w-7 text-primary" />
            </span>
            <div>
              <div className="text-sm text-muted-foreground">账户余额（余额可用于购买方案与续费）</div>
              <div className="mt-1 text-3xl font-bold text-primary">¥ {fmtMoney(user.balance)}</div>
            </div>
          </div>
          <Link2Glance />
        </CardContent>
      </Card>

      {/* 充值 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">余额充值</CardTitle>
          <CardDescription>选择金额 → 选择支付方式 → 扫码付款，到账后余额自动更新</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={50000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-40"
              placeholder="充值金额"
            />
            {QUICK_AMOUNTS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setAmount(String(q))}
                className="rounded-full border border-input px-3 py-1.5 text-sm transition-colors hover:border-primary hover:text-primary"
              >
                ¥{q}
              </button>
            ))}
            <span className="text-xs text-muted-foreground">单笔 1 ~ 50000 元</span>
          </div>

          {!payQr && (
            <div className="flex flex-wrap gap-3 pt-1">
              {paymentMethods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => createRecharge(m.id)}
                  disabled={creating}
                  className="flex items-center gap-2 rounded-xl border px-5 py-3 text-sm font-medium transition-all hover:border-primary hover:shadow-sm disabled:opacity-50"
                >
                  <span className="text-lg">{m.icon}</span>
                  {m.label}
                  {creating && method === m.id && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                </button>
              ))}
            </div>
          )}

          {/* 卡密兑换面板：选中「卡密兑换」时展开（不建充值单，兑换直接进余额） */}
          {method === 'card' && !payQr && (
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
              <Input
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value.toUpperCase())}
                placeholder="输入卡密（如 XXXX-XXXX-XXXX-XXXX），不区分大小写"
                className="font-mono sm:max-w-sm"
                onKeyDown={(e) => e.key === 'Enter' && redeemCard()}
              />
              <Button onClick={redeemCard} disabled={!cardCode.trim() || redeeming} className="sm:w-28">
                {redeeming && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                兑换到余额
              </Button>
            </div>
          )}

          {payQr && (
            <div className="flex flex-col items-center py-2">
              <p className="mb-2 text-sm font-semibold">扫码支付 ¥{fmtMoney(amount)}</p>
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={payQr} size={200} />
              </div>
              <div className="mt-4 flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                等待支付确认中...
              </div>
              <button
                onClick={cancelRecharge}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-destructive"
              >
                <XCircle className="h-4 w-4" />
                取消
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 余额明细 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">余额明细</CardTitle>
          <CardDescription>最近 {pageSize} 条（共 {txTotal} 条）</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {txLoading && txs.length === 0 ? (
            <div className="space-y-2 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
          ) : txs.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">暂无余额变动记录</div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {txs.map((t: any) => {
                  const sign = txSign(t);
                  const isOut = sign === '-';
                  return (
                    <div key={t.id} className="flex items-center justify-between px-6 py-3.5">
                      <div className="flex items-center gap-3">
                        <span
                          className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                            isOut ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-500'
                          }`}
                        >
                          {isOut ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        </span>
                        <div>
                          <div className="text-sm font-medium">{TX_LABELS[t.type] || t.type}</div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(t.createdAt).toLocaleString('zh-CN')}
                            {t.description ? ` · ${t.description}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-sm font-semibold ${isOut ? 'text-destructive' : 'text-emerald-500'}`}>
                          {sign}¥{fmtMoney(Math.abs(Number(t.amount)))}
                        </div>
                        <div className="text-xs text-muted-foreground">余额 ¥{fmtMoney(t.balance)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {txTotal > pageSize && (
                <div className="flex items-center justify-center gap-3 border-t border-border px-6 py-3">
                  <Button variant="outline" size="sm" disabled={txPage <= 1} onClick={() => setTxPage((p) => p - 1)}>
                    上一页
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {txPage} / {Math.ceil(txTotal / pageSize)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={txPage >= Math.ceil(txTotal / pageSize)}
                    onClick={() => setTxPage((p) => p + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Link2Glance() {
  return (
    <div className="hidden text-right text-xs text-muted-foreground sm:block">
      充值记录与消费记录
      <br />
      都会在这里以明细展示
    </div>
  );
}