'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Play, Pause, Trash2, Download, Link2, Plus } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
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
  const [relayTarget, setRelayTarget] = useState<any | null>(null);
  const [socksList, setSocksList] = useState<any[]>([]);
  const [relayBusy, setRelayBusy] = useState(false);

  // ---- 新建节点状态 ----
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [servers, setServers] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({
    userId: null as number | null,
    selectedLabel: '',
    serverId: '',
    protocol: 'vless',
    durationDays: 30,
    trafficGb: 0,
    speedLimit: '',
    deviceLimit: 0,
  });
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<any[]>([]);
  const [userSearching, setUserSearching] = useState(false);

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
    if (!confirm('确认彻底删除该节点？该操作不可恢复（节点及其面板配置会被物理清理）。')) return;
    try {
      await api.delete(`/inbounds/${id}`);
      toast.success('已彻底删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const openRelay = async (i: any) => {
    setRelayTarget(i);
    setRelayBusy(true);
    try {
      const res = await api.get('/socks', { params: { page: 1, limit: 200 } });
      setSocksList(res.data.data.proxies || []);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setRelayBusy(false);
    }
  };

  const doBindRelay = async (s: any) => {
    if (!relayTarget) return;
    setRelayBusy(true);
    try {
      await api.post(`/inbounds/${relayTarget.id}/relay`, { socksId: s.id });
      toast.success(`已把 SOCKS 出站绑定到节点 ${relayTarget.email}`);
      setRelayTarget(null);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setRelayBusy(false);
    }
  };

  const doUnbindRelay = async () => {
    if (!relayTarget) return;
    if (!confirm('确认卸载该节点上的 SOCKS 出站？卸载后节点恢复直连。')) return;
    setRelayBusy(true);
    try {
      await api.delete(`/inbounds/${relayTarget.id}/relay`);
      toast.success('已卸载 SOCKS 出站');
      setRelayTarget(null);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setRelayBusy(false);
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

  // ---- 新建节点逻辑 ----

  const openCreate = () => {
    setCreateForm({
      userId: null, selectedLabel: '', serverId: '', protocol: 'vless',
      durationDays: 30, trafficGb: 0, speedLimit: '', deviceLimit: 0,
    });
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
      await api.post('/inbounds', {
        userId: createForm.userId,
        serverId: Number(createForm.serverId),
        protocol: createForm.protocol,
        durationDays: createForm.durationDays,
        trafficGb: Number(createForm.trafficGb) || 0,
        speedLimit: createForm.speedLimit !== '' ? Number(createForm.speedLimit) : undefined,
        deviceLimit: Number(createForm.deviceLimit) || 0,
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
      key: 'relay', header: 'SOCKS 出站',
      render: (i: any) => (i.relayEnabled || i.relayTag
        ? <span className="text-xs font-medium text-amber-600">已挂载<Link2 className="ml-1 inline h-3 w-3" /></span>
        : <span className="text-xs text-muted-foreground">未挂载</span>),
    },
    {
      key: 'actions', header: '操作',
      render: (i: any) => (
        <div className="flex gap-1">
          <Button
            size="sm" variant="outline"
            title={i.relayEnabled || i.relayTag ? '查看 / 卸载出站' : '手动绑定 SOCKS 出站'}
            onClick={() => openRelay(i)}
          ><Link2 className="h-3 w-3" /></Button>
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
          <Button onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新建节点</Button>
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

      {/* SOCKS 出站绑定 / 卸载 */}
      <Dialog open={!!relayTarget} onOpenChange={(o) => !o && setRelayTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>节点 SOCKS 出站：{relayTarget?.email}</DialogTitle>
            <DialogDescription>把该节点流量全程经所选 SOCKS 出站（后台手动绑定）；已挂载时可一键卸载恢复直连。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {relayTarget?.relayEnabled || relayTarget?.relayTag ? (
              <div className="space-y-3">
                <div className="rounded-md border p-3 text-sm">
                  <p className="font-medium text-amber-600">已挂载 SOCKS 出站</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {relayTarget.relaySocksHost}:{relayTarget.relaySocksPort}
                    {relayTarget.relayTag ? ` · tag ${relayTarget.relayTag}` : ''}
                  </p>
                </div>
                <Button variant="destructive" className="w-full" onClick={doUnbindRelay} disabled={relayBusy}>
                  {relayBusy ? '处理中…' : '卸载出站'}
                </Button>
              </div>
            ) : (
              <div className="max-h-60 space-y-1 overflow-auto rounded-md border p-2">
                {relayBusy ? (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">加载 SOCKS 列表…</p>
                ) : socksList.length === 0 ? (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">暂无 SOCKS，可先到「SOCKS 出站管理」新增。</p>
                ) : socksList.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{s.host}:{s.port}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.user?.email || '—'} · {s.status}</p>
                    </div>
                    {s.status === 'ACTIVE' ? (
                      <Button size="sm" onClick={() => doBindRelay(s)} disabled={relayBusy}>绑定</Button>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">停用</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- 新建节点 Dialog ---- */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) setCreateOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建节点</DialogTitle>
            <DialogDescription>直接为用户创建节点（试用/赠送），不产生订单、不占商品库存。remark 为 null，节点自然过期/可删。</DialogDescription>
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
                    <Input value={userQuery} onChange={(e) => setUserQuery(e.target.value)}
                      placeholder="输入邮箱搜索用户"
                      onKeyDown={(e) => e.key === 'Enter' && searchUser()} />
                    <Button type="button" size="sm" variant="outline" onClick={searchUser} disabled={userSearching}>
                      {userSearching ? '搜索中…' : '搜索'}
                    </Button>
                  </div>
                  {userResults.length > 0 && (
                    <div className="max-h-44 overflow-auto rounded-md border">
                      {userResults.map((u) => (
                        <button key={u.id} type="button"
                          className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted"
                          onClick={() => setCreateForm((f) => ({
                            ...f, userId: u.id, selectedLabel: `${u.email}${u.username ? ` (${u.username})` : ''}`,
                          }))}>
                          <span>{u.email}</span>
                          <span className="text-xs text-muted-foreground">#{u.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 服务器 */}
            <div className="space-y-2">
              <Label>服务器</Label>
              <select value={createForm.serverId}
                onChange={(e) => setCreateForm((f) => ({ ...f, serverId: e.target.value }))}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="">请选择服务器</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}（{s.host}）</option>
                ))}
              </select>
            </div>

            {/* 协议 + 时长（同一行） */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>协议</Label>
                <select value={createForm.protocol}
                  onChange={(e) => setCreateForm((f) => ({ ...f, protocol: e.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="vless">vless（推荐，Reality 加密）</option>
                  <option value="vmess">vmess（WS）</option>
                  <option value="trojan">trojan</option>
                  <option value="shadowsocks">shadowsocks</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>时长（天）</Label>
                <Input type="number" min={1} value={createForm.durationDays}
                  onChange={(e) => setCreateForm((f) => ({ ...f, durationDays: Number(e.target.value) || 0 }))} />
              </div>
            </div>

            {/* 流量 / 限速 / 设备数（三列） */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>流量（GB）</Label>
                <Input type="number" min={0} placeholder="0 = 不限" value={createForm.trafficGb || ''}
                  onChange={(e) => setCreateForm((f) => ({ ...f, trafficGb: Number(e.target.value) || 0 }))} />
              </div>
              <div className="space-y-2">
                <Label>限速（Mbps）</Label>
                <Input type="number" min={0} placeholder="空 = 不限" value={createForm.speedLimit}
                  onChange={(e) => setCreateForm((f) => ({ ...f, speedLimit: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>设备数上限</Label>
                <Input type="number" min={0} placeholder="0 = 不限" value={createForm.deviceLimit || ''}
                  onChange={(e) => setCreateForm((f) => ({ ...f, deviceLimit: Number(e.target.value) || 0 }))} />
              </div>
            </div>

            <Button className="w-full" onClick={submitCreate} disabled={createBusy}>
              {createBusy ? '创建中…（正在建立节点 + 客户端绑定）' : '确认创建并绑定'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
