'use client';

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, KeyRound } from 'lucide-react';
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

const VP_STATUSES = [
  { value: 'ACTIVE', label: '在售' },
  { value: 'HIDDEN', label: '隐藏' },
  { value: 'SOLD_OUT', label: '已售罄' },
  { value: 'ARCHIVED', label: '已下架' },
];
const DELIVERY_TYPES = [
  { id: 'AUTO', label: '自动发货（上传交付码，付款后自动发放）' },
  { id: 'MANUAL', label: '人工发货（付款后在订单里手动填交付内容）' },
  { id: 'SOCKS_PANEL', label: 'SOCKS 面板交付（付款后在 XUI 面板建 socks 入站，时长制不限流量）' },
];

export default function VirtualProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState('');

  const [form, setForm] = useState({
    name: '', nameEn: '', price: '', originalPrice: '',
    description: '', descriptionEn: '', coverUrl: '',
    deliveryType: 'AUTO', sort: '0', status: 'ACTIVE',
    duration: '', serverIds: [] as number[], // SOCKS_PANEL 交付字段
  });

  // SOCKS_PANEL 绑定服务器候选（多选）
  const [servers, setServers] = useState<any[]>([]);

  // ---- 交付码库弹窗 ----
  const [keysTarget, setKeysTarget] = useState<any | null>(null); // 商品对象
  const [batchText, setBatchText] = useState(''); // 批量粘贴的码（每行一个）
  const [keys, setKeys] = useState<any[]>([]);
  const [keysTotal, setKeysTotal] = useState(0);
  const [keysPage, setKeysPage] = useState(1);
  const [keysLoading, setKeysLoading] = useState(false);

  const fetchProducts = () => {
    api.get('/virtual-products/admin/all')
      .then((res) => setProducts(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchProducts(); }, []);
  useEffect(() => {
    api.get('/servers')
      .then((res) => setServers(Array.isArray(res.data.data) ? res.data.data : []))
      .catch(() => {});
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '', nameEn: '', price: '', originalPrice: '',
      description: '', descriptionEn: '', coverUrl: '',
      deliveryType: 'AUTO', sort: '0', status: 'ACTIVE',
      duration: '', serverIds: [] as number[],
    });
    setDialogOpen(true);
  };

  const openEdit = (p: any) => {
    setEditing(p);
    setForm({
      name: p.name, nameEn: p.nameEn || '', price: String(p.price),
      originalPrice: p.originalPrice ? String(p.originalPrice) : '',
      description: p.description || '', descriptionEn: p.descriptionEn || '',
      coverUrl: p.coverUrl || '',
      deliveryType: p.deliveryType, sort: String(p.sort ?? 0), status: p.status,
      duration: p.deliveryType === 'SOCKS_PANEL' ? String(p.duration ?? '') : '',
      serverIds: p.deliveryType === 'SOCKS_PANEL' ? p.serverIds || [] : [],
    });
    setDialogOpen(true);
  };

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
    if (form.deliveryType === 'SOCKS_PANEL' && !(Number(form.duration) > 0)) {
      toast.error('SOCKS 面板交付需要填写交付时长（天）');
      return;
    }
    const payload = {
      name: form.name,
      nameEn: form.nameEn || null,
      price: Number(form.price),
      originalPrice: form.originalPrice ? Number(form.originalPrice) : null,
      description: form.description || null,
      descriptionEn: form.descriptionEn || null,
      coverUrl: form.coverUrl || null,
      deliveryType: form.deliveryType,
      sort: Number(form.sort) || 0,
      status: form.status,
      // SOCKS_PANEL：时长（天）+ 绑定服务器（空数组=全局可用）
      duration: form.deliveryType === 'SOCKS_PANEL' ? Number(form.duration) : null,
      serverIds: form.deliveryType === 'SOCKS_PANEL' ? form.serverIds : [],
    };
    try {
      if (editing) {
        await api.put(`/virtual-products/${editing.id}`, payload);
      } else {
        await api.post('/virtual-products', payload);
      }
      toast.success('保存成功');
      setDialogOpen(false);
      fetchProducts();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该商品？已有成交订单的商品无法删除，请改用已下架（ARCHIVED）。')) return;
    try {
      await api.delete(`/virtual-products/${id}`);
      toast.success('已删除');
      fetchProducts();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const changeStatus = async (p: any, status: string) => {
    if (status === p.status) return;
    try {
      await api.put(`/virtual-products/${p.id}`, { status });
      toast.success('状态已更新');
      fetchProducts();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 剩余未售交付码（AUTO）；MANUAL 恒为 -
  const remainingOf = (p: any) =>
    p.deliveryType === 'AUTO' ? Number(p._count?.keys ?? 0) : null;

  // ---- 交付码库 ----
  const fetchKeys = useCallback(async (id: number, p = 1) => {
    setKeysLoading(true);
    try {
      const res = await api.get(`/virtual-products/${id}/keys?page=${p}&limit=50`);
      const d = res.data.data;
      setKeys(d.keys || []);
      setKeysTotal(d.total || 0);
      setKeysPage(d.page || 1);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setKeysLoading(false);
    }
  }, []);

  const openKeys = (p: any) => {
    setKeysTarget(p);
    setBatchText('');
    fetchKeys(p.id, 1);
  };

  const submitBatchKeys = async () => {
    if (!keysTarget) return;
    const text = batchText.trim();
    if (!text) {
      toast.error('请先粘贴交付码（每行一个）');
      return;
    }
    try {
      const res = await api.post(`/virtual-products/${keysTarget.id}/keys`, { text });
      const d = res.data.data;
      toast.success(`已导入 ${d.added} 个码${d.skippedText > 0 ? `（跳过重复 ${d.skippedText}）` : ''}`);
      setBatchText('');
      fetchKeys(keysTarget.id, keysPage);
      fetchProducts();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const deleteKey = async (keyId: number) => {
    if (!confirm('确定删除该交付码？（仅未售码可删）')) return;
    try {
      await api.delete(`/virtual-products/keys/${keyId}`);
      toast.success('已删除');
      fetchKeys(keysTarget.id, keysPage);
      fetchProducts();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 客户端搜索过滤（整表在前端分页，全量过滤）
  const filteredProducts = search.trim()
    ? products.filter((p) =>
        [p.name, p.nameEn, p.description].some((v) => String(v ?? '').toLowerCase().includes(search.trim().toLowerCase())),
      )
    : products;

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / limit));
  const safePage = Math.min(page, totalPages);
  const pageProducts = filteredProducts.slice((safePage - 1) * limit, safePage * limit);

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'name', header: '商品名称', render: (p: any) => <span className="font-medium">{p.name}</span> },
    { key: 'price', header: '价格', render: (p: any) => <span className="text-primary font-medium">¥{Number(p.price)}</span> },
    {
      key: 'deliveryType', header: '交付方式',
      render: (p: any) => p.deliveryType === 'AUTO'
        ? <span className="text-xs font-medium text-violet-600">自动发货</span>
        : p.deliveryType === 'SOCKS_PANEL'
          ? <span className="text-xs font-medium text-sky-600">SOCKS 面板</span>
          : <span className="text-xs font-medium text-amber-600">人工发货</span>,
    },
    { key: 'sold', header: '已售', render: (p: any) => p.sold },
    {
      key: 'duration', header: '时长',
      render: (p: any) => p.deliveryType === 'SOCKS_PANEL'
        ? <span className="font-mono text-xs">{p.duration} 天</span>
        : <span className="text-xs text-muted-foreground">-</span>,
    },
    {
      key: 'serverIds', header: '绑定服务器',
      render: (p: any) => p.deliveryType === 'SOCKS_PANEL'
        ? (Array.isArray(p.serverIds) && p.serverIds.length > 0
            ? <span className="text-sm">{p.serverIds.length} 台</span>
            : <span className="text-muted-foreground text-xs">全局可用</span>)
        : <span className="text-xs text-muted-foreground">-</span>,
    },
    {
      key: 'stock', header: '剩余码',
      render: (p: any) => {
        const r = remainingOf(p);
        if (r === null) return <span className="text-xs text-muted-foreground">-</span>;
        return r === 0
          ? <span className="text-xs font-medium text-rose-500">售罄</span>
          : <span className="text-xs text-muted-foreground">{r}</span>;
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
          {VP_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'actions', header: '操作',
      render: (p: any) => (
        <div className="flex gap-2">
          {p.deliveryType === 'AUTO' && (
            <Button size="sm" variant="outline" onClick={() => openKeys(p)} title="交付码库">
              <KeyRound className="h-3 w-3" />
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => openEdit(p)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="destructive" onClick={() => remove(p.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="NP店铺" subtitle="NP 店铺数字商品：自动发货（交付码）、人工发货，或 SOCKS 面板交付（XUI 建 socks 入站）">
        <div className="flex items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="搜索名称 / 描述…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新建商品</Button>
        </div>
      </PageHeader>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="商品总数" value={products.length} />
        <StatCard title="自动发货（AUTO）" value={products.filter((p) => p.deliveryType === 'AUTO').length} color="#8b5cf6" />
        <StatCard title="人工发货（MANUAL）" value={products.filter((p) => p.deliveryType === 'MANUAL').length} color="#d97706" />
        <StatCard title="SOCKS 面板（面板交付）" value={products.filter((p) => p.deliveryType === 'SOCKS_PANEL').length} color="#0284c7" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={pageProducts} keyField="id" emptyMessage="暂无商品" />
          <Pagination
            page={safePage}
            limit={limit}
            total={products.length}
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
            <DialogTitle>{editing ? `编辑商品 #${editing.id}` : '新建商品'}</DialogTitle>
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
            <div className="space-y-2 col-span-2">
              <Label>商品图 URL（可选，外链）</Label>
              <Input value={form.coverUrl} onChange={(e) => setForm({ ...form, coverUrl: e.target.value })} placeholder="https://..." />
            </div>
            <div className="space-y-2">
              <Label>交付方式*</Label>
              <select
                value={form.deliveryType}
                onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {DELIVERY_TYPES.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </div>
            {form.deliveryType === 'SOCKS_PANEL' && (
              <>
                <div className="space-y-2">
                  <Label>交付时长（天）*</Label>
                  <Input type="number" min={1} value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="30" />
                  <p className="text-xs text-muted-foreground">时长制、不限流量；到期停用 → 1 天宽限期 → 自动删除（与现有节点一致）</p>
                </div>
                <div className="space-y-2 col-span-2">
                  <Label>绑定服务器（可选多台，激活时随机挑一台；不选 = 所有在线服务器可用）</Label>
                  {servers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      还没有可用服务器，请先到「服务器管理」添加并连接 XUI 面板。
                    </p>
                  ) : (
                    <div className="flex max-h-44 flex-wrap gap-2 overflow-auto rounded-md border border-input p-3">
                      {servers.map((s: any) => {
                        const checked = form.serverIds.includes(s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => toggleServer(s.id)}
                            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                              checked
                                ? 'border-primary bg-primary/10 font-medium text-primary'
                                : 'border-input text-foreground hover:bg-accent'
                            }`}
                          >
                            {s.flag || ''} {s.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label>状态</Label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {VP_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>排序权重（越小越靠前）</Label>
              <Input type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>描述（中文）</Label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>描述（英文）</Label>
              <textarea
                value={form.descriptionEn}
                onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
          <Button className="w-full" variant="gradient" onClick={save}>保存</Button>
        </DialogContent>
      </Dialog>

      {/* 交付码库弹窗（AUTO 商品） */}
      <Dialog open={!!keysTarget} onOpenChange={(o) => !o && setKeysTarget(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>交付码库 · {keysTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* 批量导入 */}
            <div className="space-y-2">
              <Label>批量添加交付码（每行一个；一行多段如账号/密码/链接会整体作为交付内容）</Label>
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                rows={4}
                placeholder={'ABC-12345\nuser:pass@example.com\nhttps://...'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button variant="outline" size="sm" onClick={submitBatchKeys} disabled={!batchText.trim()}>
                <Plus className="mr-1 h-3 w-3" />批量导入
              </Button>
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">共 {keysTotal} 个码（当前页 {keysPage}）</span>
            </div>

            {keysLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : keys.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                暂无交付码。AUTO 商品必须至少有一个未售码，购买时才会发放。
              </p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {keys.map((k: any) => (
                  <div key={k.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{k.code}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                        {k.status === 'UNUSED' ? (
                          <span className="text-emerald-600">未售</span>
                        ) : (
                          <span className="text-amber-600">已售 · {k.orderNo || '已发放'}</span>
                        )}
                      </div>
                    </div>
                    {k.status === 'UNUSED' && (
                      <Button size="sm" variant="ghost" onClick={() => deleteKey(k.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}