'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, QrCode, Server, Wifi, Check, Network, Loader2, RotateCcw } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, copyToClipboard } from '@/lib/utils';
import RenewNodeDialog from '@/components/renew-node-dialog';

const STATUS_MAP: Record<string, any> = {
  ACTIVE: { label: '活跃', variant: 'success' },
  EXPIRED: { label: '已过期', variant: 'danger' },
  SUSPENDED: { label: '已暂停', variant: 'warning' },
};

export default function NodesPage() {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // SOCKS 中转（后期挂载）
  const [socksList, setSocksList] = useState<any[]>([]);
  const [relayDialogId, setRelayDialogId] = useState<number | null>(null);
  const [relaySocksId, setRelaySocksId] = useState<number | null>(null);
  const [relayBusy, setRelayBusy] = useState(false);

  // 实时流量
  const [trafficBusy, setTrafficBusy] = useState<number | null>(null);

  // 续费弹窗（到期时间或流量额度存在才可续）
  const [renewNode, setRenewNode] = useState<any>(null);

  useEffect(() => {
    api.get('/inbounds/mine')
      .then((res) => setNodes(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const copyLink = async (id: number, url: string) => {
    // copyToClipboard 自带 HTTP 兜底（非 https 下 navigator.clipboard 不可用）
    const ok = await copyToClipboard(url);
    if (!ok) {
      toast.error('复制失败 / Copy failed');
      return;
    }
    setCopiedId(id);
    toast.success(t('common.copied'));
    setTimeout(() => setCopiedId(null), 2000);
  };

  // 打开「挂载 SOCKS」弹窗时加载用户台账
  const openRelayDialog = async (nodeId: number) => {
    setRelayDialogId(nodeId);
    setRelaySocksId(null);
    try {
      const res = await api.get('/socks/mine');
      setSocksList((res.data.data || []).filter((p: any) => p.status === 'ACTIVE'));
    } catch (err) {
      toast.error(getErrorMessage(err));
      setSocksList([]);
    }
  };

  const attachRelay = async (nodeId: number) => {
    if (!relaySocksId) {
      toast.error('请选择一个 SOCKS 代理');
      return;
    }
    setRelayBusy(true);
    try {
      await api.post(`/inbounds/mine/${nodeId}/relay`, { socksId: relaySocksId });
      toast.success('中转已挂载');
      setRelayDialogId(null);
      refetch();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setRelayBusy(false);
    }
  };

  const detachRelay = async (nodeId: number) => {
    if (!confirm('确认卸载该节点的 SOCKS 中转？')) return;
    try {
      await api.delete(`/inbounds/mine/${nodeId}/relay`);
      toast.success('中转已卸载');
      refetch();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  // 实时流量刷新
  const fetchTraffic = async (nodeId: number) => {
    setTrafficBusy(nodeId);
    try {
      const res = await api.get(`/inbounds/mine/${nodeId}/traffic`);
      const d = res.data.data;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, totalTraffic: d.total, trafficLimit: d.trafficLimit }
            : n,
        ),
      );
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setTrafficBusy(null);
    }
  };

  const refetch = () => {
    api.get('/inbounds/mine')
      .then((res) => setNodes(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)));
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('nodes.title')}</h1>
        <Link href="/products">
          <Button variant="gradient" size="sm">+ {t('nodes.buyNow')}</Button>
        </Link>
      </div>

      {nodes.length === 0 ? (
        <div className="py-20 text-center">
          <Server className="mx-auto h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">{t('nodes.empty')}</p>
          <Link href="/products" className="mt-6 inline-block">
            <Button variant="gradient">{t('nodes.buyNow')}</Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {nodes.map((node, idx) => {
            const status = STATUS_MAP[node.status] || { label: node.status, variant: 'secondary' };
            const trafficUsed = Number(node.totalTraffic) || 0;
            const trafficLimit = Number(node.trafficLimit) || 0;
            const pct = trafficLimit > 0 ? Math.min(100, (trafficUsed / trafficLimit) * 100) : 0;

            return (
              <motion.div
                key={node.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
              >
                <Card className="h-full border-border/60 transition-all hover:shadow-lg">
                  <CardContent className="space-y-4 p-6">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-primary">
                          <Wifi className="h-5 w-5 text-white" />
                        </div>
                        <div>
                          <div className="font-semibold">{node.server?.name}</div>
                          <div className="text-xs text-muted-foreground">{node.protocol}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        {node.protocol === 'vless' && node.realityDest && (
                          <Badge variant="secondary" className="bg-violet-500/15 text-violet-500 border-violet-500/30">Reality</Badge>
                        )}
                        {node.relayEnabled && <Badge variant="success">中转</Badge>}
                      </div>
                    </div>

                    {/* Info */}
                    <div className="grid grid-cols-3 gap-2 text-center text-sm">
                      <div className="rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('nodes.port')}</div>
                        <div className="font-medium">{node.port}</div>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">{t('nodes.used')}</div>
                        <div className="font-medium">{(trafficUsed / 1024 / 1024 / 1024).toFixed(1)}GB</div>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2">
                        <div className="text-muted-foreground">📍 {node.server?.country || '—'}</div>
                        <div className="font-medium">{node.server?.flag || ''}</div>
                      </div>
                    </div>

                    {/* Usage bar */}
                    <div>
                      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t('nodes.used')} {trafficBusy === node.id && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}</span>
                        <button
                          onClick={() => fetchTraffic(node.id)}
                          disabled={trafficBusy === node.id}
                          className="font-medium text-primary hover:underline disabled:opacity-50"
                        >
                          刷新
                        </button>
                      </div>
                      {trafficLimit > 0 ? (
                        <>
                          <div className="mb-1 text-xs">
                            {(trafficUsed / 1024 / 1024 / 1024).toFixed(2)}GB / {(trafficLimit / 1024 / 1024 / 1024).toFixed(2)}GB
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-gradient-to-r from-violet-500 to-blue-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          不限流量 · 已用 {(trafficUsed / 1024 / 1024 / 1024).toFixed(2)}GB
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => copyLink(node.id, node.connectionUrl)}
                        disabled={!node.connectionUrl}
                      >
                        {copiedId === node.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        {copiedId === node.id ? t('common.copied') : t('nodes.copyLink')}
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button size="sm" variant="outline" disabled={!node.qrData}>
                            <QrCode className="h-4 w-4" />
                            {t('nodes.viewQR')}
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="flex flex-col items-center">
                          <DialogHeader>
                            <DialogTitle>{node.server?.name} - {node.protocol}</DialogTitle>
                          </DialogHeader>
                          <div className="rounded-xl bg-white p-4">
                            <QRCodeSVG value={node.qrData || node.connectionUrl} size={220} />
                          </div>
                        </DialogContent>
                      </Dialog>
                      {/* 续费/续流量：不限时且不限流量的节点无法续，隐藏按钮 */}
                      {node.expiryTime || Number(node.trafficLimit) > 0 ? (
                        <Button size="sm" variant="gradient" onClick={() => setRenewNode(node)}>
                          <RotateCcw className="h-4 w-4" />
                          {t('nodes.renew')}
                        </Button>
                      ) : null}
                    </div>

                    {/* SOCKS 中转（后期挂载/卸载） */}
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Network className="h-4 w-4" />
                        {node.relayEnabled ? (
                          <span>中转出口：<span className="font-mono text-foreground">{node.relaySocksHost || '—'}:{node.relaySocksPort || ''}</span></span>
                        ) : (
                          <span>未开启中转</span>
                        )}
                      </div>
                      {node.relayEnabled ? (
                        <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => detachRelay(node.id)}>
                          卸载中转
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => openRelayDialog(node.id)} disabled={node.status !== 'ACTIVE'}>
                          <Network className="mr-1 h-3 w-3" />挂载 SOCKS
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* 挂载 SOCKS 中转 弹窗 */}
      <Dialog open={relayDialogId !== null} onOpenChange={(open) => !open && setRelayDialogId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>挂载 SOCKS 中转</DialogTitle>
          </DialogHeader>
          {socksList.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <Network className="mx-auto mb-2 h-10 w-10 text-muted-foreground/30" />
              <p>你还没有添加 SOCKS 代理</p>
              <Link href="/user/socks" className="mt-3 inline-block font-medium text-primary underline">
                去「我的 SOCKS」添加
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                节点流量将全程经所选 SOCKS 代理转发，出口 IP 为该代理地址。
              </p>
              <div className="flex flex-col gap-2">
                {socksList.map((p: any) => {
                  const active = relaySocksId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setRelaySocksId(p.id)}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        active ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent'
                      }`}
                    >
                      <span className="font-medium">{p.remark || `${p.host}:${p.port}`}</span>
                      <span className="font-mono text-xs text-muted-foreground">{p.host}:{p.port}</span>
                    </button>
                  );
                })}
              </div>
              <Button
                className="w-full"
                variant="gradient"
                disabled={!relaySocksId || relayBusy}
                onClick={() => relayDialogId && attachRelay(relayDialogId)}
              >
                {relayBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Network className="mr-2 h-4 w-4" />}
                挂载中转
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 续费 / 续流量 弹窗 */}
      <RenewNodeDialog
        node={renewNode}
        open={renewNode !== null}
        onClose={() => setRenewNode(null)}
        onDone={refetch}
      />
    </div>
  );
}
