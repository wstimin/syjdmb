'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Copy, XCircle, Check } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function CardsPage() {
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [amount, setAmount] = useState('10');
  const [count, setCount] = useState('10');
  const [prefix, setPrefix] = useState('');
  const [generated, setGenerated] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const fetchCards = () => {
    api.get('/cards', { params: { page: 1, limit: 50 } })
      .then((res) => setCards(res.data.data.cards))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchCards(); }, []);

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

  const copyAll = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated.codes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
      <PageHeader title="卡密管理" subtitle="生成和兑换卡密">
        <Button variant="gradient" onClick={() => setDialogOpen(true)}><Plus className="mr-1 h-4 w-4" />生成卡密</Button>
      </PageHeader>

      {/* Statistics */}
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">总卡密</div><div className="text-xl font-bold">{cards.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">未使用</div><div className="text-xl font-bold text-blue-600">{cards.filter((c) => c.status === 'UNUSED').length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">已使用</div><div className="text-xl font-bold text-emerald-600">{cards.filter((c) => c.status === 'USED').length}</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={cards} keyField="id" emptyMessage="暂无卡密" />
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
