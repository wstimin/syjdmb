'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Trash2, Play, Pause, Copy } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { StatCard } from '@/components/shared/stat-card';

// SOCKS_PANEL 面板交付节点的后台管理：
// 用户付款后由 XUI 面板自动建 socks 入站（时长制、不限流量），存本地 SocksNode 台账。
// 操作与节点(Inbound)管理同语义：停用=SUSPENDED（面板 disable） / 恢复=ACTIVE / 删除=DELETED（面板删入站）。

export default function SocksPanelAdminPage() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const fetchData = () => {
    setLoading(true);
    api.get('/socks-panel/admin', {
      params: { page, limit, search: search || undefined },
    })
      .then((res) => {
        setNodes(res.data.data.socksNodes || []);
        setTotal(res.data.data.total || 0);
        setTotalPages(res.data.data.totalPages || 1);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, [page, limit, search]);

  const resetPage = () => setPage(1);

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('已复制'),
      () => toast.error('复制失败'),
    );
  };

  const disable = async (id: number) => {
    try {
      await api.post(`/socks-panel/admin/${id}/disable`);
      toast.success('已暂停（面板入站已停用）');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const resume = async (id: number) => {
    try {
      await api.post(`/socks-panel/admin/${id}/resume`);
      toast.success('已恢复（面板入站已启用）');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (n: any) => {
    if (!confirm(`确认彻底删除该 SOCKS 节点？面板入站会被删除，用户将无法再连接；已过到期宽限期的删除属正常清理。`)) return;
    try {
      await api.delete(`/socks-panel/admin/${n.id}`);
      toast.success('已彻底删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading && nodes.length === 0) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const fmtExpiry = (n: any) => {
    if (!n.expiryTime) return '—';
    const d = new Date(n.expiryTime);
    const expired = d.getTime() <= Date.now() && n.status === 'ACTIVE';
    return (
      <span className={expired ? 'font-medium text-amber-600' : ''}>
        {d.toLocaleString()}
      </span>
    );
  };

  const columns = [
    { key: 'id', header: 'ID' },
    {
      key: 'user', header: '用户',
      render: (n: any) => (
        <div className="min-w-0">
          <div className="max-w-[180px] truncate font-medium">{n.user?.email || `#${n.userId}`}</div>
          {n.user?.username && <div className="max-w-[180px] truncate text-xs text-muted-foreground">{n.user.username}</div>}
        </div>
      ),
    },
    {
      key: 'server', header: '服务器',
      render: (n: any) => n.server?.name || `#${n.serverId}`,
    },
    {
      key: 'port', header: '端口',
      render: (n: any) => <span className="font-mono text-xs">{n.port}</span>,
    },
    {
      key: 'product', header: '商品',
      render: (n: any) => (
        <div className="min-w-0">
          <div className="max-w-[160px] truncate">{n.virtualProduct?.name || '—'}</div>
          {n.remark && n.remark !== n.orderNo && (
            <div className="max-w-[160px] truncate text-xs text-muted-foreground">{n.remark}</div>
          )}
        </div>
      ),
    },
    { key: 'expiryTime', header: '到期时间', render: fmtExpiry },
    { key: 'status', header: '状态', render: (n: any) => <StatusBadge status={n.status} /> },
    {
      key: 'actions', header: '操作',
      render: (n: any) => (
        <div className="flex gap-1">
          {n.status === 'ACTIVE' && (
            <Button size="sm" variant="outline" title="暂停（到期前停用，恢复后可继续用）" onClick={() => disable(n.id)}><Pause className="h-3 w-3" /></Button>
          )}
          {(n.status === 'SUSPENDED' || n.status === 'EXPIRED') && (
            <Button size="sm" variant="outline" title="恢复启用" onClick={() => resume(n.id)}><Play className="h-3 w-3" /></Button>
          )}
          {n.connectionUrl && (
            <Button size="sm" variant="ghost" title="复制连接串" onClick={() => copyText(n.connectionUrl)}><Copy className="h-3 w-3" /></Button>
          )}
          <Button size="sm" variant="destructive" title="彻底删除" onClick={() => remove(n)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="SOCKS 面板" subtitle={`面板自动交付的 SOCKS 节点（消费者商城虚拟商品），共 ${total} 个`}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-64 pl-10"
            placeholder="搜索 用户名 / 备注 / 订单号 / 邮箱"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard title="节点总数" value={total} />
        <StatCard title="正常在用（ACTIVE）" value={nodes.filter((n) => n.status === 'ACTIVE').length} color="rgb(5 150 105)" />
        <StatCard title="本页已到期（EXPIRED）" value={nodes.filter((n) => n.status === 'EXPIRED').length} color="rgb(100 116 139)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={nodes} keyField="id" emptyMessage="暂无 SOCKS 面板节点（用户在商城购买 SOCKS_PANEL 商品后自动生成）" />
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