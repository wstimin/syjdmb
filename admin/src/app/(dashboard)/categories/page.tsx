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
import Pagination from '@/components/shared/pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const SCOPE_OPTIONS = [
  { value: 'VIRTUAL', label: 'NP店铺', hint: '账号 / 教程 / AI工具 …' },
  { value: 'PLAN', label: '网络产品', hint: '香港 / 美国 …' },
];

export default function CategoriesPage() {
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState('');

  const [form, setForm] = useState({
    name: '', nameEn: '', scope: 'VIRTUAL', sort: '0',
  });

  const fetchCategories = () => {
    api.get('/categories')
      .then((res) => setCategories(res.data.data || []))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchCategories(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', nameEn: '', scope: 'VIRTUAL', sort: '0' });
    setDialogOpen(true);
  };

  const openEdit = (c: any) => {
    setEditing(c);
    setForm({
      name: c.name, nameEn: c.nameEn || '', scope: c.scope, sort: String(c.sort ?? 0),
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('分类名称必填');
      return;
    }
    const payload = {
      name: form.name.trim(),
      nameEn: form.nameEn.trim() || null,
      scope: form.scope,
      sort: Number(form.sort) || 0,
    };
    try {
      if (editing) {
        await api.put(`/categories/${editing.id}`, payload);
      } else {
        await api.post('/categories', payload);
      }
      toast.success('保存成功');
      setDialogOpen(false);
      fetchCategories();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该分类？已绑定该分类的商品/套餐将回到「未分类」（商品本身不会被删除）。')) return;
    try {
      await api.delete(`/categories/${id}`);
      toast.success('已删除');
      fetchCategories();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 客户端搜索过滤
  const filtered = search.trim()
    ? categories.filter((c) =>
        [c.name, c.nameEn].some((v) => String(v ?? '').toLowerCase().includes(search.trim().toLowerCase())),
      )
    : categories;

  const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
  const safePage = Math.min(page, totalPages);
  const pageData = filtered.slice((safePage - 1) * limit, safePage * limit);

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    {
      key: 'name', header: '分类名称',
      render: (c: any) => <span className="font-medium">{c.name}</span>,
    },
    {
      key: 'nameEn', header: '英文名',
      render: (c: any) => c.nameEn ? <span className="text-sm">{c.nameEn}</span> : <span className="text-xs text-muted-foreground">-</span>,
    },
    {
      key: 'scope', header: '适用范围',
      render: (c: any) => {
        const s = SCOPE_OPTIONS.find((o) => o.value === c.scope);
        return c.scope === 'PLAN'
          ? <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-600">网络产品</span>
          : <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-600">NP店铺</span>;
      },
    },
    {
      key: 'sort', header: '排序',
      render: (c: any) => <span className="font-mono text-xs">{c.sort}</span>,
    },
    {
      key: 'actions', header: '操作',
      render: (c: any) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(c)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="destructive" onClick={() => remove(c.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="分类管理" subtitle="商城分类：网络产品（香港/美国…）与 NP店铺（账号/教程/AI工具…）。在商品/套餐表单中选择绑定。">
        <div className="flex items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="搜索名称 / 英文名…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新建分类</Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={pageData} keyField="id" emptyMessage="暂无分类。点击右上角「新建分类」创建。" />
          <Pagination
            page={safePage}
            limit={limit}
            total={filtered.length}
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
            <DialogTitle>{editing ? `编辑分类 #${editing.id}` : '新建分类'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>分类名称（中文）*</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="香港 / 账号 / 教程…" />
            </div>
            <div className="space-y-2">
              <Label>名称（英文）</Label>
              <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} placeholder="Hong Kong / Account…" />
            </div>
            <div className="space-y-2">
              <Label>适用范围*</Label>
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {SCOPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}（{o.hint}）</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>排序权重（越小越靠前）</Label>
              <Input type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} />
            </div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            适用范围决定绑定对象：网络产品分类挂在「网络产品」套餐表单，NP店铺分类挂在「NP店铺」商品表单。删除分类后，绑定商品自动回到「未分类」。
          </div>
          <Button className="w-full" variant="gradient" onClick={save}>保存</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}