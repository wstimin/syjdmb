'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Trash2, Play, Pause, Search, Download } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { StatCard } from '@/components/shared/stat-card';
import { exportToCsv } from '@/lib/csv';

export default function SocksAdminPage() {
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any | null>(null);

  const fetchData = () => {
    setLoading(true);
    api.get('/socks', {
      params: {
        page,
        limit,
        search: search || undefined,
      },
    })
      .then((res) => {
        setProxies(res.data.data.proxies);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/socks/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => { /* 统计接口失败时静默，保留当前显示 */ });
  };

  useEffect(() => { fetchData(); }, [page, limit, search]);

  useEffect(() => { fetchStats(); }, []);

  const resetPage = () => setPage(1);

  const exportSocks = () => {
    exportToCsv(
      proxies.map((p) => ({
        id: p.id,
        user: p.user?.email || '',
        host: p.host,
        port: p.port,
        username: p.username || '',
        status: p.status,
        createdAt: p.createdAt,
      })),
      'socks'
    );
  };

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
      <PageHeader title="SOCKS 中转管理" subtitle={`共 ${total} 个SOCKS中转`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索地址 / 用户邮箱"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <Button variant="outline" onClick={exportSocks}>
            <Download className="mr-1 h-4 w-4" />导出
          </Button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard title="总SOCKS" value={stats?.total ?? total} />
        <StatCard title="启用" value={stats?.total ? stats.active : 0} color="rgb(5 150 105)" />
        <StatCard title="停用" value={stats?.total ? stats.inactive : 0} color="rgb(100 116 139)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={proxies} keyField="id" emptyMessage="暂无SOCKS中转" />
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
