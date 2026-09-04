'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Users, DollarSign, ShoppingCart, Server, TrendingUp, Activity } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [userStats, setUserStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/orders/stats'),
      api.get('/users/stats'),
      api.get('/system/finance'),
    ]).then(([o, u, f]) => {
      const orderStats = o.status === 'fulfilled' ? o.value.data.data : null;
      const uStats = u.status === 'fulfilled' ? u.value.data.data : null;
      const finance = f.status === 'fulfilled' ? f.value.data.data : null;
      setStats({ orderStats, uStats, finance });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;

  const orderStats = stats?.orderStats;
  const uStats = stats?.uStats;
  const finance = stats?.finance;

  const kpis = [
    { label: '今日收入', value: `¥${orderStats?.today?.revenue || '0'}`, icon: DollarSign, color: 'text-emerald-500' },
    { label: '本月收入', value: `¥${orderStats?.month?.revenue || '0'}`, icon: TrendingUp, color: 'text-blue-500' },
    { label: '总订单', value: orderStats?.total?.orders || 0, icon: ShoppingCart, color: 'text-violet-500' },
    { label: '总用户', value: uStats?.totalUsers || 0, icon: Users, color: 'text-amber-500' },
    { label: '今日新增', value: uStats?.newToday || 0, icon: Activity, color: 'text-rose-500' },
    { label: '待处理订单', value: orderStats?.pending || 0, icon: Server, color: 'text-cyan-500' },
  ];

  // 真实数据：收入趋势 (近30天，来自订单库) 与协议分布 (活跃节点统计)
  const revenueData = (finance?.revenueData || []).map((r: any) => ({
    name: r.date.slice(5), // MM-DD
    revenue: r.revenue,
  }));
  const protocolData = finance?.protocolData || [];

  const COLORS = ['#6366f1', '#8b5cf6', '#22d3ee', '#f59e0b'];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">仪表盘</h1>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs text-muted-foreground">{kpi.label}</p>
                <p className="mt-1 text-xl font-bold">{kpi.value}</p>
              </div>
              <kpi.icon className={`h-6 w-6 ${kpi.color}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>收入趋势 (近30天)</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueData}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip />
                <Area type="monotone" dataKey="revenue" stroke="#6366f1" fill="url(#rev)" name="收入" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>协议分布</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={protocolData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                  {protocolData.map((entry: any, idx: number) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
