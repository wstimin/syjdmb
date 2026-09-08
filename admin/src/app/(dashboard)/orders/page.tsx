'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Search, CheckCircle2, XCircle, Download } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import Pagination from '@/components/shared/pagination';
import { exportToCsv } from '@/lib/csv';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_OPTIONS = ['ALL', 'PENDING', 'PAID', 'PROCESSING', 'COMPLETED', 'REFUNDED', 'CANCELLED', 'FAILED'];

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const fetchOrders = () => {
    setLoading(true);
    api.get('/orders', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setOrders(res.data.data.orders);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, [page, limit, status]);

  const activate = async (id: number) => {
    if (!confirm('确认手动开通该订单（会创建节点）？')) return;
    try {
      const res = await api.post(`/orders/${id}/admin-activate`);
      toast.success('订单已开通，节点已创建');
      fetchOrders();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const cancelOrder = async (id: number) => {
    if (!confirm('确认取消该订单？')) return;
    try {
      await api.post(`/orders/${id}/cancel`);
      toast.success('订单已取消');
      fetchOrders();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const resetPage = () => setPage(1);

  const exportOrders = () => {
    exportToCsv(
      orders.map((o) => ({
        orderNo: o.orderNo,
        user: o.user?.email || '',
        plan: o.plan?.name || '',
        amount: o.amount,
        payAmount: o.payAmount ?? o.amount,
        coupon: o.coupon?.code || '',
        payMethod: o.payMethod || '',
        status: o.status,
        createdAt: o.createdAt,
      })),
      'orders'
    );
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'orderNo', header: '订单号', render: (o: any) => <span className="font-mono text-xs">{o.orderNo}</span> },
    { key: 'user', header: '用户', render: (o: any) => o.user?.email || '—' },
    { key: 'plan', header: '套餐', render: (o: any) => (
        <div>
          <div>{o.plan?.name || '—'}</div>
          {o.renewalOfInbound && (
            <span className="mt-0.5 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500">
              续费 · {o.renewalOfInbound.server?.name || o.renewalOfInbound.remark || '节点'}
            </span>
          )}
          {o.coupon && (
            <span className="mt-0.5 inline-block rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-500">
              优惠券 {o.coupon.code}
            </span>
          )}
        </div>
      ) },
    { key: 'amount', header: '金额', render: (o: any) => (
        o.status === 'REFUNDED' ? (
          // 已退款 = 钱已退，金额列显示红负（不再是绿色收入）
          <span className="font-medium text-red-500">-¥{Number(o.payAmount ?? o.amount)}</span>
        ) : (
          <span className="text-primary font-medium">
            {Number(o.payAmount ?? o.amount) < Number(o.amount) ? (
              <>
                ¥{Number(o.payAmount ?? o.amount)}
                <span className="ml-1 text-xs text-muted-foreground line-through">¥{Number(o.amount)}</span>
              </>
            ) : (
              `¥${Number(o.amount)}`
            )}
          </span>
        )
      ) },
    { key: 'payMethod', header: '支付方式', render: (o: any) => o.payMethod || '—' },
    { key: 'status', header: '状态', render: (o: any) => <StatusBadge status={o.status} /> },
    { key: 'createdAt', header: '下单时间', render: (o: any) => new Date(o.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (o: any) => (
        <div className="flex items-center gap-2">
          {(o.status === 'PENDING' || o.status === 'PAID') && (
            <Button size="sm" onClick={() => activate(o.id)}>
              <CheckCircle2 className="mr-1 h-3 w-3" />手动开通
            </Button>
          )}
          {(o.status === 'PENDING' || o.status === 'FAILED') && (
            <Button size="sm" variant="outline" onClick={() => cancelOrder(o.id)}>
              <XCircle className="mr-1 h-3 w-3" />取消
            </Button>
          )}
          {o.status === 'REFUNDED' && (
            <Link href="/refunds" className="text-xs font-medium text-primary hover:underline">
              退款记录
            </Link>
          )}
          {(o.status !== 'PENDING' && o.status !== 'PAID' && o.status !== 'FAILED' && o.status !== 'REFUNDED') && (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="订单管理" subtitle={`共 ${total} 笔订单`}>
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
              onKeyDown={(e) => e.key === 'Enter' && fetchOrders()}
            />
          </div>
          <Button variant="outline" onClick={() => fetchOrders()}>搜索</Button>
          <Button variant="outline" onClick={exportOrders}>
            <Download className="mr-1 h-4 w-4" />导出
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={orders} keyField="id" emptyMessage="暂无订单" />
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
