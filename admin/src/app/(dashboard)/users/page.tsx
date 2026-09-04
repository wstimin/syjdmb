'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  role: string;
  status: string;
  balance: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [balanceAmount, setBalanceAmount] = useState('');

  const fetchUsers = (q = '') => {
    setLoading(true);
    api.get('/users', { params: { page: 1, limit: 50, search: q } })
      .then((res) => setUsers(res.data.data.users))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchUsers(); }, []);

  const adjustBalance = async (id: number) => {
    if (!balanceAmount) return;
    try {
      await api.post(`/users/${id}/balance`, {
        amount: Number(balanceAmount),
        description: 'Admin adjustment',
      });
      toast.success('余额已调整 / Balance adjusted');
      setEditUser(null);
      setBalanceAmount('');
      fetchUsers(search);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const toggleStatus = async (user: AdminUser) => {
    const newStatus = user.status === 'BANNED' ? 'ACTIVE' : 'BANNED';
    try {
      await api.patch(`/users/${user.id}`, { status: newStatus });
      toast.success('状态已更新');
      fetchUsers(search);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'email', header: '邮箱', render: (u: AdminUser) => <span className="font-medium">{u.email}</span> },
    { key: 'username', header: '用户名', render: (u: AdminUser) => u.username || '—' },
    { key: 'role', header: '角色' },
    { key: 'status', header: '状态', render: (u: AdminUser) => <StatusBadge status={u.status} /> },
    { key: 'balance', header: '余额', render: (u: AdminUser) => <span className="text-primary font-medium">¥{Number(u.balance).toFixed(2)}</span> },
    { key: 'createdAt', header: '注册时间', render: (u: AdminUser) => new Date(u.createdAt).toLocaleDateString() },
    {
      key: 'actions', header: '操作',
      render: (u: AdminUser) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setEditUser(u); setBalanceAmount(''); }}>
            余额调整
          </Button>
          <Button size="sm" variant={u.status === 'BANNED' ? 'default' : 'destructive'} onClick={() => toggleStatus(u)}>
            {u.status === 'BANNED' ? '解封' : '封禁'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="用户管理" subtitle={`共 ${users.length} 位用户`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索邮箱/用户名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers(search)}
            />
          </div>
          <Button variant="outline" onClick={() => fetchUsers(search)}>搜索</Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={users} keyField="id" emptyMessage="暂无用户" />
        </CardContent>
      </Card>

      {/* Balance adjust dialog */}
      <Dialog open={!!editUser} onOpenChange={(o) => !o && setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整余额：{editUser?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>金额（正数充值，负数扣费）</Label>
              <Input type="number" value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} placeholder="如 100 或 -50" />
            </div>
            <Button className="w-full" variant="gradient" onClick={() => adjustBalance(editUser!.id)}>
              确认调整
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
