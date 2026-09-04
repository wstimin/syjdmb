'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Trash2, Play, Pause } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';

export default function SocksAdminPage() {
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = () => {
    api.get('/socks')
      .then((res) => setProxies(res.data.data.proxies))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const toggleStatus = async (id: number, current: string) => {
    const status = current === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await api.post(`/socks/${id}/status`, { status });
      toast.success('状态已更新');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确认删除？')) return;
    try {
      await api.delete(`/socks/${id}`);
      toast.success('已删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'user', header: '用户', render: (p: any) => p.user?.email || '—' },
    { key: 'host', header: '地址', render: (p: any) => <span className="font-mono text-xs">{p.host}:{p.port}</span> },
    { key: 'username', header: '用户名', render: (p: any) => p.username || '—' },
    { key: 'server', header: '来源', render: (p: any) => p.server?.name || '用户自填' },
    { key: 'status', header: '状态', render: (p: any) => <StatusBadge status={p.status} /> },
    { key: 'createdAt', header: '创建时间', render: (p: any) => new Date(p.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (p: any) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => toggleStatus(p.id, p.status)}>
            {p.status === 'ACTIVE' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => remove(p.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="SOCKS 中转管理" subtitle={`共 ${proxies.length} 个SOCKS中转`} />
      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={proxies} keyField="id" emptyMessage="暂无SOCKS中转" />
        </CardContent>
      </Card>
    </div>
  );
}
