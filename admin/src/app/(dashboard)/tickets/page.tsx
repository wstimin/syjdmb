'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { MessageSquare, X, RotateCcw } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

export default function TicketsAdminPage() {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<any>(null);
  const [replyText, setReplyText] = useState('');

  const fetchData = () => {
    api.get('/tickets')
      .then((res) => setTickets(res.data.data.tickets))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const openTicket = async (t: any) => {
    const res = await api.get('/tickets').catch(() => null);
    // Fetch full detail with messages - we reuse the list which includes message count
    const full = await api.get('/tickets', { params: { search: t.subject } });
    setCurrent(t);
    setReplyText('');
  };

  const sendReply = async () => {
    if (!replyText || !current) return;
    try {
      await api.post(`/tickets/${current.id}/admin-reply`, { message: replyText });
      toast.success('已回复');
      setReplyText('');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const close = async (id: number) => {
    try {
      await api.post(`/tickets/${id}/close`);
      toast.success('工单已关闭');
      setCurrent(null);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'user', header: '用户', render: (t: any) => t.user?.email || '—' },
    { key: 'subject', header: '主题', render: (t: any) => <button onClick={() => openTicket(t)} className="font-medium text-primary hover:underline">{t.subject}</button> },
    { key: 'messages', header: '消息数', render: (t: any) => t._count?.messages || 0 },
    { key: 'priority', header: '优先级' },
    { key: 'status', header: '状态', render: (t: any) => <StatusBadge status={t.status} /> },
    { key: 'updatedAt', header: '更新时间', render: (t: any) => new Date(t.updatedAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (t: any) => t.status !== 'CLOSED' ? (
        <Button size="sm" variant="outline" onClick={() => close(t.id)}><X className="mr-1 h-3 w-3" />关闭</Button>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
  ];

  return (
    <div>
      <PageHeader title="工单管理" subtitle={`共 ${tickets.length} 个工单`} />
      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={tickets} keyField="id" emptyMessage="暂无工单" />
        </CardContent>
      </Card>

      {/* Reply dialog */}
      <Dialog open={!!current} onOpenChange={(o) => !o && setCurrent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              {current?.subject}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 rounded-lg bg-muted/40 p-4 text-sm">
            <p className="text-muted-foreground">用户：{current?.user?.email}</p>
            <p>优先级：{current?.priority} · <StatusBadge status={current?.status} /></p>
          </div>
          <div className="space-y-2">
            <Label>回复内容</Label>
            <textarea
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="输入回复内容..."
            />
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="gradient" onClick={sendReply}>发送回复</Button>
            <Button variant="outline" onClick={() => current && close(current.id)}>关闭工单</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
