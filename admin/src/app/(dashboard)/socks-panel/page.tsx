'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Trash2, Play, Pause, Copy, Plus } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
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

  // ---- 新建节点状态 ----
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [servers, setServers] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({
    userId: null as number | null,
    selectedLabel: '',
    serverId: '',
    durationDays: 30,
  });
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<any[]>([]);
  const [userSearching, setUserSearching] = useState(false);

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

  // ---- 新建节点逻辑 ----

  const openCreate = () => {
    setCreateForm({ userId: null, selectedLabel: '', serverId: '', durationDays: 30 });
    setUserQuery('');
    setUserResults([]);
    setCreateOpen(true);
    api.get('/servers')
      .then((res) => setServers(res.data.data || []))
      .catch(() => setServers([]));
  };

  const searchUser = () => {
    if (!userQuery.trim()) { setUserResults([]); return; }
    setUserSearching(true);
    api.get('/users', { params: { search: userQuery.trim(), limit: 8 } })
      .then((res) => setUserResults(res.data.data.users || []))
      .catch(() => setUserResults([]))
      .finally(() => setUserSearching(false));
  };

  const submitCreate = async () => {
    if (!createForm.userId) { toast.error('请先选择用户'); return; }
    if (!createForm.serverId) { toast.error('请选择服务器'); return; }
    if (!createForm.durationDays || createForm.durationDays <= 0) { toast.error('时长必须大于 0'); return; }
    setCreateBusy(true);
    try {
      await api.post('/socks-panel/admin', {
        userId: createForm.userId,
        durationDays: createForm.durationDays,
        serverId: Number(createForm.serverId) || undefined,
      });
      toast.success('节点创建成功，已绑定给用户');
      setCreateOpen(false);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreateBusy(false);
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
      key: 'product', header: '商品/来源',
      render: (n: any) => (
        <div className="min-w-0">
          <div className="max-w-[160px] truncate">{n.virtualProduct?.name || '—'}</div>
          {n.remark && <div className="max-w-[160px] truncate text-xs text-muted-foreground">{n.remark}</div>}
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
      <PageHeader title="SOCKS 面板" subtitle={`面板自动交付的 SOCKS 节点（消费者商城虚拟商品 + 管理员手动赠送），共 ${total} 个`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索 用户名 / 备注 / 订单号 / 邮箱"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />新建节点
          </Button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard title="节点总数" value={total} />
        <StatCard title="正常在用（ACTIVE）" value={nodes.filter((n) => n.status === 'ACTIVE').length} color="rgb(5 150 105)" />
        <StatCard title="本页已到期（EXPIRED）" value={nodes.filter((n) => n.status === 'EXPIRED').length} color="rgb(100 116 139)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={nodes} keyField="id" emptyMessage="暂无 SOCKS 面板节点（用户在商城购买 SOCKS_PANEL 商品后自动生成；也可点「新建节点」手动赠送）" />
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

      {/* ---- 新建节点 Dialog ---- */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) setCreateOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建 SOCKS 节点</DialogTitle>
            <DialogDescription>直接为用户创建 SOCKS 节点（试用/赠送），不产生订单、不占商品库存。</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* 用户选择 */}
            <div className="space-y-2">
              <Label>目标用户</Label>
              {createForm.userId ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{createForm.selectedLabel}</span>
                  <button type="button" className="text-xs text-muted-foreground underline"
                    onClick={() => setCreateForm((f) => ({ ...f, userId: null, selectedLabel: '' }))}>
                    更换
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={userQuery}
                      onChange={(e) => setUserQuery(e.target.value)}
                      placeholder="输入邮箱搜索用户"
                      onKeyDown={(e) => e.key === 'Enter' && searchUser()}
                    />
                    <Button type="button" size="sm" variant="outline" onClick={searchUser} disabled={userSearching}>
                      {userSearching ? '搜索中…' : '搜索'}
                    </Button>
                  </div>
                  {userResults.length > 0 && (
                    <div className="max-h-44 overflow-auto rounded-md border">
                      {userResults.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted"
                          onClick={() => setCreateForm((f) => ({
                            ...f,
                            userId: u.id,
                            selectedLabel: `${u.email}${u.username ? ` (${u.username})` : ''}`,
                          }))}
                        >
                          <span>{u.email}</span>
                          <span className="text-xs text-muted-foreground">#{u.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 服务器选择 */}
            <div className="space-y-2">
              <Label>服务器</Label>
              <select
                value={createForm.serverId}
                onChange={(e) => setCreateForm((f) => ({ ...f, serverId: e.target.value }))}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">自动选择（权重随机）</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}（{s.host}）</option>
                ))}
              </select>
            </div>

            {/* 时长 */}
            <div className="space-y-2">
              <Label>时长（天）</Label>
              <Input
                type="number"
                min={1}
                value={createForm.durationDays}
                onChange={(e) => setCreateForm((f) => ({ ...f, durationDays: Number(e.target.value) || 0 }))}
              />
            </div>

            <Button className="w-full" onClick={submitCreate} disabled={createBusy}>
              {createBusy ? '创建中…（正在建立面板连接）' : '确认创建并绑定'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
