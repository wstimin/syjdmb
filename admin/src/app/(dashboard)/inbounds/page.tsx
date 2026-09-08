'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Play, Pause, Trash2, Download } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { StatCard } from '@/components/shared/stat-card';
import { exportToCsv } from '@/lib/csv';

export default function InboundsPage() {
  const [inbounds, setInbounds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any>(null);

  const fetchData = (q = search, p = page, l = limit) => {
    setLoading(true);
    api.get('/inbounds', { params: { page: p, limit: l, search: q } })
      .then((res) => {
        setInbounds(res.data.data.inbounds);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api.get('/inbounds/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchData(); }, []);

  // 状态过滤在客户端做（后端 findAll 只支持 page/limit/search）
  const filtered = status === 'ALL' ? inbounds : inbounds.filter((i: any) => i.status === status);

  const act = async (id: number, action: 'suspend' | 'resume') => {
    try {
      await api.post(`/inbounds/${id}/${action}`);
      toast.success(action === 'suspend' ? '已暂停' : '已恢复');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确认删除该节点？')) return;
    try {
      await api.delete(`/inbounds/${id}`);
      toast.success('已删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const exportCsv = () => {
    exportToCsv(
      filtered.map((i: any) => ({
        id: i.id, email: i.email, user: i.user?.email || '', server: i.server?.name || '',
        protocol: i.protocol, port: i.port, status: i.status, totalTraffic: i.totalTraffic,
      })),
      'inbounds',
    );
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
      <PageHeader title="节点管理" subtitle={`共 ${total} 个节点`}>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="ALL">全部状态</option>
            <option value="ACTIVE">活跃</option>
            <option value="EXPIRED">已到期</option>
            <option value="SUSPENDED">已暂停</option>
          </select>
          <Button variant="outline" onClick={exportCsv}><Download className="mr-1 h-4 w-4" />导出</Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="w-64 pl-10" placeholder="搜索邮箱/备注" value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              onKeyDown={(e) => e.key === 'Enter' && fetchData(search, 1, limit)} />
          </div>
          <Button variant="outline" onClick={() => fetchData(search, 1, limit)}>搜索</Button>
        </div>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard title="节点总数" value={stats ? stats.total : '-'} />
        <StatCard title="活跃节点" value={stats ? stats.active : '-'} color="#22c55e" />
        <StatCard
          title="总流量"
          value={stats ? `${(Number(stats.totalTraffic)/1024/1024/1024).toFixed(2)}GB` : '-'}
          color="#3b82f6"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={filtered} keyField="id" emptyMessage="暂无节点" />
        </CardContent>
        <Pagination
          page={page}
          limit={limit}
          total={total}
          totalPages={totalPages}
          onPageChange={(p) => { setPage(p); fetchData(search, p, limit); }}
          onLimitChange={(l) => { setLimit(l); setPage(1); fetchData(search, 1, l); }}
        />
      </Card>
    </div>
  );
}
