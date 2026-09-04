'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function PlansPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const [form, setForm] = useState({
    name: '', nameEn: '', price: '', originalPrice: '', duration: '30',
    traffic: '0', deviceLimit: '1', description: '', protocols: 'vless,vmess',
  });

  const fetchPlans = () => {
    api.get('/plans/admin/all')
      .then((res) => setPlans(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPlans(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', nameEn: '', price: '', originalPrice: '', duration: '30', traffic: '0', deviceLimit: '1', description: '', protocols: 'vless,vmess' });
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
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name || !form.price) {
      toast.error('名称和价格必填');
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
    if (!confirm('确定删除该套餐？')) return;
    try {
      await api.delete(`/plans/${id}`);
      toast.success('已删除');
      fetchPlans();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'name', header: '套餐名称', render: (p: any) => <span className="font-medium">{p.name}</span> },
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
    { key: 'status', header: '状态', render: (p: any) => <StatusBadge status={p.status} /> },
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
      <PageHeader title="套餐管理" subtitle="管理可售卖的节点套餐">
        <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新建套餐</Button>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={plans} keyField="id" emptyMessage="暂无套餐" />
        </CardContent>
      </Card>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑套餐 #${editing.id}` : '新建套餐'}</DialogTitle>
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
