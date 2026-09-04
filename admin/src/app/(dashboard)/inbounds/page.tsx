'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Play, Pause, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';

export default function InboundsPage() {
  const [inbounds, setInbounds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchData = (q = '') => {
    setLoading(true);
    api.get('/inbounds', { params: { page: 1, limit: 50, search: q } })
      .then((res) => setInbounds(res.data.data.inbounds))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const act = async (id: number, action: 'suspend' | 'resume') => {
    try {
      await api.post(`/inbounds/${id}/${action}`);
      toast.success(action === 'suspend' ? '已暂停' : '已恢复');
      fetchData(search);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确认删除该节点？')) return;
    try {
      await api.delete(`/inbounds/${id}`);
      toast.success('已删除');
      fetchData(search);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'email', header: '标识', render: (i: any) => <span className="font-mono text-xs">{i.email}</span> },
    { key: 'user', header: '用户', render: (i: any) => i.user?.email || '—' },
    { key: 'server', header: '服务器', render: (i: any) => i.server?.name || '—' },
    { key: 'protocol', header: '协议', render: (i: any) => <span className="uppercase text-xs font-medium">{i.protocol}</span> },
    { key: 'port', header: '端口' },
    {
      key: 'traffic', header: '流量',
      render: (i: any) => `${(Number(i.totalTraffic)/1024/1024/1024).toFixed(1)}GB`,
    },
    { key: 'status', header: '状态', render: (i: any) => <StatusBadge status={i.status} /> },
    {
      key: 'actions', header: '操作',
      render: (i: any) => (
        <div className="flex gap-1">
          {i.status === 'ACTIVE' ? (
            <Button size="sm" variant="outline" onClick={() => act(i.id, 'suspend')}><Pause className="h-3 w-3" /></Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => act(i.id, 'resume')}><Play className="h-3 w-3" /></Button>
          )}
          <Button size="sm" variant="destructive" onClick={() => remove(i.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="节点管理" subtitle={`共 ${inbounds.length} 个节点`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="w-64 pl-10" placeholder="搜索邮箱/备注" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchData(search)} />
          </div>
          <Button variant="outline" onClick={() => fetchData(search)}>搜索</Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={inbounds} keyField="id" emptyMessage="暂无节点" />
        </CardContent>
      </Card>
    </div>
  );
}
