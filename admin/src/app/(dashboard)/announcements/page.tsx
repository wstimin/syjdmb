'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, DataTable, StatusBadge } from '@/components/shared/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function AnnouncementsPage() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({ title: '', titleEn: '', content: '', contentEn: '' });

  const fetchData = () => {
    api.get('/announcements')
      .then((res) => setList(res.data.data.announcements))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ title: '', titleEn: '', content: '', contentEn: '' });
    setDialogOpen(true);
  };

  const openEdit = (a: any) => {
    setEditing(a);
    setForm({ title: a.title, titleEn: a.titleEn || '', content: a.content, contentEn: a.contentEn || '' });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.title) { toast.error('标题必填'); return; }
    const payload = {
      title: form.title, titleEn: form.titleEn || null,
      content: form.content, contentEn: form.contentEn || null,
      type: 'INFO', isActive: true,
    };
    try {
      if (editing) await api.put(`/announcements/${editing.id}`, payload);
      else await api.post('/announcements', payload);
      toast.success('保存成功');
      setDialogOpen(false);
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确认删除？')) return;
    try {
      await api.delete(`/announcements/${id}`);
      toast.success('已删除');
      fetchData();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'id', header: 'ID' },
    { key: 'title', header: '标题', render: (a: any) => <span className="font-medium">{a.title}</span> },
    { key: 'type', header: '类型' },
    { key: 'isPinned', header: '置顶', render: (a: any) => a.isPinned ? '✅' : '—' },
    { key: 'createdAt', header: '创建时间', render: (a: any) => new Date(a.createdAt).toLocaleString() },
    {
      key: 'actions', header: '操作',
      render: (a: any) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(a)}><Pencil className="h-3 w-3" /></Button>
          <Button size="sm" variant="destructive" onClick={() => remove(a.id)}><Trash2 className="h-3 w-3" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="公告管理" subtitle="发布系统公告">
        <Button variant="gradient" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />发布公告</Button>
      </PageHeader>
      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={list} keyField="id" emptyMessage="暂无公告" />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? '编辑公告' : '发布公告'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>标题（中文）*</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>标题（英文）</Label>
              <Input value={form.titleEn} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>内容（中文）</Label>
              <textarea className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>内容（英文）</Label>
              <textarea className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2" value={form.contentEn} onChange={(e) => setForm({ ...form, contentEn: e.target.value })} />
            </div>
            <Button className="w-full" variant="gradient" onClick={save}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
