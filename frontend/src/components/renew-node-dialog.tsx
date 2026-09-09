'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Banknote, Ticket as TicketIcon, XCircle, CheckCircle2, CalendarClock, Gauge } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Props {
  node: any;
  open: boolean;
  onClose: () => void;
  onDone: () => void; // 续费成功后刷新节点列表
}

const GB = 1024 * 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

type RenewKind = 'EXPIRY' | 'TRAFFIC';

/** 节点续费弹窗：续费拆成两类（到期续费 / 流量续费），订阅周期制语义：
 *  - 到期续费（EXPIRY）：到期日顺延套餐时长。节点未到期 → 当前流量不变，到周期切换点（原到期日）
 *    由后端 cron 自动清零已用、额度回归方案满额；节点已到期（一天续费宽限期内）→ 新周期锚在
 *    原到期日（新到期日 = 原到期日 + 时长），切换点已过 → 激活即按周期切换恢复满额流量；过期
 *    超过一天的节点已被自动删除，只能重新购买套餐。
 *  - 流量续费（TRAFFIC）：在当前流量额度上【叠加】套餐流量（不清除已用），到期时间不变；
 *    叠加量随本周期结束自动清零、不跨周期。
 */
export default function RenewNodeDialog({ node, open, onClose, onDone }: Props) {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [plans, setPlans] = useState<any[]>([]);
  const [kind, setKind] = useState<RenewKind | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [method, setMethod] = useState<string>('');
  const [orderNo, setOrderNo] = useState<string>('');
  const [orderId, setOrderId] = useState<number | null>(null); // 用于「返回」时取消未支付单
  const [payQr, setPayQr] = useState<string | null>(null);
  const [cardCode, setCardCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false); // 网关支付成功但节点还在应用
  const paidRef = useRef(false); // 轮询闭包里的 paid 恒为开启时的旧值 → 用 ref 挡重复 toast（118）
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  // 【对抗复核 F10：setTimeout 轮询链的共享停表开关】`stopped` 只是 startPolling 的闭包局部量，
  // stopPolling() 与 open→false 清理 effect 都够不到它 —— 关闭弹窗的瞬间若恰有一跳 await 未归，
  // 该跳回来后仍会执行 `pollRef.current = setTimeout(tick, ...)` 把轮询链「复活」，后台每 3s 请求
  // 直至订单 48h 过期，还会对共享状态发迟到 toast/清空二维码（可能清掉新开的一笔）。用一个
  // stoppedRef 作为统一停表开关：stopPolling()/清理 effect/终态分支都置 true，tick 入口与重排
  // 前都检查它，彻底堵死复活。
  const stoppedRef = useRef(false);

  // 本节点能力：
  //  - 到期续费：节点必须限期（有到期时间）。已到期节点在「一天续费宽限期」内也可续费（周期锚
  //    在原到期日、切换点已过即恢复满额，后端支持）；越过宽限期节点被自动删除，只能重新购买套餐
  //  - 流量续费：节点必须限流量，且「没有到期时间」或「尚未到期」（已到期节点叠加流量
  //    无意义 —— 时间维度仍停用，后端拒绝并指引先「到期续费」）
  const canExpiry = !!node?.expiryTime;
  const isTimeExpired = !!node?.expiryTime && new Date(node.expiryTime).getTime() <= Date.now();
  const canTraffic = Number(node?.trafficLimit) > 0 && !isTimeExpired;

  // 续费后的新到期日（预览/可选性判断）：严格周期锚 —— 到期日恒为「原到期日 + 套餐时长」，
  // 已到期节点也在原到期日起算（不在续费时刻重置周期），与后端 activateRenewalNewCycle 一致。
  const nextExpiryOf = useCallback(
    (p: any) => {
      if (!node?.expiryTime) return null;
      return new Date(new Date(node.expiryTime).getTime() + Number(p.duration) * DAY_MS);
    },
    [node],
  );

  // 每种续费类型的可选套餐：
  //  - 到期续费：套餐必须含时长；且「续费后的新到期日」仍在未来（node.expiryTime 缺失时
  //    nextExpiryOf 返回 null，天然排除）
  //  - 流量续费：套餐必须含流量
  const plansFor = useCallback(
    (k: RenewKind) => {
      if (!plans.length) return plans;
      if (k === 'EXPIRY') {
        return plans.filter((p: any) => {
          const hasDays = Number(p.duration) > 0;
          const next = nextExpiryOf(p);
          // 70：含流量的套餐，在节点不限流量时不可用于「到期续费」—— 后端对不限流量节点
          // 没有周期概念（periodQuota=0），卡片上却标着“到期自动回满”会误导
          if (Number(p.traffic) > 0 && Number(node?.trafficLimit) <= 0) return false;
          return hasDays && !p.isTrial && next !== null && next.getTime() > Date.now();
        });
      }
      return plans.filter((p: any) => Number(p.traffic) > 0 && !p.isTrial);
    },
    [plans, nextExpiryOf],
  );

  useEffect(() => {
    if (!open) return;
    setPlans([]);
    setKind(null);
    setSelected(null);
    setMethod('');
    setOrderNo('');
    setPayQr(null);
    setCardCode('');
    setPaid(false);
    paidRef.current = false;
    // 默认选中可用的续费类型：优先「到期续费」，不可用则「流量续费」
    const def: RenewKind | null = canExpiry ? 'EXPIRY' : canTraffic ? 'TRAFFIC' : null;
    setKind(def);
    api
      .get('/plans')
      .then((res) => setPlans((res.data.data || []).filter((p: any) => !p.isTrial)))
      .catch(() => setPlans([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 清理轮询：关闭弹窗（open→false）/ 组件卸载时停表，阻止对已关闭订单继续轮询（99）。
  // 【对抗复核 F10】除了清定时器，还必须把 stoppedRef 置 true —— 否则在途的一跳 await 回来后
  // 会重排下一跳，把轮询链在后台复活。
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

  // 【复核】防重报错时的出口：拉取该节点在途的续费单（PENDING/PAID/PROCESSING）。
  // 旧网关单 cancel-self 退不掉、会一直占着未完成名额 → 再下单必被防重拦截。
  // 命中防重错误时用这单「继续支付」，而不是把用户留在死胡同。
  const findExistingRenewalOrder = useCallback(async (): Promise<any | null> => {
    for (let page = 1; page <= 3; page++) {
      const res = await api.get(`/orders/mine?page=${page}&limit=50`);
      const data = res.data?.data;
      const orders: any[] = data?.orders || [];
      const hit = orders.find(
        (o: any) =>
          o?.renewalOfInbound?.id === node?.id &&
          // 【对抗复核确认】后端防重按 (userId, 节点, renewType) 分组 —— EXPIRY 的在途单
          // 不会拦 TRAFFIC 下单，反之亦然。捞回的订单必须与用户当前选的续费类型一致，
          // 否则可能付到另一种类型的单（付了流量续费的钱却去付到期续费的单，语义错乱）。
          // legacy（renewType=null）在途单同理不匹配新类型，不捞。
          o?.renewType === kind &&
          ['PENDING', 'PAID', 'PROCESSING'].includes(o?.status),
      );
      if (hit) return hit;
      if (!orders.length || page >= (data?.totalPages ?? 1)) break;
    }
    return null;
  }, [node, kind]);

  const startPolling = (no: string) => {
    stopPolling();
    // 【对抗复核 F10】stopPolling() 刚把 stoppedRef 置 true；这里重置为 false，保证
    // 「上一次轮询被终态/关闭停掉后，用户重新开启一笔新续费」时本轮轮询能真正跑起来。
    stoppedRef.current = false;
    // 【对抗复核确认】旧实现 setInterval + async：上一跳 await 未返回时下一跳已触发
    // （tick 重叠），成功块缺合并护栏，多跳可能并发 onClose；且只处理 COMPLETED，
    // FAILED/EXPIRED/CANCELLED 落入 paid=false 分支被跳过，二维码视图永久冻结。
    // 改 setTimeout 链：await 期间绝无下一跳；stopped 闭包标记 + stopPolling() 双保险，
    // 保证任一终态（成功/终止）只执行一次。
    let stopped = false;
    const tick = async () => {
      // 入口双保险：闭包 stopped 挡本链自己的终态，stoppedRef 挡「关闭弹窗/stopPolling 后
      // 在途 await 回来」的复活（F10）——任一处停了就绝不再继续，也不重排。
      if (stopped || stoppedRef.current) return;
      try {
        const res = await api.get(`/payments/status/${no}`);
        const d = res.data.data;
        if (d.status === 'COMPLETED') {
          stopped = true;
          stopPolling();
          toast.success('续费成功，节点已更新并恢复');
          onDone();
          onClose();
          return;
        }
        if (d.status === 'FAILED' || d.status === 'EXPIRED' || d.status === 'CANCELLED') {
          // 终态必须让二维码视图退场（否则永久冻结）。FAILED 可能是「订单未通过审核 /
          // 续费应用被拒」—— 已付款的续费订单不走自动退款（退款仅限购买订单），
          // 提示联系客服核实；EXPIRED/CANCELLED = 未支付单超时/被取消，直接重下即可。
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
          // 闭包读的 paid 永远是开启轮询时的 false → 用 ref 只 toast 一次（118）
          paidRef.current = true;
          setPaid(true);
          toast.success('支付成功，正在应用续费...');
        }
      } catch {
        // 轮询瞬间错误静默，下一跳重试
      }
      // 重排前再查一次 stoppedRef：await 期间若弹窗被关（F10），这里不得复活轮询链。
      if (stopped || stoppedRef.current) return;
      pollRef.current = setTimeout(tick, 3000);
    };
    pollRef.current = setTimeout(tick, 3000);
  };

  // 下单 + 支付（renewType 区分 到期续费/流量续费，后端按『订阅周期制』激活：EXPIRY 顺延/周期锚在原到期日、TRAFFIC 叠加）
  const confirmRenew = async (m: string) => {
    if (!selected || !kind) return;
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
        renewalOfInboundId: node.id, // 后端校验归属 + 面板重置/加量 + 自动重启
        renewType: kind,
      });
      const order = res.data.data;
      setOrderNo(order.orderNo);
      setOrderId(order.id);

      if (m === 'balance') {
        // 余额支付走同步激活：面板建入站→加量→重启可能超过实例 30s 默认超时，
        // 单独给足 90s，避免「后端已在生效、前端已超时报错」的假失败（11）
        const payRes = await api.post(`/orders/${order.id}/pay/balance`, undefined, { timeout: 90000 });
        await refreshUser(); // 扣款成功，立即刷新余额
        const d = payRes.data?.data;
        if (d?.activationFailed) {
          // 【对抗复核 F15】不能对一切激活失败都承诺「系统将自动重试」—— 只有 PROCESSING 类
          // 失败（settle 保持 PROCESSING，cron 会按差值补）才真的会重试；终态 FAILED 类防护
          // （节点被删/暂停、已过期、旧版 addDays&addBytes=0…）订单已置 FAILED，cron 从不重试，
          // 承诺「自动重试」永远不会发生，还把后端给的真实原因（d.message，如「请联系客服」）丢掉。
          // 改为直接展示后端原因：PROCESSING 类自带「系统将自动重试」，FAILED 类自带正确指引。
          toast.error(d.message || '支付成功，但续费应用暂时失败，请稍后在「我的节点」查看');
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
      const msg = getErrorMessage(err);
      // 【复核】防重拦截时的「继续支付已有订单」出口：旧网关单 cancel-self 退不掉、
      // 占着未完成名额 → 再下单被防重拦截 → 死胡同。命中该错误时自动捞回已有单
      // 重新出码（或提示正在处理中），不重复建单。
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

  // 续费点「返回」后再次下单撞防重 → 用已有订单继续支付（同上条复核注释）
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
        // PAID/PROCESSING：续费已付款、正在应用，重复支付会白付第二笔
        toast('已有续费正在处理中，请勿重复支付，稍后在「我的节点」查看');
        setMethod('');
        return;
      }
      if (m === 'balance') {
        const payRes = await api.post(`/orders/${existing.id}/pay/balance`, undefined, { timeout: 90000 });
        await refreshUser();
        const d = payRes.data?.data;
        if (d?.activationFailed) {
          // 【对抗复核 F15】不能对一切激活失败都承诺「系统将自动重试」—— 只有 PROCESSING 类
          // 失败（settle 保持 PROCESSING，cron 会按差值补）才真的会重试；终态 FAILED 类防护
          // （节点被删/暂停、已过期、旧版 addDays&addBytes=0…）订单已置 FAILED，cron 从不重试，
          // 承诺「自动重试」永远不会发生，还把后端给的真实原因（d.message，如「请联系客服」）丢掉。
          // 改为直接展示后端原因：PROCESSING 类自带「系统将自动重试」，FAILED 类自带正确指引。
          toast.error(d.message || '支付成功，但续费应用暂时失败，请稍后在「我的节点」查看');
          onClose();
          return;
        }
        toast.success('续费成功，节点已更新并恢复');
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

  if (!node) return null;

  const methods = [
    { id: 'wechat', label: t('purchase.wechat'), icon: '💚' },
    { id: 'alipay', label: t('purchase.alipay'), icon: '💙' },
    { id: 'card', label: t('purchase.cardKey'), icon: <TicketIcon className="h-5 w-5" /> },
    { id: 'balance', label: t('purchase.balance'), icon: <Banknote className="h-5 w-5" /> },
  ];

  // 二维码视图「返回」：尝试取消这张未支付单（否则旧单占着未完成续费单名额，
  // 且后端防重会拦截新一轮下单）。【对抗复核确认】只有取消成功才停表并清空订单状态：
  // 取消失败（带支付方式的单恒被后端拒）时订单仍在等支付，轮询必须继续 —— 否则支付
  // 成功的回调再也没有观察者，toast 却邀请「继续扫码」，用户很可能再下一单（撞防重 /
  // 重复付款），二维码视图却已消失。
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
      // 能取消（未带支付方式的 PENDING 单 / FAILED 单）→ 回套餐选择页，可放心重下
      setOrderId(null);
      setOrderNo('');
      setPayQr(null);
      setMethod('');
    } catch {
      // 【复核：backFromQr】这里能进二维码视图说明订单已带支付方式（出码时后端写入
      // payMethod）；而「PENDING + WECHAT/ALIPAY」的单 cancel-self 恒被后端
      // ConflictException 拒绝（带支付方式的订单只能管理员取消或 48h 超时收敛，
      // 见 order.service cancelSelf）。若此处清空视图，用户回套餐页再下单又会撞防重拦截，
      // 死胡同；且直接停表会让支付成功无人观察。所以：保留二维码视图 + 轮询照走 +
      // 诚实提示，可继续扫这张码付，或关掉弹窗等订单超时自动释放后再续。
      toast.error('该订单已生成支付码，无法自行取消。您可以继续扫码完成支付；或关闭后等待订单超时自动释放，再重新续费（也可联系客服取消）。');
    }
  };
  const statusLabel: Record<string, any> = {
    ACTIVE: <Badge variant="success">活跃</Badge>,
    EXPIRED: <Badge variant="danger">已过期</Badge>,
    SUSPENDED: <Badge variant="warning">已暂停</Badge>,
  };

  const kindTabs: { id: RenewKind; label: string; icon: any; desc: string; enabled: boolean }[] = [
    {
      id: 'EXPIRY',
      label: '到期续费',
      icon: <CalendarClock className="h-4 w-4" />,
      desc: isTimeExpired
        ? '已到期（宽限期内）：周期从原到期日起算，流量恢复为方案满额'
        : '顺延到期日；到期时流量自动恢复为方案满额',
      enabled: canExpiry,
    },
    {
      id: 'TRAFFIC',
      label: '流量续费',
      icon: <Gauge className="h-4 w-4" />,
      desc: '在当前额度上叠加方案流量（不清已用，随周期结束清零）',
      enabled: canTraffic,
    },
  ];
  const showTabs = kindTabs.filter((k) => k.enabled).length > 1;
  const curPlans = kind ? plansFor(kind) : [];
  const activeTab = kindTabs.find((k) => k.id === kind);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>节点续费（到期续费 / 流量续费）</DialogTitle>
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

        {isTimeExpired && (
          <p className="mt-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            该节点已到期，仅保留一天续费宽限期；超过一天未续费将被自动删除，只能重新购买方案。
          </p>
        )}

        {payQr ? (
          // 二维码支付中
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
            {/* 续费类型 Tab：两种都可用才显示 Tab 栏；否则直接显示唯一的类型 */}
            {showTabs ? (
              <div className="grid grid-cols-2 gap-2">
                {kindTabs.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    disabled={!k.enabled}
                    onClick={() => { setKind(k.id); setSelected(null); setMethod(''); setOrderNo(''); setOrderId(null); }}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40',
                      kind === k.id ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent',
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {k.icon}{k.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{k.desc}</span>
                  </button>
                ))}
              </div>
            ) : (
              activeTab && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {activeTab.icon}{activeTab.label}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{activeTab.desc}</div>
                </div>
              )
            )}

            {/* 套餐选择（按当前续费类型过滤） */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {kind === 'EXPIRY'
                  ? isTimeExpired
                    ? '选择到期续费方案（已到期节点：周期从原到期日起算，流量恢复为方案满额）'
                    : '选择到期续费方案（顺延时长；当前流量不变，到期时自动恢复为方案满额）'
                  : kind === 'TRAFFIC'
                    ? '选择流量续费方案（在当前额度上叠加方案流量，不清除已用流量；到期时间不变）'
                    : '选择续费方案'}
              </p>
              {curPlans.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <p>当前没有可{kind === 'EXPIRY' ? '到期续费' : '流量续费'}的方案</p>
                  <p className="mt-1 text-xs">
                    {kind === 'TRAFFIC' ? '（需要含流量额度的方案）' : '（需要含时长、且能使节点回到有效期的方案）'}
                  </p>
                </div>
              )}
              {curPlans.map((p) => {
                const active = selected?.id === p.id;
                const parts: string[] = [];
                if (kind === 'EXPIRY') {
                  if (Number(p.duration) > 0) {
                    parts.push(isTimeExpired ? `从原到期日起算，续期 +${Number(p.duration)} 天` : `顺延 +${Number(p.duration)} 天`);
                  }
                  if (Number(p.traffic) > 0 && Number(node.trafficLimit) > 0) {
                    // 订阅周期制：未到期节点当前流量不变、到期时自动回满新套餐额度；
                    // 已到期节点：周期切换点（原到期日）已过 → 按周期切换语义恢复满额
                    parts.push(
                      isTimeExpired
                        ? `流量按周期切换恢复 ${(Number(p.traffic) / GB).toFixed(0)}GB（满额）`
                        : `当前流量不变，到期自动回满 ${(Number(p.traffic) / GB).toFixed(0)}GB`,
                    );
                  }
                } else if (Number(p.traffic) > 0) {
                  parts.push(`叠加 ${(Number(p.traffic) / GB).toFixed(0)}GB（不清已用）`);
                }
                const nextExpiry = kind === 'EXPIRY' ? nextExpiryOf(p) : null;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setSelected(p); setMethod(''); setPayQr(null); setOrderNo(''); setOrderId(null); }}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      active ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent'
                    }`}
                  >
                    <div>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{parts.join(' · ')}</div>
                      {nextExpiry && (
                        <div className="mt-0.5 text-xs text-primary">
                          续费后到期：{nextExpiry.toLocaleDateString()}
                        </div>
                      )}
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
                    当前余额：<span className="font-semibold text-primary">¥{Number(user?.balance ?? 0)}</span>，选中方案后可直接用余额支付
                  </p>
                )}
              </div>
            )}

            <div className="pt-2 text-xs text-muted-foreground">
              {kind === 'EXPIRY'
                ? isTimeExpired
                  ? '续费周期从原到期日起算（已过切换点的周期立即恢复满额流量）；过期超过一天的节点将被自动删除，请在宽限期内续费'
                  : '续费后到期日顺延，当前流量保持不变；到期时系统自动将流量恢复为方案满额'
                : kind === 'TRAFFIC'
                  ? '流量续费将在当前额度上叠加所选方案流量（不清除已用流量），到期时间不变；叠加流量随本周期结束自动清零'
                  : '续费后节点将自动恢复并重启（面板侧自动生效）'}
            </div>
            <div className="pt-1 text-xs text-muted-foreground">续费订单不支持申请退款（退款仅限购买订单），费用问题请联系客服。</div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}