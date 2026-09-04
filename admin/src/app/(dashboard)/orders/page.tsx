'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, CheckCircle2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchOrders = (q = '') => {
    setLoading(true);
    api.get('/orders', { params: { page: 1, limit: 50, search: q } })
      .then((res) => setOrders(res.data.data.orders))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, []);

  const activate = async (id: number) => {
    if (!confirm('确认手动开通该订单（会创建节点）？')) return;
    try {
      const res = await api.post(`/orders/${id}/admin-activate`);
      toast.success('订单已开通，节点已创建');
      fetchOrders(search);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'orderNo', header: '订单号', render: (o: any) => <span className="font-mono text-xs">{o.orderNo}</span> },
    { key: 'user', header: '用户', render: (o: any) => o.user?.email || '—' },
    { key: 'plan', header: '套餐', render: (o: any) => o.plan?.name || '—' },
    { key: 'amount', header: '金额', render: (o: any) => <span className="text-primary font-medium">¥{Number(o.amount)}</span> },
    { key: 'payMethod', header: '支付方式', render: (o: any) => o.payMethod || '—' },
    { key: 'status', header: '状态', render: (o: any) => <StatusBadge status={o.status} /> },
    { key: 'createdAt', header: '下单时间', render: (o: any) => new Date(o.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (o: any) => (
        (o.status === 'PENDING' || o.status === 'PAID') ? (
          <Button size="sm" onClick={() => activate(o.id)}>
            <CheckCircle2 className="mr-1 h-3 w-3" />手动开通
          </Button>
        ) : <span className="text-muted-foreground text-xs">—</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="订单管理" subtitle={`共 ${orders.length} 笔订单`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索订单号/邮箱"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchOrders(search)}
            />
          </div>
          <Button variant="outline" onClick={() => fetchOrders(search)}>搜索</Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={orders} keyField="id" emptyMessage="暂无订单" />
        </CardContent>
      </Card>
    </div>
  );
}
