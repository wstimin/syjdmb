'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Download, Plus } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { exportToCsv } from '@/lib/csv';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import Pagination from '@/components/shared/pagination';
import { ROLE_LABELS, ROLE_OPTIONS } from '@/lib/roles';

const EMPTY_CREATE_FORM = {
  email: '',
  password: '',
  username: '',
  role: 'USER',
  status: 'ACTIVE',
  initialBalance: '',
};

interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  role: string;
  status: string;
  balance: string;
  createdAt: string;
}

interface AdminUserDetail {
  id: number;
  email: string;
  username: string | null;
  role: string;
  status: string;
  balance: string;
  balanceFrozen: string;
  avatar: string | null;
  language: string | null;
  referralCode: string | null;
  createdAt: string;
  _count: {
    orders: number;
    inbounds: number;
    referrals: number;
  };
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [balanceAmount, setBalanceAmount] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ ...EMPTY_CREATE_FORM });

  const fetchUsers = (pg = page, lim = limit, q = search) => {
    setLoading(true);
    api.get('/users', { params: { page: pg, limit: lim, search: q || undefined } })
      .then((res) => {
        setUsers(res.data.data.users);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleSearch = (q = search) => {
    setSearch(q);
    setPage(1);
    fetchUsers(1, limit, q);
  };

  const changePage = (p: number) => {
    setPage(p);
    fetchUsers(p, limit, search);
  };

  const changeLimit = (l: number) => {
    setLimit(l);
    setPage(1);
    fetchUsers(1, l, search);
  };

  const adjustBalance = async (id: number) => {
    if (!balanceAmount) return;
    try {
      await api.post(`/users/${id}/balance`, {
        amount: Number(balanceAmount),
        description: '管理后台调整余额',
      });
      toast.success('余额已调整');
      setEditUser(null);
      setBalanceAmount('');
      fetchUsers();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const toggleStatus = async (user: AdminUser) => {
    const newStatus = user.status === 'BANNED' ? 'ACTIVE' : 'BANNED';
    try {
      await api.patch(`/users/${user.id}`, { status: newStatus });
      toast.success('状态已更新');
      fetchUsers();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const updateRole = async (user: AdminUser, role: string) => {
    if (role === user.role) return;
    try {
      await api.patch(`/users/${user.id}`, { role });
      toast.success('角色已更新');
      fetchUsers();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const submitCreate = async () => {
    if (!createForm.email.trim()) { toast.error('请填写邮箱'); return; }
    if (createForm.password.length < 6) { toast.error('密码至少 6 位'); return; }
    setCreating(true);
    try {
      await api.post('/users', {
        email: createForm.email.trim(),
        password: createForm.password,
        username: createForm.username.trim() || undefined,
        role: createForm.role,
        status: createForm.status,
        initialBalance: createForm.initialBalance ? Number(createForm.initialBalance) : undefined,
      });
      toast.success('用户创建成功');
      setCreateOpen(false);
      setCreateForm({ ...EMPTY_CREATE_FORM });
      // 新建用户按注册时间倒序排在最前，回到第一页即可看到
      setPage(1);
      fetchUsers(1, limit, '');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const fetchDetail = async (user: AdminUser) => {
    setDetailLoading(true);
    try {
      const res = await api.get(`/users/${user.id}`);
      setDetailUser(res.data.data);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'email', header: '邮箱', render: (u: AdminUser) => <span className="font-medium">{u.email}</span> },
    { key: 'username', header: '用户名', render: (u: AdminUser) => u.username || '—' },
    {
      key: 'role', header: '角色',
      render: (u: AdminUser) => (
        <select
          value={u.role}
          onChange={(e) => updateRole(u, e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      ),
    },
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
          <Button size="sm" variant="outline" onClick={() => fetchDetail(u)}>
            详情
          </Button>
          <Button size="sm" variant={u.status === 'BANNED' ? 'default' : 'destructive'} onClick={() => toggleStatus(u)}>
            {u.status === 'BANNED' ? '解封' : '封禁'}
          </Button>
        </div>
      ),
    },
  ];

  const handleExport = () => {
    exportToCsv(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username || '',
        role: u.role,
        status: u.status,
        balance: u.balance,
        createdAt: u.createdAt,
      })),
      'users',
    );
  };

  return (
    <div>
      <PageHeader title="用户管理" subtitle={`共 ${total} 位用户`}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索邮箱/用户名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
          </div>
          <Button variant="outline" onClick={() => handleSearch()}>搜索</Button>
          <Button variant="outline" onClick={handleExport}>
            <Download className="mr-1 h-4 w-4" /> 导出
          </Button>
          <Button variant="gradient" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> 新建用户
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={users} keyField="id" emptyMessage="暂无用户" />
          <Pagination page={page} limit={limit} total={total} totalPages={totalPages} onPageChange={changePage} onLimitChange={changeLimit} />
        </CardContent>
      </Card>

      {/* Create user dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>邮箱 *</Label>
              <Input value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} placeholder="user@example.com" />
            </div>
            <div className="space-y-2">
              <Label>密码 *（至少 6 位）</Label>
              <Input type="password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} placeholder="••••••" />
            </div>
            <div className="space-y-2">
              <Label>用户名（可选，默认取邮箱前缀）</Label>
              <Input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} placeholder="nickname" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>角色</Label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>状态</Label>
                <select
                  value={createForm.status}
                  onChange={(e) => setCreateForm({ ...createForm, status: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  <option value="ACTIVE">正常</option>
                  <option value="BANNED">已封禁</option>
                  <option value="SUSPENDED">已暂停</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>初始余额（可选，正数将记入账流水）</Label>
              <Input type="number" value={createForm.initialBalance} onChange={(e) => setCreateForm({ ...createForm, initialBalance: e.target.value })} placeholder="如 100" />
            </div>
            <Button className="w-full" variant="gradient" onClick={submitCreate} disabled={creating}>
              {creating ? '创建中…' : '创建用户'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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

      {/* User detail dialog */}
      <Dialog open={!!detailUser} onOpenChange={(o) => !o && setDetailUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>用户详情：{detailUser?.email}</DialogTitle>
          </DialogHeader>
          {detailLoading || !detailUser ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">ID</span><span>{detailUser.id}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">用户名</span><span>{detailUser.username || '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">角色</span><span>{ROLE_LABELS[detailUser.role] || detailUser.role}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">状态</span><span><StatusBadge status={detailUser.status} /></span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">余额</span><span className="text-primary font-medium">¥{Number(detailUser.balance).toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">冻结余额</span><span>¥{Number(detailUser.balanceFrozen).toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">邀请码</span><span>{detailUser.referralCode || '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">注册时间</span><span>{new Date(detailUser.createdAt).toLocaleString()}</span></div>
              <div className="flex justify-between border-t pt-2"><span className="text-muted-foreground">已完成订单</span><span>{detailUser._count.orders}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">服务器订阅</span><span>{detailUser._count.inbounds}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">旗下用户（推广）</span><span>{detailUser._count.referrals}</span></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
