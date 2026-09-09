'use client';

import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import Pagination from '@/components/shared/pagination';
import { exportToCsv } from '@/lib/csv';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DollarSign, TrendingUp, CreditCard, Receipt, Search, Download, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';

const STATUS_OPTIONS = ['ALL', 'PENDING', 'PAID', 'PROCESSING', 'COMPLETED', 'REFUNDED', 'CANCELLED', 'FAILED'];

export default function FinancesPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [transactions, setTransactions] = useState<any[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

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

  const fetchTransactions = () => {
    setTxLoading(true);
    api.get('/orders', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setTransactions(res.data.data.orders);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setTxLoading(false));
  };

  useEffect(() => { fetchTransactions(); }, [page, limit, status]);

  const resetPage = () => setPage(1);

  const exportTransactions = () => {
    exportToCsv(
      transactions.map((t: any) => ({
        orderNo: t.orderNo,
        user: t.user?.email || '',
        plan: t.virtualProduct?.name || t.plan?.name || '',
        amount: t.amount,
        payMethod: t.payMethod || '',
        status: t.status,
        createdAt: t.createdAt,
      })),
      'finances'
    );
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const finance = data?.finance;
  const orderStats = data?.orderStats;

  const kpis = [
    { label: '总收入', value: `¥${finance?.totalRevenue || '0'}`, icon: DollarSign, color: 'text-emerald-500' },
    { label: '卡密兑换', value: `¥${finance?.cardRevenue || '0'}`, icon: CreditCard, color: 'text-violet-500' },
    { label: '本月收入', value: `¥${orderStats?.month?.revenue || '0'}`, icon: TrendingUp, color: 'text-blue-500' },
    { label: '订单数', value: orderStats?.total?.orders || 0, icon: Receipt, color: 'text-amber-500' },
    // 已退款 = 平台真实的钱款流出（退款净额），让退款作为冲减可见
    { label: '已退款', value: `-¥${finance?.refundedAmount || '0'} / ${finance?.refundedCount || 0} 笔`, icon: Undo2, color: 'text-red-500' },
  ];

  const txColumns = [
    { key: 'orderNo', header: '订单号', render: (t: any) => <span className="font-mono text-xs">{t.orderNo}</span> },
    { key: 'user', header: '用户', render: (t: any) => t.user?.email || '—' },
    { key: 'product', header: '商品', render: (t: any) => t.virtualProduct?.name || t.plan?.name || '—' },
    { key: 'amount', header: '金额', render: (t: any) => t.status === 'REFUNDED' ? (
        // 已退款单显示为红负（钱已退），不再是绿色收入
        <span className="font-medium text-red-500">-¥{Number(t.payAmount ?? t.amount)}</span>
      ) : (
        <span className="font-medium text-emerald-500">+¥{Number(t.payAmount ?? t.amount)}</span>
      ) },
    { key: 'payMethod', header: '支付方式', render: (t: any) => t.payMethod || '—' },
    { key: 'status', header: '状态', render: (t: any) => <StatusBadge status={t.status} /> },
    { key: 'createdAt', header: '时间', render: (t: any) => new Date(t.createdAt).toLocaleString() },
  ];

  return (
    <div>
      <PageHeader title="财务统计" subtitle="收入与资金动态">
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); resetPage(); }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? '全部状态' : s}</option>
            ))}
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索订单号/邮箱"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchTransactions()}
            />
          </div>
          <Button variant="outline" onClick={() => fetchTransactions()}>搜索</Button>
          <Button variant="outline" onClick={exportTransactions}>
            <Download className="mr-1 h-4 w-4" />导出
          </Button>
        </div>
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
          <CardTitle>交易记录</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable columns={txColumns} data={txLoading && transactions.length === 0 ? [] : transactions} keyField="id" emptyMessage={txLoading ? '加载中…' : '暂无交易'} />
          <Pagination
            page={page}
            limit={limit}
            total={total}
            totalPages={totalPages}
            onPageChange={setPage}
            onLimitChange={(l) => { setLimit(l); resetPage(); }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
