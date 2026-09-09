'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Trash2, Play, Pause, Search, Download, Plus, Users, Link2, Pencil } from 'lucide-react';
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
import { exportToCsv } from '@/lib/csv';

// ---------- 用户选择器（归属/授权共用）：按邮箱搜索，点选回填 ----------
function UserPicker({
  selectedId, selectedLabel, onPick,
  label,
}: {
  selectedId: number | null;
  selectedLabel: string;
  onPick: (user: any) => void;
  label: string;
  grantIds?: number[];
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const search = () => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    api.get('/users', { params: { search: q.trim(), limit: 8 } })
      .then((res) => setResults(res.data.data.users || []))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {selectedId ? (
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span className="truncate">{selectedLabel}</span>
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onPick(null)}>更换</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入邮箱搜索用户" onKeyDown={(e) => e.key === 'Enter' && search()} />
          <Button type="button" size="sm" variant="outline" onClick={search} disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </Button>
        </div>
      )}
      {!selectedId && results.length > 0 && (
        <div className="max-h-44 overflow-auto rounded-md border">
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted"
              onClick={() => onPick(u)}
            >
              <span>{u.email}</span>
              <span className="text-xs text-muted-foreground">#{u.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 授权用户多选 ----------
function GrantPicker({
  ids, labels, onAdd, onRemove,
}: {
  ids: number[];
  labels: Record<number, string>;
  onAdd: (u: any) => void;
  onRemove: (id: number) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const search = () => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    api.get('/users', { params: { search: q.trim(), limit: 8 } })
      .then((res) => setResults((res.data.data.users || []).filter((u: any) => !ids.includes(u.id))))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  return (
    <div className="space-y-2">
      <Label>额外授权用户（可选，可多选）</Label>
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs">
              {labels[id] || `#${id}`}
              <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => onRemove(id)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入邮箱搜索要授权的用户" onKeyDown={(e) => e.key === 'Enter' && search()} />
        <Button type="button" size="sm" variant="outline" onClick={search} disabled={searching}>
          {searching ? '…' : '搜索'}
        </Button>
      </div>
      {results.length > 0 && (
        <div className="max-h-44 overflow-auto rounded-md border">
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted"
              onClick={() => { onAdd(u); setQ(''); setResults([]); }}
            >
              <span>{u.email}</span>
              <span className="text-xs text-muted-foreground">#{u.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SocksAdminPage() {
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any | null>(null);

  // 新建 / 编辑
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({
    host: '', port: '', username: '', password: '', remark: '',
    ownerId: null as number | null, ownerLabel: '',
    grantIds: [] as number[], grantLabels: {} as Record<number, string>,
  });

  // 授权管理
  const [grantTarget, setGrantTarget] = useState<any | null>(null);
  const [grants, setGrants] = useState<any[]>([]);
  const [grantBusy, setGrantBusy] = useState(false);
  const [addGrantUser, setAddGrantUser] = useState<any | null>(null);
  const [grantAddQ, setGrantAddQ] = useState('');
  const [grantAddResults, setGrantAddResults] = useState<any[]>([]);

  // 绑定节点
  const [bindTarget, setBindTarget] = useState<any | null>(null);
  const [bindNodes, setBindNodes] = useState<any[]>([]);
  const [bindBusy, setBindBusy] = useState(false);

  const fetchData = () => {
    setLoading(true);
    api.get('/socks', {
      params: { page, limit, search: search || undefined },
    })
      .then((res) => { setProxies(res.data.data.proxies); setTotal(res.data.data.total); setTotalPages(res.data.data.totalPages); })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/socks/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => {});
  };

  useEffect(() => { fetchData(); }, [page, limit, search]);
  useEffect(() => { fetchStats(); }, []);

  const resetPage = () => setPage(1);

  const exportSocks = () => {
    exportToCsv(
      proxies.map((p) => ({
        id: p.id,
        owner: p.user?.email || '',
        host: p.host,
        port: p.port,
        username: p.username || '',
        grants: p._count?.grants ?? 0,
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
    if (!confirm('确认彻底删除？该 SOCKS 会被物理删除且不可恢复（已绑定节点不受影响）。')) return;
    try {
      await api.delete(`/socks/admin/${id}`);
      toast.success('已彻底删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // ---- 新建/编辑提交 ----
  const openCreate = () => {
    setEditing(null);
    setForm({ host: '', port: '', username: '', password: '', remark: '', ownerId: null, ownerLabel: '', grantIds: [], grantLabels: {} });
    setFormOpen(true);
  };

  const openEdit = (p: any) => {
    setEditing(p);
    setForm({
      host: p.host, port: String(p.port), username: p.username || '', password: p.password || '', remark: p.remark || '',
      ownerId: p.user?.id ?? null, ownerLabel: p.user?.email || '',
      grantIds: [], grantLabels: {},
    });
    setFormOpen(true);
  };

  const submitForm = async () => {
    const port = Number(form.port);
    if (!form.host.trim()) { toast.error('请填写 SOCKS 地址'); return; }
    if (!(port > 0)) { toast.error('请填写正确的端口'); return; }
    if (!form.ownerId) { toast.error('请先选择归属用户（绑定给用户）'); return; }

    const payload = {
      host: form.host.trim(), port,
      username: form.username || undefined,
      password: form.password || undefined,
      remark: form.remark || undefined,
    };
    try {
      if (editing) {
        await api.put(`/socks/admin/${editing.id}`, { ...payload, ownerUserId: form.ownerId });
        toast.success('已保存');
      } else {
        // 新建：归属 + 可选授权一次提交（后端会剔除归属重复项并去重）
        const grantIds = form.grantIds.filter((id) => id !== form.ownerId);
        await api.post('/socks/admin', { ...payload, ownerUserId: form.ownerId, grantUserIds: grantIds.length ? grantIds : undefined });
        toast.success('已创建并绑定归属用户');
      }
      setFormOpen(false);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // ---- 授权管理 ----
  const openGrants = async (p: any) => {
    setGrantTarget(p);
    setAddGrantUser(null); setGrantAddQ(''); setGrantAddResults([]);
    try {
      const res = await api.get(`/socks/${p.id}/grants`);
      setGrants(res.data.data);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const searchGrantUser = () => {
    if (!grantAddQ.trim()) { setGrantAddResults([]); return; }
    api.get('/users', { params: { search: grantAddQ.trim(), limit: 8 } })
      .then((res) => {
        const own = grantTarget?.user?.email;
        setGrantAddResults((res.data.data.users || []).filter((u: any) => u.email !== own));
      })
      .catch(() => setGrantAddResults([]));
  };

  const doAddGrant = async (u: any) => {
    if (!grantTarget) return;
    setGrantBusy(true);
    try {
      await api.post(`/socks/${grantTarget.id}/grants`, { userId: u.id });
      toast.success(`已授权给 ${u.email}`);
      setGrantAddQ(''); setGrantAddResults([]); setAddGrantUser(null);
      const res = await api.get(`/socks/${grantTarget.id}/grants`);
      setGrants(res.data.data);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setGrantBusy(false);
    }
  };

  const doRemoveGrant = async (g: any) => {
    if (!grantTarget) return;
    try {
      await api.delete(`/socks/${grantTarget.id}/grants/${g.userId}`);
      toast.success('已移除授权');
      const res = await api.get(`/socks/${grantTarget.id}/grants`);
      setGrants(res.data.data);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // ---- 绑定节点 ----
  const openBind = async (p: any) => {
    setBindTarget(p);
    setBindBusy(true);
    try {
      const res = await api.get('/inbounds', { params: { page: 1, limit: 200 } });
      setBindNodes(res.data.data.inbounds || []);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBindBusy(false);
    }
  };

  const doBindNode = async (node: any) => {
    if (!bindTarget) return;
    if (node.relayEnabled || node.relayTag) {
      toast.error(`节点 ${node.email} 已挂载中转，请先在其节点页卸载`);
      return;
    }
    setBindBusy(true);
    try {
      await api.post(`/inbounds/${node.id}/relay`, { socksId: bindTarget.id });
      toast.success(`已把该 SOCKS 绑定到节点 ${node.email}`);
      setBindTarget(null);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBindBusy(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'user', header: '归属用户', render: (p: any) => p.user?.email || '—' },
    { key: 'host', header: '地址', render: (p: any) => <span className="font-mono text-xs">{p.host}:{p.port}</span> },
    { key: 'username', header: '用户名', render: (p: any) => p.username || '—' },
    { key: 'grants', header: '授权用户数', render: (p: any) => (p._count?.grants ?? 0) > 0 ? <span className="font-medium text-primary">{p._count.grants} 人</span> : '—' },
    { key: 'status', header: '状态', render: (p: any) => <StatusBadge status={p.status} /> },
    { key: 'createdAt', header: '创建时间', render: (p: any) => new Date(p.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (p: any) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" title="编辑" onClick={() => openEdit(p)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="outline" title="授权给用户" onClick={() => openGrants(p)}><Users className="h-3 w-3" /></Button>
          <Button size="sm" variant="outline" title="绑定节点" onClick={() => openBind(p)}><Link2 className="h-3 w-3" /></Button>
          <Button size="sm" variant="outline" onClick={() => toggleStatus(p.id, p.status)}>
            {p.status === 'ACTIVE' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </Button>
          <Button size="sm" variant="destructive" title="彻底删除" onClick={() => remove(p.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="SOCKS 中转管理" subtitle={`共 ${total} 个 SOCKS 中转`}>
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
          <Button variant="gradient" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />新增 SOCKS
          </Button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard title="总 SOCKS" value={stats?.total ?? total} />
        <StatCard title="启用" value={stats?.total ? stats.active : 0} color="rgb(5 150 105)" />
        <StatCard title="停用" value={stats?.total ? stats.inactive : 0} color="rgb(100 116 139)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={proxies} keyField="id" emptyMessage="暂无 SOCKS 中转" />
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

      {/* 新建 / 编辑 SOCKS（归属 + 可授权） */}
      <Dialog open={formOpen} onOpenChange={(o) => !o && setFormOpen(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 SOCKS #${editing.id}` : '新增 SOCKS'}</DialogTitle>
            {!editing && <DialogDescription>创建后即「绑定给用户」：归属用户可在购买时选用，另可单独授权其他用户。</DialogDescription>}
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>地址 *</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="1.2.3.4" />
              </div>
              <div className="space-y-2">
                <Label>端口 *</Label>
                <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="1080" type="number" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>用户名（可选）</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>密码（可选）</Label>
                <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>备注</Label>
              <Input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="如：香港出口 A" />
            </div>
            <UserPicker
              label="归属用户 *（绑定给该用户）"
              selectedId={form.ownerId}
              selectedLabel={form.ownerLabel}
              onPick={(u: any) => setForm({ ...form, ownerId: u ? u.id : null, ownerLabel: u ? u.email : '' })}
            />
            {!editing && (
              <GrantPicker
                ids={form.grantIds}
                labels={form.grantLabels}
                onAdd={(u: any) => setForm({ ...form, grantIds: [...form.grantIds, u.id], grantLabels: { ...form.grantLabels, [u.id]: u.email } })}
                onRemove={(id: number) => {
                  const labels = { ...form.grantLabels }; delete labels[id];
                  setForm({ ...form, grantIds: form.grantIds.filter((x) => x !== id), grantLabels: labels });
                }}
              />
            )}
            <Button className="w-full" variant="gradient" onClick={submitForm}>
              {editing ? '保存改动' : '创建并绑定归属用户'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 授权管理 */}
      <Dialog open={!!grantTarget} onOpenChange={(o) => !o && setGrantTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>授权用户：{grantTarget ? `${grantTarget.host}:${grantTarget.port}` : ''}</DialogTitle>
            <DialogDescription>授权后，该用户在购买开启中转时可直接选用此 SOCKS（归属用户始终可用）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="max-h-52 space-y-1 overflow-auto rounded-md border p-2">
              {grants.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">暂无授权用户 · 归属用户为 {grantTarget?.user?.email || '—'}</p>
              ) : grants.map((g) => (
                <div key={g.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <span>{g.user?.email || `#${g.userId}`}</span>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => doRemoveGrant(g)}>移除</Button>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input value={grantAddQ} onChange={(e) => setGrantAddQ(e.target.value)} placeholder="输入邮箱搜索要授权的用户" onKeyDown={(e) => e.key === 'Enter' && searchGrantUser()} />
                <Button size="sm" variant="outline" onClick={searchGrantUser}>搜索</Button>
              </div>
              {grantAddResults.length > 0 && (
                <div className="max-h-40 overflow-auto rounded-md border">
                  {grantAddResults.map((u) => (
                    <button key={u.id} type="button" disabled={grantBusy}
                      className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                      onClick={() => doAddGrant(u)}>
                      <span>{u.email}</span>
                      <span className="text-xs text-primary">授权</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 绑定节点 */}
      <Dialog open={!!bindTarget} onOpenChange={(o) => !o && setBindTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>绑定节点：{bindTarget ? `${bindTarget.host}:${bindTarget.port}` : ''}</DialogTitle>
            <DialogDescription>选择要把该 SOCKS 手动挂载到哪个节点（该节点流量将全程经此 SOCKS 出站）。</DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-2">
            {bindBusy ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">加载节点…</p>
            ) : bindNodes.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">暂无节点</p>
            ) : bindNodes.map((n) => (
              <div key={n.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{n.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{n.user?.email || '—'} · {n.server?.name || '—'} · :{n.port}</p>
                </div>
                {n.relayEnabled ? (
                  <span className="shrink-0 text-xs text-amber-600">已挂中转</span>
                ) : (
                  <Button size="sm" onClick={() => doBindNode(n)} disabled={bindBusy}>绑定</Button>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}