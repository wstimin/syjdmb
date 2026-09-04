'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, Plug, Server as ServerIcon } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function ServersPage() {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '', host: '', port: '54321', protocol: 'http', apiPath: '/panel/api',
    username: '', password: '', apiToken: '', country: 'US', flag: '🇺🇸', weight: '1', maxUsers: '100', remark: '',
  });

  const fetchServers = () => {
    api.get('/servers')
      .then((res) => setServers(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchServers(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', host: '', port: '54321', protocol: 'http', apiPath: '/panel/api', username: '', password: '', apiToken: '', country: 'US', flag: '🇺🇸', weight: '1', maxUsers: '100', remark: '' });
    setDialogOpen(true);
  };

  const openEdit = (s: any) => {
    setEditing(s);
    setForm({
      name: s.name, host: s.host, port: String(s.port), protocol: s.protocol || 'http',
      apiPath: s.apiPath || '/panel/api',
      username: s.username, password: s.password, apiToken: s.apiToken || '',
      country: s.country || 'US', flag: s.flag || '🇺🇸', weight: String(s.weight),
      maxUsers: String(s.maxUsers ?? 100), remark: s.remark || '',
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name || !form.host || !form.username || !form.password) {
      toast.error('请填写必填项');
      return;
    }
    const payload = {
      name: form.name, host: form.host, port: Number(form.port), protocol: form.protocol,
      username: form.username, password: form.password, apiToken: form.apiToken || null,
      apiPath: form.apiPath || '/panel/api',
      country: form.country, flag: form.flag, weight: Number(form.weight),
      maxUsers: Number(form.maxUsers), remark: form.remark || null,
    };
    try {
      if (editing) {
        await api.put(`/servers/${editing.id}`, payload);
      } else {
        await api.post('/servers', payload);
      }
      toast.success('保存成功');
      setDialogOpen(false);
      fetchServers();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const testConn = async (id: string) => {
    setTesting(id);
    try {
      const res = await api.post(`/servers/${id}/test`);
      if (res.data.success) toast.success('连接成功');
      else toast.error(res.data.message);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该服务器？')) return;
    try {
      await api.delete(`/servers/${id}`);
      toast.success('已删除');
      fetchServers();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'name', header: '名称', render: (s: any) => <span className="font-medium">{s.flag} {s.name}</span> },
    { key: 'host', header: '地址', render: (s: any) => <span className="font-mono text-xs">{s.host}:{s.port}</span> },
    { key: 'country', header: '地区' },
    { key: 'weight', header: '权重' },
    {
      key: 'status', header: '状态',
      render: (s: any) => s.sessionId ? <span className="text-emerald-500 text-xs font-medium">● 在线</span> : <StatusBadge status={s.status} />,
    },
    {
      key: 'inbounds', header: '节点数',
      render: (s: any) => s._count?.inbounds || 0,
    },
    {
      key: 'actions', header: '操作',
      render: (s: any) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => testConn(s.id)} disabled={testing === s.id}>
            <Plug className="mr-1 h-3 w-3" />{testing === s.id ? '测试中' : '测试'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => openEdit(s)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="destructive" onClick={() => remove(s.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="服务器管理" subtitle="添加和管理 3-XUI 面板服务器">
        <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />添加服务器</Button>
      </PageHeader>

      <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
        <ServerIcon className="mr-2 inline h-4 w-4" />
        通过 XUI 面板 API 对接：添加服务器后点击「测试」验证连接，之后购买套餐将自动在该服务器上创建节点。支持 HTTP 和 HTTPS 面板。
        <code className="ml-2 rounded bg-background px-2 py-0.5 text-xs">/panel/api/*</code>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={servers} keyField="id" emptyMessage="暂无服务器" />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `编辑服务器 #${editing.id}` : '添加服务器'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>名称 *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>IP/域名 *</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="1.2.3.4" />
            </div>
            <div className="space-y-2">
              <Label>端口</Label>
              <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>协议</Label>
              <select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS（SSL）</option>
              </select>
            </div>
            <div className="space-y-2 col-span-2">
              <Label>API 路径（后缀）</Label>
              <Input
                value={form.apiPath}
                onChange={(e) => setForm({ ...form, apiPath: e.target.value })}
                placeholder="/panel/api"
              />
              <p className="text-xs text-muted-foreground">
                默认 /panel/api。若面板挂在 Nginx 反代子路径下，请填写实际路径。
              </p>
            </div>
            <div className="space-y-2">
              <Label>用户名 *</Label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>密码 *</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>API Token（可选，更稳定）</Label>
              <Input
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
                placeholder="填入后优先使用 Token 认证，不填则用用户名密码登录"
              />
              <p className="text-xs text-muted-foreground">
                在 3-XUI 面板 → Settings → Security → API Token 中生成。填入后连接更稳定，不会因 Session 过期而断开。
              </p>
            </div>
            <div className="space-y-2">
              <Label>地区代码</Label>
              <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>旗帜</Label>
              <Input value={form.flag} onChange={(e) => setForm({ ...form, flag: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>负载权重</Label>
              <Input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>最大用户数</Label>
              <Input type="number" value={form.maxUsers} onChange={(e) => setForm({ ...form, maxUsers: e.target.value })} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>备注</Label>
              <Input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
            </div>
          </div>
          <Button className="w-full" variant="gradient" onClick={save}>保存</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
