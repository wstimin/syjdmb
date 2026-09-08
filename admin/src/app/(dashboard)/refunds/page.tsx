'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { PageHeader, DataTable } from '@/components/shared/data-table';
import Pagination from '@/components/shared/pagination';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_OPTIONS = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

// 退款申请自身的状态口径（不同于订单状态，独立映射）
const REFUND_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: '待审核', cls: 'bg-amber-500/15 text-amber-600' },
  APPROVED: { label: '已退款', cls: 'bg-emerald-500/15 text-emerald-600' },
  REJECTED: { label: '已拒绝', cls: 'bg-red-500/15 text-red-600' },
  CANCELLED: { label: '已撤销', cls: 'bg-gray-500/15 text-gray-600' },
};
const RefundBadge = ({ status }: { status: string }) => {
  const s = REFUND_STATUS[status] || { label: status, cls: 'bg-gray-500/15 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
};

export default function RefundsPage() {
  const [refunds, setRefunds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // 审批弹窗
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [rejectTarget, setRejectTarget] = useState<any>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchRefunds = () => {
    setLoading(true);
    api.get('/refunds', {
      params: {
        page,
        limit,
        status: status === 'ALL' ? undefined : status,
        search: search || undefined,
      },
    })
      .then((res) => {
        setRefunds(res.data.data.list);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRefunds(); }, [page, limit, status]);

  const resetPage = () => setPage(1);

  const approve = async () => {
    if (!approveTarget) return;
    setBusy(true);
    try {
      await api.post(`/refunds/${approveTarget.id}/approve`);
      toast.success(`已退款 ¥${Number(approveTarget.amount)} 至用户余额，节点将暂停`);
      setApproveTarget(null);
      fetchRefunds();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!rejectTarget) return;
    if (!note.trim()) {
      toast.error('请填写审批意见');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/refunds/${rejectTarget.id}/reject`, { note: note.trim() });
      toast.success('已拒绝该退款申请');
      setRejectTarget(null);
      setNote('');
      fetchRefunds();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-64 w-full" /></div>;

  const columns = [
    { key: 'orderNo', header: '订单号', render: (r: any) => <span className="font-mono text-xs">{r.order?.orderNo || '—'}</span> },
    { key: 'user', header: '用户', render: (r: any) => r.user?.email || '—' },
    { key: 'plan', header: '套餐', render: (r: any) => r.order?.plan?.name || '—' },
    // 退款金额 = 订单实付快照（payAmount ?? amount），钱从平台出，显示红负
    { key: 'amount', header: '退款金额', render: (r: any) => <span className="font-medium text-red-500">-¥{Number(r.amount)}</span> },
    { key: 'reason', header: '申请理由', render: (r: any) => (
        <span className="block max-w-[220px] truncate" title={r.reason}>{r.reason}</span>
      ) },
    { key: 'status', header: '状态', render: (r: any) => <RefundBadge status={r.status} /> },
    { key: 'createdAt', header: '申请时间', render: (r: any) => new Date(r.createdAt).toLocaleString() },
    { key: 'adminNote', header: '审批备注', render: (r: any) => r.adminNote ? (
        <span className="block max-w-[220px] truncate text-xs text-amber-600" title={r.adminNote}>{r.adminNote}</span>
      ) : <span className="text-xs text-muted-foreground">—</span> },
    {
      key: 'actions', header: '操作',
      render: (r: any) => r.status === 'PENDING' ? (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setApproveTarget(r)} disabled={busy}>
            <CheckCircle2 className="mr-1 h-3 w-3" />批准
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setRejectTarget(r); setNote(''); }} disabled={busy}>
            <XCircle className="mr-1 h-3 w-3" />拒绝
          </Button>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="退款管理" subtitle={`共 ${total} 条退款申请`}>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); resetPage(); }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'ALL' ? '全部状态' : (REFUND_STATUS[s]?.label || s)}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-64 pl-10"
              placeholder="搜索订单号/邮箱"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchRefunds()}
            />
          </div>
          <Button variant="outline" onClick={() => fetchRefunds()}>搜索</Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={refunds} keyField="id" emptyMessage="暂无退款申请" />
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

      {/* 批准确认弹窗：审批即退钱——明示去向与后果，防误点 */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && !busy && setApproveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />确认退款审批
            </DialogTitle>
            <DialogDescription>
              订单 {approveTarget?.order?.orderNo} · 用户 {approveTarget?.user?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <p>
              将向用户账户余额退回{' '}
              <b className="text-red-500">¥{Number(approveTarget?.amount ?? 0)}</b>
              {approveTarget?.order?.plan?.name ? `（${approveTarget.order.plan.name}）` : ''}
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>该订单对应的节点将<b>被暂停</b></li>
              <li>使用的优惠券名额将回收</li>
              <li>此操作不可撤销</li>
            </ul>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setApproveTarget(null)} disabled={busy}>取消</Button>
            <Button size="sm" onClick={approve} disabled={busy}>
              {busy ? '处理中...' : '确认退款'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 拒绝弹窗：备注必填（用户与邮件都会看到） */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && !busy && setRejectTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>拒绝退款申请</DialogTitle>
            <DialogDescription>
              订单 {rejectTarget?.order?.orderNo} · 退款金额 ¥{Number(rejectTarget?.amount ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="请填写审批意见（必填，用户与邮件都会看到该备注）"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRejectTarget(null)} disabled={busy}>取消</Button>
              <Button size="sm" variant="destructive" onClick={reject} disabled={busy}>
                {busy ? '处理中...' : '确认拒绝'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}