'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Package, XCircle, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';

const STATUS_VARIANT: Record<string, any> = {
  COMPLETED: 'success',
  PENDING: 'warning',
  PAID: 'warning',
  PROCESSING: 'warning',
  REFUNDED: 'secondary',
  CANCELLED: 'secondary',
  FAILED: 'danger',
};
const STATUS_LABEL: Record<string, string> = {
  COMPLETED: '已完成',
  PENDING: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  REFUNDED: '已退款',
  CANCELLED: '已取消',
  FAILED: '失败',
};
const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: '退款申请审核中',
  APPROVED: '已退款',
  REJECTED: '退款申请被拒',
  CANCELLED: '退款申请已撤销',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const limit = 10;
  // 申请退款弹窗
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchOrders = (p = page) => {
    setLoading(true);
    api.get(`/orders/mine?page=${p}&limit=${limit}`)
      .then((res) => {
        setOrders(res.data.data.orders);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(1); }, []);

  const cancelOrder = async (id: number) => {
    if (!confirm('确认取消该未支付订单？')) return;
    try {
      await api.post(`/orders/${id}/cancel-self`);
      toast.success('订单已取消');
      fetchOrders(page);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 最近一条退款申请（后端按 createdAt 倒序返回）；没有则视为 null
  const latestRefund = (order: any) =>
    Array.isArray(order.refundRequests) && order.refundRequests.length > 0
      ? order.refundRequests[0]
      : null;

  // 可申请退款：已完成 + 非续费单 + 无 PENDING 申请（被拒/已撤销后可重新申请）
  const canApplyRefund = (order: any) => {
    if (order.status !== 'COMPLETED') return false;
    if (order.renewalOfInboundId) return false;
    const req = latestRefund(order);
    return !req || req.status !== 'PENDING';
  };

  const applyRefund = async () => {
    if (!refundTarget) return;
    if (!reason.trim()) {
      toast.error('请填写退款理由');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/refunds', { orderId: refundTarget.id, reason: reason.trim() });
      toast.success('退款申请已提交，请等待管理员审核');
      setRefundTarget(null);
      setReason('');
      fetchOrders(page);
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-20 w-full" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">我的订单</h1>
        <span className="text-sm text-muted-foreground">共 {total} 单</span>
      </div>

      {orders.length === 0 ? (
        <div className="py-20 text-center">
          <Package className="mx-auto h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">暂无订单 / No orders</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {orders.map((order, idx) => {
              const refund = latestRefund(order);
              return (
                <motion.div key={order.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}>
                  <Card className="border-border/60">
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="font-medium">{order.virtualProduct?.name || order.plan?.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{order.orderNo}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {new Date(order.createdAt).toLocaleString()}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {order.payMethod && <span>支付方式：{order.payMethod}</span>}
                          {order.relayEnabled && <span className="text-violet-500">含 SOCKS 出站</span>}
                          {order.protocol && <span>协议：{order.protocol}</span>}
                          {order.renewalOfInbound && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-500">
                              续费单 · {order.renewalOfInbound.server?.name || order.renewalOfInbound.remark || '节点'}
                            </span>
                          )}
                          {order.coupon && (
                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-500">
                              已用优惠券 {order.coupon.code}
                            </span>
                          )}
                          {refund && refund.status !== 'PENDING' && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                              {REFUND_STATUS_LABEL[refund.status] || refund.status}
                            </span>
                          )}
                        </div>
                        {/* 虚拟商品交付：AUTO 自动发码 / MANUAL 人工发货 */}
                        {order.virtualProduct && (
                          <div className="mt-2">
                            {order.deliveryInfo ? (
                              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium text-emerald-600">
                                    {order.virtualProduct.deliveryType === 'AUTO' ? '已自动发货' : '已发货'}
                                    {order.deliveredAt && (
                                      <span className="ml-1 text-muted-foreground">
                                        · {new Date(order.deliveredAt).toLocaleString()}
                                      </span>
                                    )}
                                  </span>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(order.deliveryInfo || '');
                                      toast.success('交付内容已复制');
                                    }}
                                    className="text-xs font-medium text-primary underline hover:text-primary/80"
                                  >
                                    复制交付内容
                                  </button>
                                </div>
                                <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                                  {order.deliveryInfo}
                                </pre>
                              </div>
                            ) : order.status === 'COMPLETED' && order.virtualProduct.deliveryType === 'MANUAL' ? (
                              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 ring-1 ring-amber-500/30">
                                等待发货 · 商家将尽快填写交付内容
                              </span>
                            ) : null}
                          </div>
                        )}
                        {/* 拒绝原因展示：用户能看到为什么被拒，且不影响重新申请 */}
                        {refund?.status === 'REJECTED' && refund.adminNote && (
                          <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-600">
                            退款申请被拒绝，理由：{refund.adminNote}
                          </div>
                        )}
                        {order.renewalOfInbound && (
                          <div className="mt-1.5 text-xs text-muted-foreground">
                            续费订单不支持退款，费用问题请联系客服处理
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-primary">
                            {Number(order.payAmount ?? order.amount) < Number(order.amount) ? (
                              <>
                                ¥{Number(order.payAmount ?? order.amount)}
                                <span className="ml-1 text-xs text-muted-foreground line-through">¥{Number(order.amount)}</span>
                              </>
                            ) : (
                              `¥${Number(order.amount)}`
                            )}
                          </span>
                          <Badge variant={STATUS_VARIANT[order.status] || 'secondary'}>
                            {STATUS_LABEL[order.status] || order.status}
                          </Badge>
                        </div>
                        {order.status === 'PENDING' || order.status === 'FAILED' ? (
                          <button
                            onClick={() => cancelOrder(order.id)}
                            className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-destructive"
                          >
                            <XCircle className="h-3.5 w-3.5" />取消订单
                          </button>
                        ) : refund?.status === 'PENDING' ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            已申请退款（待审核）
                          </span>
                        ) : canApplyRefund(order) ? (
                          <button
                            onClick={() => { setRefundTarget(order); setReason(''); }}
                            className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:text-primary/80"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />申请退款
                          </button>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t pt-4">
              <span className="text-xs text-muted-foreground">第 {page}/{totalPages} 页</span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => { const p = page - 1; setPage(p); fetchOrders(p); }}
                  className="rounded-md border px-3 py-1 text-sm disabled:opacity-40"
                >
                  上一页
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => { const p = page + 1; setPage(p); fetchOrders(p); }}
                  className="rounded-md border px-3 py-1 text-sm disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* 申请退款弹窗（含关键披露：退款去向 / 节点停用 / 券回收） */}
      <Dialog open={!!refundTarget} onOpenChange={(o) => !o && setRefundTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>申请退款</DialogTitle>
            <DialogDescription>
              订单 {refundTarget?.orderNo} · 退款金额 ¥{Number(refundTarget?.payAmount ?? refundTarget?.amount ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="请说明退款理由（必填，管理员审核时可见）"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <p>· 退款将退回<b>账户余额</b>（非原支付渠道，不可提现）</p>
              <p>· 审核通过后，该订单对应的节点将<b>被暂停</b></p>
              <p>· 使用的优惠券名额将回收，可用于其他订单</p>
              <p>· 一次最多同时有 5 条待审核申请</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRefundTarget(null)}>取消</Button>
              <Button size="sm" onClick={applyRefund} disabled={submitting}>
                {submitting ? '提交中...' : '提交申请'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}