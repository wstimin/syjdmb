'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Copy, Search, Check } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { copyToClipboard } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { StatCard } from '@/components/shared/stat-card';

const STATUS_OPTIONS = ['ALL', 'ACTIVE', 'DISABLED'];

// datetime-local 输入框用本地时间 "YYYY-MM-DDTHH:mm"
const toLocalInput = (d?: string | null) => {
  if (!d) return '';
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
};

// 力度展示：PERCENT value=优惠百分比（10 = 优惠10%，相当于打9折）；AMOUNT value=立减金额
const discountText = (c: any) =>
  c.type === 'PERCENT'
    ? `优惠 ${Number(c.value)}% · 相当于 ${(100 - Number(c.value)) / 10} 折`
    : `立减 ¥${Number(c.value)}`;

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any | null>(null);

  // 创建/编辑弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any | null>(null); // 非空 → 编辑弹窗
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<any>({
    code: '',
    name: '',
    type: 'PERCENT',
    value: '10',
    minAmount: '0',
    maxDiscount: '',
    totalCount: '0',
    perUserLimit: '1',
    startAt: '',
    endAt: '',
  });
  const [copied, setCopied] = useState('');

  const fetchCoupons = () => {
    setLoading(true);
    api.get('/coupons', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setCoupons(res.data.data.list);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/coupons/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => { /* 统计接口失败时静默 */ });
  };

  useEffect(() => { fetchCoupons(); }, [page, limit, status]);
  useEffect(() => { fetchStats(); }, []);

  const resetPage = () => setPage(1);

  // 校验 + 组装提交数据（开始/结束时间：空 → null）
  const mergeForm = () => {
    const value = Number(form.value);
    if (!(value > 0)) throw new Error('优惠值必须大于 0');
    if (form.type === 'PERCENT' && value > 100) throw new Error('优惠百分比不能超过 100');
    if (form.minAmount && Number(form.minAmount) < 0) throw new Error('最低消费不能为负数');
    if (form.totalCount && Number(form.totalCount) < 0) throw new Error('发行量不能为负数');
    if (form.perUserLimit && Number(form.perUserLimit) < 1) throw new Error('每人限用次数至少为 1');
    if (form.startAt && form.endAt && new Date(form.endAt) <= new Date(form.startAt)) {
      throw new Error('失效时间需晚于生效时间');
    }
    return {
      code: form.code.trim() || undefined,
      name: form.name.trim() || undefined,
      type: form.type,
      value: Number(value),
      minAmount: form.minAmount ? Number(form.minAmount) : 0,
      maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : undefined,
      totalCount: form.totalCount ? Number(form.totalCount) : 0,
      perUserLimit: form.perUserLimit ? Number(form.perUserLimit) : 1,
      startAt: form.startAt || undefined,
      endAt: form.endAt || undefined,
    };
  };

  const create = async () => {
    let payload: any;
    try {
      payload = mergeForm();
    } catch (e: any) {
      toast.error(e.message);
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/coupons', payload);
      toast.success(`优惠券已创建：${res.data.data.code}`);
      setCreateOpen(false);
      fetchCoupons();
      fetchStats();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (c: any) => {
    setEditTarget(c);
    setForm({
      code: c.code,
      name: c.name || '',
      type: c.type,
      value: String(c.value),
      minAmount: String(c.minAmount ?? 0),
      maxDiscount: c.maxDiscount != null ? String(c.maxDiscount) : '',
      totalCount: String(c.totalCount ?? 0),
      perUserLimit: String(c.perUserLimit ?? 1),
      startAt: toLocalInput(c.startAt),
      endAt: toLocalInput(c.endAt),
    });
  };

  const update = async () => {
    let payload: any;
    try {
      payload = mergeForm();
    } catch (e: any) {
      toast.error(e.message);
      return;
    }
    // 券码与类型不可改（后端也不接受），编辑时不提交
    delete payload.code;
    delete payload.type;
    setSaving(true);
    try {
      await api.patch(`/coupons/${editTarget.id}`, payload);
      toast.success('已保存');
      setEditTarget(null);
      fetchCoupons();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (c: any) => {
    if (!confirm(`确认${c.status === 'ACTIVE' ? '停用' : '启用'}优惠券 ${c.code}？`)) return;
    try {
      await api.patch(`/coupons/${c.id}`, { status: c.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
      toast.success(c.status === 'ACTIVE' ? '已停用' : '已启用');
      fetchCoupons();
      fetchStats();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const copyCode = async (code: string) => {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(code);
      setTimeout(() => setCopied(''), 2000);
    }
  };

  if (loading && coupons.length === 0) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    {
      key: 'code',
      header: '优惠券码',
      render: (c: any) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          {c.code}
          <button onClick={() => copyCode(c.code)} className="text-muted-foreground hover:text-primary">
            {copied === c.code ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </span>
      ),
    },
    { key: 'name', header: '名称', render: (c: any) => c.name || '—' },
    { key: 'value', header: '优惠力度', render: (c: any) => <span className="font-medium text-primary">{discountText(c)}</span> },
    { key: 'minAmount', header: '最低消费', render: (c: any) => (Number(c.minAmount) > 0 ? `满 ¥${Number(c.minAmount)}` : '无门槛') },
    {
      key: 'used',
      header: '发行/已用',
      render: (c: any) =>
        Number(c.totalCount) > 0 ? (
          <span>
            {c.usedCount}/{c.totalCount}
          </span>
        ) : (
          <span>
            不限量 · 已用 {c.usedCount}
          </span>
        ),
    },
    { key: 'perUserLimit', header: '每人限用', render: (c: any) => `${c.perUserLimit} 次` },
    {
      key: 'window',
      header: '有效期',
      render: (c: any) => (
        <span className="text-xs">
          {c.startAt ? new Date(c.startAt).toLocaleDateString() : '不限'} ~ {c.endAt ? new Date(c.endAt).toLocaleDateString() : '不限'}
        </span>
      ),
    },
    { key: 'status', header: '状态', render: (c: any) => <StatusBadge status={c.status} /> },
    {
      key: 'actions',
      header: '操作',
      render: (c: any) => (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(c)}>编辑</Button>
          <Button size="sm" variant={c.status === 'ACTIVE' ? 'destructive' : 'default'} onClick={() => toggleStatus(c)}>
            {c.status === 'ACTIVE' ? '停用' : '启用'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="优惠券管理" subtitle={`共 ${total} 张优惠券，用户下单时可输入券码抵扣`}>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); resetPage(); }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? '全部状态' : s === 'ACTIVE' ? '启用中' : '已停用'}</option>
            ))}
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索券码 / 名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchCoupons()}
            />
          </div>
          <Button variant="outline" onClick={() => fetchCoupons()}>搜索</Button>
          <Button variant="gradient" onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" />新建优惠券</Button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <StatCard title="全部优惠券" value={stats?.total ?? 0} />
        <StatCard title="启用中" value={stats?.active ?? 0} color="rgb(5 150 105)" />
        <StatCard title="已停用" value={stats?.disabled ?? 0} />
        <StatCard title="累计被使用" value={stats?.totalUsed ?? 0} color="rgb(37 99 235)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={coupons} keyField="id" emptyMessage="暂无优惠券" />
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

      {/* 创建弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建优惠券</DialogTitle>
          </DialogHeader>
          <CouponForm form={form} setForm={setForm} />
          <Button className="w-full" variant="gradient" onClick={create} disabled={saving}>
            {saving ? '创建中...' : '创建'}
          </Button>
        </DialogContent>
      </Dialog>

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑优惠券 {editTarget?.code}</DialogTitle>
          </DialogHeader>
          {editTarget && <p className="-mt-2 text-xs text-muted-foreground">券码与优惠类型创建后不可修改；修改力度/门槛/限量即可</p>}
          <CouponForm form={form} setForm={setForm} readOnlyCode edit />
          <Button className="w-full" variant="gradient" onClick={update} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// 表单（创建 / 编辑共用；readOnlyCode=真时券码输入框只读）
function CouponForm({ form, setForm, readOnlyCode = false, edit = false }: {
  form: any;
  setForm: (f: any) => void;
  readOnlyCode?: boolean;
  edit?: boolean;
}) {
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label>券码（不填则自动生成）</Label>
        <Input
          value={form.code}
          onChange={set('code')}
          placeholder="如 NEWYEAR10"
          disabled={readOnlyCode}
          className={readOnlyCode ? 'opacity-60' : ''}
        />
      </div>
      <div className="space-y-2">
        <Label>名称</Label>
        <Input value={form.name} onChange={set('name')} placeholder="如 新人立减" />
      </div>

      <div className="space-y-2">
        <Label>优惠类型</Label>
        <select
          value={form.type}
          onChange={set('type')}
          disabled={edit}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60"
        >
          <option value="PERCENT">折扣（优惠百分比）</option>
          <option value="AMOUNT">立减（固定金额）</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label>{form.type === 'PERCENT' ? '优惠百分比（10 = 打9折）' : '立减金额（元）'}</Label>
        <Input type="number" value={form.value} onChange={set('value')} />
      </div>

      <div className="space-y-2">
        <Label>最低消费（元，0 = 无门槛）</Label>
        <Input type="number" value={form.minAmount} onChange={set('minAmount')} />
      </div>
      <div className="space-y-2">
        <Label>优惠封顶（元，可不填）</Label>
        <Input type="number" value={form.maxDiscount} onChange={set('maxDiscount')} placeholder="不限" />
      </div>

      <div className="space-y-2">
        <Label>发行总量（0 = 不限量）</Label>
        <Input type="number" value={form.totalCount} onChange={set('totalCount')} />
      </div>
      <div className="space-y-2">
        <Label>每人限用次数</Label>
        <Input type="number" value={form.perUserLimit} onChange={set('perUserLimit')} />
      </div>

      <div className="space-y-2">
        <Label>生效时间（可不填）</Label>
        <Input type="datetime-local" value={form.startAt} onChange={set('startAt')} />
      </div>
      <div className="space-y-2">
        <Label>失效时间（可不填）</Label>
        <Input type="datetime-local" value={form.endAt} onChange={set('endAt')} />
      </div>

      {form.type === 'PERCENT' && (
        <p className="col-span-2 text-xs text-muted-foreground">
          例：优惠百分比填 10 → 用户付款打 9 折（省 10%）；填 100 → 全免（实付 ¥0.01）
        </p>
      )}
    </div>
  );
}