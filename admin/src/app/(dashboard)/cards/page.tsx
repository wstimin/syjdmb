'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Copy, XCircle, Check, Search, Download } from 'lucide-react';
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
import { exportToCsv } from '@/lib/csv';

const STATUS_OPTIONS = ['ALL', 'UNUSED', 'USED', 'CANCELLED'];

export default function CardsPage() {
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [amount, setAmount] = useState('10');
  const [count, setCount] = useState('10');
  const [prefix, setPrefix] = useState('');
  const [generated, setGenerated] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any | null>(null);

  const fetchCards = () => {
    setLoading(true);
    api.get('/cards', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setCards(res.data.data.cards);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/cards/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => { /* 统计接口失败时静默，保留当前显示 */ });
  };

  useEffect(() => { fetchCards(); }, [page, limit, status]);

  useEffect(() => { fetchStats(); }, []);

  const resetPage = () => setPage(1);

  const exportCards = () => {
    exportToCsv(
      cards.map((c) => ({
        code: c.code,
        amount: Number(c.amount),
        status: c.status,
        usedBy: c.user?.email || '',
        createdAt: c.createdAt,
      })),
      'cards'
    );
  };

  const generate = async () => {
    try {
      const res = await api.post('/cards/generate', {
        amount: Number(amount),
        count: Number(count),
        prefix: prefix || undefined,
      });
      setGenerated(res.data.data);
      toast.success(`已生成 ${res.data.data.count} 张卡密`);
      fetchCards();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const cancelCard = async (id: number) => {
    if (!confirm('确认作废该卡密？')) return;
    try {
      await api.post(`/cards/${id}/cancel`);
      toast.success('已作废');
      fetchCards();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const copyAll = async () => {
    if (!generated) return;
    // HTTP 环境下 navigator.clipboard 不可用，走 copyToClipboard 的 execCommand 兜底
    const ok = await copyToClipboard(generated.codes.join('\n'));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'code', header: '卡密', render: (c: any) => <span className="font-mono text-xs">{c.code}</span> },
    { key: 'amount', header: '面值', render: (c: any) => <span className="text-primary font-medium">¥{Number(c.amount)}</span> },
    { key: 'status', header: '状态', render: (c: any) => <StatusBadge status={c.status} /> },
    { key: 'usedBy', header: '使用者', render: (c: any) => c.user?.email || '—' },
    { key: 'createdAt', header: '生成时间', render: (c: any) => new Date(c.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (c: any) => (
        c.status === 'UNUSED' ? (
          <Button size="sm" variant="destructive" onClick={() => cancelCard(c.id)}><XCircle className="mr-1 h-3 w-3" />作废</Button>
        ) : <span className="text-muted-foreground text-xs">—</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="卡密管理" subtitle={`共 ${total} 张卡密`}>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); resetPage(); }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? '全部状态' : s}</option>
            ))}
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索卡密"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchCards()}
            />
          </div>
          <Button variant="outline" onClick={() => fetchCards()}>搜索</Button>
          <Button variant="outline" onClick={exportCards}>
            <Download className="mr-1 h-4 w-4" />导出
          </Button>
          <Button variant="gradient" onClick={() => setDialogOpen(true)}><Plus className="mr-1 h-4 w-4" />生成卡密</Button>
        </div>
      </PageHeader>

      {/* Statistics */}
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard title="总卡密" value={stats?.total ?? cards.length} />
        <StatCard title="未使用" value={stats?.unused ?? 0} color="rgb(37 99 235)" />
        <StatCard title="已使用" value={stats?.used ?? 0} color="rgb(5 150 105)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={cards} keyField="id" emptyMessage="暂无卡密" />
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

      {/* Generate dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>生成卡密</DialogTitle>
          </DialogHeader>
          {!generated ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>面值（元）</Label>
                <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>生成数量</Label>
                <Input type="number" value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
              <div className="space-y-2 col-span-2">
                <Label>前缀（可选）</Label>
                <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="如 VIP" />
              </div>
              <Button className="w-full col-span-2" variant="gradient" onClick={generate}>生成</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="max-h-60 overflow-y-auto rounded-lg bg-muted/50 p-4 font-mono text-xs space-y-1">
                {generated.codes.map((code: string) => <div key={code}>{code}</div>)}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={copyAll}>
                  {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                  复制全部
                </Button>
                <Button variant="ghost" onClick={() => setGenerated(null)}>继续生成</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
