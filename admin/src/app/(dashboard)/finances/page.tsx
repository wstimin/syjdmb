'use client';

import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader, DataTable } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import { DollarSign, TrendingUp, CreditCard, Receipt } from 'lucide-react';
import toast from 'react-hot-toast';

export default function FinancesPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/system/finance'),
      api.get('/orders/stats'),
    ]).then(([f, o]) => {
      const finance = f.status === 'fulfilled' ? f.value.data.data : null;
      const orderStats = o.status === 'fulfilled' ? o.value.data.data : null;
      setData({ finance, orderStats });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const finance = data?.finance;
  const orderStats = data?.orderStats;

  const kpis = [
    { label: '总收入', value: `¥${finance?.totalRevenue || '0'}`, icon: DollarSign, color: 'text-emerald-500' },
    { label: '卡密兑换', value: `¥${finance?.cardRevenue || '0'}`, icon: CreditCard, color: 'text-violet-500' },
    { label: '本月收入', value: `¥${orderStats?.month?.revenue || '0'}`, icon: TrendingUp, color: 'text-blue-500' },
    { label: '订单数', value: orderStats?.total?.orders || 0, icon: Receipt, color: 'text-amber-500' },
  ];

  const txColumns = [
    { key: 'id', header: 'ID' },
    { key: 'user', header: '用户', render: (t: any) => t.user?.email || '—' },
    { key: 'type', header: '类型' },
    { key: 'amount', header: '金额', render: (t: any) => <span className={Number(t.amount) >= 0 ? 'text-emerald-500 font-medium' : 'text-red-500 font-medium'}>{Number(t.amount) >= 0 ? '+' : ''}{Number(t.amount)}</span> },
    { key: 'description', header: '描述' },
    { key: 'createdAt', header: '时间', render: (t: any) => new Date(t.createdAt).toLocaleString() },
  ];

  return (
    <div>
      <PageHeader title="财务统计" subtitle="收入与资金动态" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm text-muted-foreground">{kpi.label}</p>
                <p className="mt-1 text-2xl font-bold">{kpi.value}</p>
              </div>
              <kpi.icon className={`h-7 w-7 ${kpi.color}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近交易记录</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable columns={txColumns} data={finance?.recentTransactions || []} keyField="id" emptyMessage="暂无交易" />
        </CardContent>
      </Card>
    </div>
  );
}
