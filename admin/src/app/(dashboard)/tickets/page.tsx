'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { MessageSquare, X, RotateCcw, Search } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { StatCard } from '@/components/shared/stat-card';

const STATUS_OPTIONS = ['ALL', 'OPEN', 'PENDING', 'REPLIED', 'CLOSED'];

export default function TicketsAdminPage() {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyText, setReplyText] = useState('');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<any | null>(null);

  const fetchData = () => {
    setLoading(true);
    api.get('/tickets', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setTickets(res.data.data.tickets);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages || 1);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  const fetchStats = () => {
    api.get('/tickets/stats')
      .then((res) => setStats(res.data.data))
      .catch(() => { /* 统计接口失败时静默，保留当前显示 */ });
  };

  useEffect(() => { fetchData(); }, [page, limit, status, search]);

  useEffect(() => { fetchStats(); }, []);

  const resetPage = () => setPage(1);

  const loadMessages = async (t: any) => {
    setMessagesLoading(true);
    setMessages([]);
    try {
      // 管理端单条查询：GET /tickets/:id 返回工单 + 完整消息线程（按时间升序）
      const res = await api.get(`/tickets/${t.id}`);
      setMessages(res?.data?.data?.messages || []);
    } catch (err) {
      toast.error(getErrorMessage(err));
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  const openTicket = async (t: any) => {
    setCurrent(t);
    setReplyText('');
    await loadMessages(t);
  };

  const sendReply = async () => {
    if (!replyText || !current) return;
    try {
      await api.post(`/tickets/${current.id}/admin-reply`, { message: replyText });
      toast.success('已回复');
      setReplyText('');
      fetchData();
      await loadMessages(current);
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
      fetchStats();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const reopen = async (id: number) => {
    try {
      await api.post(`/tickets/${id}/reopen`);
      toast.success('工单已重新开启');
      setCurrent(null);
      fetchData();
      fetchStats();
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
      render: (t: any) => {
        if (t.status === 'CLOSED') {
          return <Button size="sm" variant="outline" onClick={() => reopen(t.id)}><RotateCcw className="mr-1 h-3 w-3" />重开</Button>;
        }
        return <Button size="sm" variant="outline" onClick={() => close(t.id)}><X className="mr-1 h-3 w-3" />关闭</Button>;
      },
    },
  ];

  return (
    <div>
      <PageHeader title="工单管理" subtitle={`共 ${total} 个工单`}>
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
              placeholder="搜索主题 / 用户邮箱"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchData()}
            />
          </div>
          <Button variant="outline" onClick={fetchData}>搜索</Button>
        </div>
      </PageHeader>

      {/* Statistics */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="待处理" value={stats?.pending ?? 0} color="rgb(217 119 6)" />
        <StatCard title="待回复" value={stats?.replied ?? 0} color="rgb(37 99 235)" />
        <StatCard title="处理中" value={stats?.open ?? 0} color="rgb(5 150 105)" />
        <StatCard title="已关闭" value={stats?.closed ?? 0} color="rgb(107 114 128)" />
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={tickets} keyField="id" emptyMessage="暂无工单" />
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

          {/* Message history */}
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-4">
            {messagesLoading ? (
              <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
            ) : messages.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground">暂无消息</p>
            ) : (
              messages.map((m: any, i: number) => (
                <div
                  key={m.id ?? i}
                  className={`flex flex-col ${m.sender === 'admin' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                      m.sender === 'admin'
                        ? 'bg-primary text-white'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    <div className="mb-1 text-xs opacity-80">
                      {m.sender === 'admin' ? '管理员' : '用户'} · {new Date(m.createdAt).toLocaleString()}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  </div>
                </div>
              ))
            )}
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
            {current?.status === 'CLOSED'
              ? <Button variant="outline" onClick={() => current && reopen(current.id)}><RotateCcw className="mr-1 h-3 w-3" />重开工单</Button>
              : <Button variant="outline" onClick={() => current && close(current.id)}>关闭工单</Button>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
