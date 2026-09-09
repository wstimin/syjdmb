'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable } from '@/components/shared/data-table';
import { StatCard } from '@/components/shared/stat-card';
import Pagination from '@/components/shared/pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const PLAN_STATUSES = ['ACTIVE', 'HIDDEN', 'SOLD_OUT', 'ARCHIVED'];

export default function PlansPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  // 客户端分页（后端 /plans/admin/all 一次性返回全部）
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [form, setForm] = useState({
    name: '', nameEn: '', price: '', originalPrice: '', duration: '30',
    traffic: '0', deviceLimit: '1', description: '', protocols: 'vless',
    sort: '0', serverIds: [] as number[],
  });

  const fetchPlans = () => {
    api.get('/plans/admin/all')
      .then((res) => setPlans(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/plans/admin/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => { /* 统计加载失败不影响主列表 */ });
  };

  // 同时加载服务器列表用于套餐绑定
  const fetchServers = () => {
    api.get('/servers')
      .then((res) => setServers(res.data.data))
      .catch(() => toast.error('服务器列表加载失败，无法绑定'));
  };

  useEffect(() => { fetchPlans(); fetchStats(); fetchServers(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', nameEn: '', price: '', originalPrice: '', duration: '30', traffic: '0', deviceLimit: '1', description: '', protocols: 'vless', sort: '0', serverIds: [] });
    setDialogOpen(true);
  };

  const openEdit = (plan: any) => {
    setEditing(plan);
    setForm({
      name: plan.name, nameEn: plan.nameEn || '', price: String(plan.price),
      originalPrice: plan.originalPrice ? String(plan.originalPrice) : '',
      duration: String(plan.duration), traffic: String(plan.traffic || 0),
      deviceLimit: String(plan.deviceLimit), description: plan.description || '',
      protocols: plan.protocols.join(','),
      sort: String(plan.sort ?? 0),
      serverIds: plan.serverIds || [],
    });
    setDialogOpen(true);
  };

  // 切换服务器勾选
  const toggleServer = (id: number) => {
    setForm((f) => ({
      ...f,
      serverIds: f.serverIds.includes(id)
        ? f.serverIds.filter((x) => x !== id)
        : [...f.serverIds, id],
    }));
  };

  const save = async () => {
    if (!form.name || !form.price) {
      toast.error('名称和价格必填');
      return;
    }
    if (form.serverIds.length === 0) {
      toast.error('请至少绑定一台服务器，否则用户无法购买');
      return;
    }
    const payload = {
      name: form.name,
      nameEn: form.nameEn || null,
      price: Number(form.price),
      originalPrice: form.originalPrice ? Number(form.originalPrice) : null,
      duration: Number(form.duration),
      traffic: BigInt(Math.round(Number(form.traffic) * 1024 * 1024 * 1024)).toString(),
      deviceLimit: Number(form.deviceLimit),
      description: form.description || null,
      protocols: form.protocols.split(',').map((s) => s.trim()).filter(Boolean),
      serverIds: form.serverIds,
      sort: Number(form.sort) || 0,
      type: 'TIME_BASED',
      status: 'ACTIVE',
    };
    try {
      if (editing) {
        await api.put(`/plans/${editing.id}`, payload);
      } else {
        await api.post('/plans', payload);
      }
      toast.success('保存成功');
      setDialogOpen(false);
      fetchPlans();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该方案？')) return;
    try {
      await api.delete(`/plans/${id}`);
      toast.success('已删除');
      fetchPlans();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 修改套餐状态（ACTIVE/HIDDEN/SOLD_OUT/ARCHIVED）
  const changeStatus = async (plan: any, status: string) => {
    if (status === plan.status) return;
    try {
      await api.put(`/plans/${plan.id}`, { status });
      toast.success('状态已更新');
      fetchPlans();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 客户端分页切片
  const totalPlans = plans.length;
  const totalPages = Math.max(1, Math.ceil(totalPlans / limit));
  const safePage = Math.min(page, totalPages);
  const pagePlans = plans.slice((safePage - 1) * limit, safePage * limit);

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'name', header: '方案名称', render: (p: any) => <span className="font-medium">{p.name}</span> },
    { key: 'price', header: '价格', render: (p: any) => <span className="text-primary font-medium">¥{Number(p.price)}</span> },
    {
      key: 'duration', header: '时长',
      render: (p: any) => p.duration > 0 ? `${p.duration}天` : '不限',
    },
    {
      key: 'traffic', header: '流量',
      render: (p: any) => Number(p.traffic) > 0 ? `${(Number(p.traffic)/1024/1024/1024)}GB` : '不限',
    },
    { key: 'protocols', header: '协议', render: (p: any) => p.protocols.join('/') },
    {
      key: 'servers', header: '绑定服务器',
      render: (p: any) => {
        const ids = p.serverIds || [];
        if (ids.length === 0) return <span className="text-rose-500 text-xs font-medium">未绑定</span>;
        const names = ids.map((id: number) => servers.find((s) => s.id === id)?.name).filter(Boolean);
        return <span className="text-xs">{names.length ? names.join('、') : `服务器#${ids.join('#')}`}</span>;
      },
    },
    {
      key: 'status', header: '状态',
      render: (p: any) => (
        <select
          value={p.status}
          onChange={(e) => changeStatus(p, e.target.value)}
          onClick={(e: any) => e.stopPropagation()}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {PLAN_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'actions', header: '操作',
      render: (p: any) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(p)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="destructive" onClick={() => remove(p.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="网络方案管理" subtitle="管理可售卖的节点网络方案">
        <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新建方案</Button>
      </PageHeader>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="方案总数" value={stats?.totalPlans ?? 0} />
        <StatCard title="活跃方案" value={stats?.activePlans ?? 0} sub="状态为 ACTIVE" color="#10b981" />
        <StatCard title="累计成交额" value={stats ? `¥${Number(stats.totalRevenue || 0).toFixed(2)}` : '¥0.00'} />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={pagePlans} keyField="id" emptyMessage="暂无方案" />
          <Pagination
            page={safePage}
            limit={limit}
            total={totalPlans}
            totalPages={totalPages}
            onPageChange={setPage}
            onLimitChange={(l) => { setLimit(l); setPage(1); }}
          />
        </CardContent>
      </Card>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑方案 #${editing.id}` : '新建方案'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>名称（中文）*</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>名称（英文）</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>价格（元）*</Label>
              <Input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>原价（元，可选）</Label>
              <Input type="number" value={form.originalPrice} onChange={(e) => setForm({ ...form, originalPrice: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>时长（天，0=不限）</Label>
              <Input type="number" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>流量（GB，0=不限）</Label>
              <Input type="number" value={form.traffic} onChange={(e) => setForm({ ...form, traffic: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>设备数</Label>
              <Input type="number" value={form.deviceLimit} onChange={(e) => setForm({ ...form, deviceLimit: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>支持协议（逗号分隔）</Label>
              <Input value={form.protocols} onChange={(e) => setForm({ ...form, protocols: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>排序权重（越小越靠前）</Label>
              <Input type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>绑定服务器（可选多台）</Label>
              {servers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  还没有可用服务器，请先到「服务器管理」添加并连接 XUI 面板。
                </p>
              ) : (
                <div className="flex flex-wrap gap-2 rounded-md border border-input p-3">
                  {servers.map((s: any) => {
                    const checked = form.serverIds.includes(s.id);
                    const online = s.sessionId || s.status === 'ACTIVE';
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleServer(s.id)}
                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          checked
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-input text-foreground hover:bg-accent'
                        }`}
                      >
                        {s.flag || ''} {s.name} {!online && <span className="opacity-50">(离线)</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                用户购买该方案后，将在这几台服务器上自动创建节点。至少绑定一台。
              </p>
            </div>
            <div className="space-y-2 col-span-2">
              <Label>描述</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <Button className="w-full" variant="gradient" onClick={save}>保存</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
