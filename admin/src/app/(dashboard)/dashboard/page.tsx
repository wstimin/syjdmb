'use client';

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import {
  Users, DollarSign, ShoppingCart, Server, TrendingUp, Activity, Clock,
  Wallet, UserPlus, Wifi, CreditCard, Tag, Globe, CheckCircle2, XCircle,
  RefreshCw,
} from 'lucide-react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/data-table';
import { APP_VERSION } from '@/lib/version';

const money = (n: any) =>
  `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tint,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: any;
  tint: string; // tailwind gradient classes
}) {
  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-lg">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1.5 truncate text-2xl font-bold tracking-tight">{value}</p>
            {sub && <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${tint} text-white shadow-sm`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setRefreshing(true);
    const results = await Promise.allSettled([
      api.get('/orders/stats'),
      api.get('/users/stats'),
      api.get('/system/finance'),
      api.get('/plan/stats'),
      api.get('/inbounds/stats'),
      api.get('/cards/stats'),
      api.get('/coupons/stats'),
      api.get('/system/settings?group=payment'),
    ]);
    const [o, u, f, p, i, c, cu, pay] = results;
    setStats({
      orderStats: o.status === 'fulfilled' ? o.value.data.data : null,
      uStats: u.status === 'fulfilled' ? u.value.data.data : null,
      finance: f.status === 'fulfilled' ? f.value.data.data : null,
      planStats: p.status === 'fulfilled' ? p.value.data.data : null,
      inboundStats: i.status === 'fulfilled' ? i.value.data.data : null,
      cardStats: c.status === 'fulfilled' ? c.value.data.data : null,
      couponStats: cu.status === 'fulfilled' ? cu.value.data.data : null,
      payConfig: pay.status === 'fulfilled' ? pay.value.data.data : null,
    });
    setUpdatedAt(new Date());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchAll().catch(() => {
      toast.error('数据加载失败');
      setLoading(false);
      setRefreshing(false);
    });
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  const s = stats || {};
  const orderStats = s.orderStats || {};
  const uStats = s.uStats || {};
  const finance = s.finance || {};
  const planStats = s.planStats || {};
  const inboundStats = s.inboundStats || {};
  const cardStats = s.cardStats || {};
  const couponStats = s.couponStats || {};
  const payConfig = s.payConfig || {};

  // 真实数据：收入趋势（近30天）与协议分布（活跃节点）
  const revenueData = (finance.revenueData || []).map((r: any) => ({
    name: String(r.date).slice(5), // MM-DD
    revenue: r.revenue,
  }));
  const protocolData = finance.protocolData || [];
  const recentOrders = (finance.recentTransactions || []).slice(0, 8);

  const wechatOk = payConfig.wechatEnabled === true || payConfig.wechatEnabled === 'true';
  const alipayOk = payConfig.alipayEnabled === true || payConfig.alipayEnabled === 'true';
  const payItems = [
    { name: '微信支付', ok: wechatOk },
    { name: '支付宝', ok: alipayOk },
    { name: '卡密兑换', ok: true },
    { name: '余额支付', ok: true },
  ];

  const COLORS = ['#6366f1', '#8b5cf6', '#22d3ee', '#f59e0b', '#10b981', '#f43f5e'];

  const kpis = [
    {
      label: '今日收入',
      value: money(orderStats.today?.revenue),
      sub: `今日售出 ${orderStats.today?.orders || 0} 单`,
      icon: DollarSign,
      tint: 'from-emerald-500 to-teal-400',
    },
    {
      label: '本月收入',
      value: money(orderStats.month?.revenue),
      sub: `本月售出 ${orderStats.month?.orders || 0} 单`,
      icon: TrendingUp,
      tint: 'from-blue-500 to-indigo-400',
    },
    {
      label: '累计成交',
      value: money(finance.totalRevenue ?? (orderStats.total?.revenue || 0)),
      sub: `累计订单 ${finance.totalOrders ?? (orderStats.total?.orders || 0)} 单`,
      icon: Wallet,
      tint: 'from-violet-500 to-purple-400',
    },
    {
      label: '待处理订单',
      value: String(orderStats.pending || 0),
      sub: orderStats.pending ? '提示：存在待支付订单' : '暂无待支付',
      icon: Clock,
      tint: 'from-amber-500 to-orange-400',
    },
    {
      label: '总用户',
      value: String(uStats.totalUsers || 0),
      sub: `活跃 ${uStats.activeUsers || 0} · 累计注册`,
      icon: Users,
      tint: 'from-cyan-500 to-sky-400',
    },
    {
      label: '今日新增',
      value: String(uStats.newToday || 0),
      sub: `本月新增 ${uStats.newThisMonth || 0} 人`,
      icon: UserPlus,
      tint: 'from-rose-500 to-pink-400',
    },
  ];

  return (
    <div className="space-y-6">
      {/* 顶部：标题 + 版本 + 更新时间 + 刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">仪表盘</h1>
            <span className="rounded-full border bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground">
              v{APP_VERSION}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            核心经营数据一览 · 上次更新 {updatedAt ? format(updatedAt, 'HH:mm:ss') : '—'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchAll({ silent: true }).catch(() => toast.error('刷新失败'))} disabled={refreshing}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? '刷新中...' : '刷新数据'}
        </Button>
      </div>

      {/* KPI 卡片 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      {/* 图表区 */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>收入趋势</CardTitle>
            <CardDescription>近 30 天实付金额（优惠后口径）</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {revenueData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无收入数据</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenueData}>
                  <defs>
                    <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} width={52} />
                  <Tooltip formatter={(v: any) => [money(v), '收入']} />
                  <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2} fill="url(#rev)" name="收入" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>协议分布</CardTitle>
            <CardDescription>活跃节点按协议统计</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {protocolData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无活跃节点</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height="72%">
                  <PieChart>
                    <Pie data={protocolData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={78} paddingAngle={3}>
                      {protocolData.map((_: any, idx: number) => (
                        <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1">
                  {protocolData.map((p: any, idx: number) => (
                    <div key={idx} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[idx % COLORS.length] }} />
                      {p.name} · {p.value}
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 订单与资源状态 */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>近期订单</CardTitle>
            <CardDescription>最近 8 笔成交（已剔除已取消/已退款）</CardDescription>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无订单</div>
            ) : (
              <div className="divide-y">
                {recentOrders.map((o: any) => (
                  <div key={o.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{o.orderNo}</span>
                        <StatusBadge status={o.status} />
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {o.user?.email || o.user?.username || `用户 #${o.userId}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold">{money(o.payAmount ?? o.amount)}</div>
                      <div className="text-xs text-muted-foreground">
                        {o.createdAt ? format(new Date(o.createdAt), 'MM-dd HH:mm', { locale: zhCN }) : '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* 资源状态 */}
          <Card>
            <CardHeader>
              <CardTitle>资源状态</CardTitle>
              <CardDescription>产品 / 节点 / 卡密 / 优惠券</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Globe className="h-3.5 w-3.5" />网络产品</div>
                <div className="mt-1 text-lg font-bold">{planStats.activePlans || 0}<span className="text-xs font-normal text-muted-foreground"> 在售</span></div>
                <div className="text-xs text-amber-600">{planStats.soldOutPlans ? `售罄 ${planStats.soldOutPlans} 个` : '无售罄'}</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Wifi className="h-3.5 w-3.5" />活跃节点</div>
                <div className="mt-1 text-lg font-bold">{inboundStats.active || 0}<span className="text-xs font-normal text-muted-foreground"> / 共 {inboundStats.total || 0}</span></div>
                <div className="text-xs text-muted-foreground">累计流量 {(Number(inboundStats.totalTraffic || 0) / 1024 / 1024 / 1024).toFixed(1)} GB</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><CreditCard className="h-3.5 w-3.5" />卡密</div>
                <div className="mt-1 text-lg font-bold">{cardStats.unused || 0}<span className="text-xs font-normal text-muted-foreground"> 未用</span></div>
                <div className="text-xs text-muted-foreground">已兑出 {money(cardStats.redeemedValue)}</div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Tag className="h-3.5 w-3.5" />优惠券</div>
                <div className="mt-1 text-lg font-bold">{couponStats.active || 0}<span className="text-xs font-normal text-muted-foreground"> 启用</span></div>
                <div className="text-xs text-muted-foreground">累计核销 {couponStats.totalUsed || 0} 次</div>
              </div>
            </CardContent>
          </Card>

          {/* 收款通道 */}
          <Card>
            <CardHeader>
              <CardTitle>收款通道</CardTitle>
              <CardDescription>支付/充值渠道可用性</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {payItems.map((p) => (
                <div key={p.name} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <span className="text-sm">{p.name}</span>
                  {p.ok ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" />可用
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium text-red-500">
                      <XCircle className="h-4 w-4" />未配置
                    </span>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}