'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, QrCode, Server, Wifi, Check } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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

  useEffect(() => {
    api.get('/inbounds/mine')
      .then((res) => setNodes(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const copyLink = async (id: number, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      toast.success(t('common.copied'));
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('复制失败 / Copy failed');
    }
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
                    {trafficLimit > 0 && (
                      <div>
                        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                          <span>{t('nodes.used')}</span>
                          <span>{pct.toFixed(0)}%</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-gradient-to-r from-violet-500 to-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}

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
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
