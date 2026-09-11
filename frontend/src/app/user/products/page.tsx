'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Package, Copy, ShoppingCart, ArrowRight, Cable, CalendarClock, RefreshCcw, PlugZap, Check, Pencil } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import RenewSocksDialog from '@/components/renew-socks-dialog';
import EditSocksDialog from '@/components/edit-socks-dialog';

type PurchasedProduct = {
  id: number;
  orderNo: string;
  status: 'PAID' | 'COMPLETED';
  deliveryInfo: string | null;
  deliveredAt: string | null;
  payAmount: string;
  amount: string;
  createdAt: string;
  virtualProduct: {
    id: number;
    name: string;
    nameEn: string | null;
    deliveryType: 'AUTO' | 'MANUAL' | 'SOCKS_PANEL';
    price: string;
    status: 'ACTIVE' | 'HIDDEN' | 'SOLD_OUT' | 'ARCHIVED';
  } | null;
};

// SOCKS 面板节点（来自独立端点 /socks-panel/mine，与 getUserProducts 完全解耦）
type SocksNodeItem = {
  id: number;
  uuid: string;
  orderNo: string;
  virtualProductId: number | null;
  serverId: number | null;
  host: string | null;
  port: number;
  username: string;
  connectionUrl: string | null;
  expiryTime: string | null;
  createdAt: string;
  remark: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'DELETED';
  importedToOutbound?: boolean; // 已导入到 SOCKS 出站池（后端 /socks-panel/mine 计算）
  virtualProduct: { id: number; name: string; nameEn: string | null; deliveryType: string } | null;
  server: { id: number; name: string; host: string } | null;
};

type MergedItem = { kind: 'order'; order: PurchasedProduct } | { kind: 'socks'; socks: SocksNodeItem };

// ---------- 通用小函数 ----------
const socksStatus = (n: SocksNodeItem) => {
  if (n.status === 'DELETED') return <Badge variant="danger">已删除</Badge>;
  if (n.status === 'SUSPENDED') return <Badge variant="warning">已暂停</Badge>;
  if (n.status === 'EXPIRED') return <Badge variant="danger">已过期</Badge>;
  return <Badge variant="success">使用中</Badge>;
};

const expiredNow = (n: SocksNodeItem) =>
  !!n.expiryTime && new Date(n.expiryTime).getTime() <= Date.now();

export default function MyProductsPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<PurchasedProduct[]>([]);
  const [socks, setSocks] = useState<SocksNodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [renewTarget, setRenewTarget] = useState<SocksNodeItem | null>(null);
  const [editTarget, setEditTarget] = useState<SocksNodeItem | null>(null);

  useEffect(() => {
    Promise.all([
      api.get('/orders/mine/products').then((r) => r.data.data || []).catch(() => []),
      api.get('/socks-panel/mine').then((r) => r.data.data || []).catch(() => []),
    ])
      .then(([orders, socksNodes]) => {
        setItems(orders);
        setSocks(socksNodes);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }

  const copyText = (text: string, id: number) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      toast.success('已复制');
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => toast.error('复制失败 / Copy failed'));
  };

  // 一键导入到 SOCKS 出站池：后端建台账行（幂等），刷新节点列表更新「已导入出站」状态
  const handleImport = async (node: SocksNodeItem) => {
    setImportingId(node.id);
    try {
      await api.post(`/socks-panel/${node.id}/import-outbound`);
      toast.success(t('myProducts.socksImportSuccess'));
      const r = await api.get('/socks-panel/mine');
      setSocks(r.data.data || []);
    } catch (e) {
      toast.error(getErrorMessage(e) || t('myProducts.socksImportFail'));
    } finally {
      setImportingId(null);
    }
  };

  const nameOf = (p: PurchasedProduct) =>
    p.virtualProduct
      ? locale === 'en' && p.virtualProduct.nameEn ? p.virtualProduct.nameEn : p.virtualProduct.name
      : t('myProducts.gone');

  // 合并：SOCKS 面板节点按 orderNo 取代对应订单卡（同一笔购买只出一张卡），其余订单原样展示
  const nodeByOrderNo = new Map<string, SocksNodeItem>();
  for (const n of socks) nodeByOrderNo.set(n.orderNo, n);
  const merged: MergedItem[] = [
    ...items
      .filter((o) => !(o.virtualProduct?.deliveryType === 'SOCKS_PANEL' && nodeByOrderNo.has(o.orderNo)))
      .map((o) => ({ kind: 'order' as const, order: o })),
    ...socks.map((n) => ({ kind: 'socks' as const, socks: n })),
  ].sort((a, b) => {
    const ta = a.kind === 'order' ? new Date(a.order.createdAt).getTime() : new Date(a.socks.createdAt).getTime();
    const tb = b.kind === 'order' ? new Date(b.order.createdAt).getTime() : new Date(b.socks.createdAt).getTime();
    return tb - ta;
  });

  const socksStatus = (n: SocksNodeItem) => {
    if (n.status === 'SUSPENDED') return <Badge variant="warning">已暂停</Badge>;
    if (n.status === 'EXPIRED') return <Badge variant="danger">已过期</Badge>;
    return <Badge variant="success">使用中</Badge>;
  };

  const expiredNow = (n: SocksNodeItem) =>
    !!n.expiryTime && new Date(n.expiryTime).getTime() <= Date.now();

  const tsOf = (m: MergedItem) =>
    m.kind === 'order' ? new Date(m.order.createdAt).getTime() : new Date(m.socks.createdAt).getTime();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('myProducts.title')}</h1>
        </div>
        <Link href="/products">
          <Button variant="gradient" size="sm">
            <ShoppingCart className="mr-1 h-4 w-4" />
            {t('myProducts.goShop')}
          </Button>
        </Link>
      </div>

      {merged.length === 0 ? (
        <div className="py-20 text-center">
          <Package className="mx-auto h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">{t('myProducts.empty')}</p>
          <Link href="/products" className="mt-6 inline-block">
            <Button variant="gradient">
              {t('myProducts.goShop')}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {merged.map((m, idx) => (
            <motion.div key={m.kind === 'order' ? `o${m.order.id}` : `s${m.socks.id}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}>
              {m.kind === 'socks' ? (
                <SocksCard
                  socks={m.socks}
                  locale={locale}
                  copied={copiedId === m.socks.id}
                  onCopy={() => copyText(m.socks.connectionUrl || '', m.socks.id)}
                  onRenew={() => setRenewTarget(m.socks)}
                  onEdit={() => setEditTarget(m.socks)}
                  canRenew={m.socks.status === 'ACTIVE' || m.socks.status === 'EXPIRED'}
                  expiredNow={expiredNow(m.socks)}
                  importing={importingId === m.socks.id}
                  onImport={() => handleImport(m.socks)}
                  t={t}
                />
              ) : (
                <OrderCard order={m.order} copied={copiedId === m.order.id} onCopy={copyText} nameOf={nameOf} t={t} locale={locale} />
              )}
            </motion.div>
          ))}
        </div>
      )}

      <RenewSocksDialog
        socks={renewTarget}
        open={!!renewTarget}
        onClose={() => setRenewTarget(null)}
        onDone={() => {
          // 续费成功后刷新节点列表（到期日/状态已更新）
          api.get('/socks-panel/mine').then((r) => setSocks(r.data.data || [])).catch(() => {});
        }}
      />

      <EditSocksDialog
        socks={editTarget}
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        onDone={() => {
          // 修改成功后刷新节点列表（备注/账号/连接串已更新）
          api.get('/socks-panel/mine').then((r) => setSocks(r.data.data || [])).catch(() => {});
        }}
      />
    </div>
  );
}

// ---------- SOCKS 面板节点卡 ----------
function SocksCard({ socks, locale, copied, onCopy, onRenew, onEdit, canRenew, expiredNow, importing, onImport, t }: {
  socks: SocksNodeItem;
  locale: string;
  copied: boolean;
  onCopy: () => void;
  onRenew: () => void;
  onEdit: () => void;
  canRenew: boolean;
  expiredNow: boolean;
  importing: boolean;
  onImport: () => void;
  t: (k: string) => string;
}) {
  const name = socks.virtualProduct
    ? (locale === 'en' && socks.virtualProduct.nameEn ? socks.virtualProduct.nameEn : socks.virtualProduct.name)
    : t('myProducts.gone');
  const serverName = socks.server?.name || `#${socks.serverId}`;
  const sockLabel = locale === 'en' ? 'SOCKS Node' : 'SOCKS 节点';
  // 仅 ACTIVE 且未导入过时可导入；导入为快照（节点过期/删除不影响已导入条目）
  const canImport = socks.status === 'ACTIVE' && !socks.importedToOutbound;
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 font-medium">
                <Cable className="h-4 w-4 text-primary" />
                {name}
              </span>
              <Badge variant="default">{t('myProducts.socksBadge')}</Badge>
              {socksStatus(socks)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{serverName} · :{socks.port}</span>
              <span>{socks.orderNo}</span>
              {socks.remark && socks.remark !== socks.orderNo ? <span className="text-foreground/80">「{socks.remark}」</span> : null}
            </div>

            {/* 到期时间：过期高亮 + 宽限期提示（续费按钮旁） */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5" />
                {t('myProducts.socksExpiresAt')}：
                <span className={expiredNow ? 'font-semibold text-amber-600' : 'font-medium'}>{socks.expiryTime ? new Date(socks.expiryTime).toLocaleString() : '—'}</span>
              </span>
            </div>
            {expiredNow && (
              <p className="mt-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600">
                {t('myProducts.socksGraceNote')}
              </p>
            )}

            {/* 连接串 */}
            <div className="mt-2.5 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">socks5://…</span>
                <div className="flex items-center gap-3">
                  {canImport && (
                    <button
                      onClick={onImport}
                      disabled={importing}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary underline hover:text-primary/80 disabled:cursor-not-allowed disabled:text-primary/50"
                    >
                      <PlugZap className="h-3 w-3" />
                      {importing ? t('myProducts.socksImporting') : t('myProducts.socksImportToOutbound')}
                    </button>
                  )}
                  {socks.importedToOutbound && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                      <Check className="h-3 w-3" />
                      {t('myProducts.socksImportedToOutbound')}
                    </span>
                  )}
                  <button
                    onClick={onCopy}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary underline hover:text-primary/80"
                  >
                    <Copy className="h-3 w-3" />
                    {copied ? (locale === 'en' ? 'Copied' : '已复制') : t('myProducts.socksCopy')}
                  </button>
                </div>
              </div>
              <pre className="mt-1 truncate whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                {socks.connectionUrl}
              </pre>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onEdit}
                disabled={socks.status === 'SUSPENDED' || expiredNow}
                title={socks.status === 'SUSPENDED' || expiredNow ? '该节点已暂停或已过期，如需修改请先续费' : '修改备注 / 账号密码'}
              >
                <Pencil className="mr-1 h-3 w-3" />
                {t('myProducts.socksEdit')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onRenew}
                disabled={!canRenew}
                title={socks.status === 'SUSPENDED' ? '该节点已被管理员暂停' : t('myProducts.socksRenew')}
              >
                <RefreshCcw className="mr-1 h-3 w-3" />
                {t('myProducts.socksRenew')}
              </Button>
              <Link href="/user/orders">
                <Button size="sm" variant="ghost">{t('myProducts.viewOrders')}</Button>
              </Link>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- 普通订单（AUTO / MANUAL / 尚无节点的 SOCKS 单）卡 ----------
function OrderCard({ order, copied, onCopy, nameOf, t, locale }: {
  order: PurchasedProduct;
  copied: boolean;
  onCopy: (text: string, id: number) => void;
  nameOf: (o: PurchasedProduct) => string;
  t: (k: string) => string;
  locale: string;
}) {
  return (
    <Card className="border-border/60">
      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{nameOf(order)}</span>
            {order.virtualProduct && (
              <Badge
                variant={
                  order.virtualProduct.deliveryType === 'AUTO'
                    ? 'success'
                    : order.virtualProduct.deliveryType === 'SOCKS_PANEL'
                      ? 'default'
                      : 'warning'
                }
              >
                {order.virtualProduct.deliveryType === 'AUTO'
                  ? (locale === 'en' ? 'Auto delivery' : '自动发货')
                  : order.virtualProduct.deliveryType === 'SOCKS_PANEL'
                    ? t('products.deliverySocks')
                    : (locale === 'en' ? 'Manual delivery' : '人工发货')}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {order.orderNo} · {new Date(order.createdAt).toLocaleString()}
          </div>

          {order.deliveryInfo ? (
            <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-600">
                  {order.virtualProduct?.deliveryType === 'AUTO'
                    ? (locale === 'en' ? 'Delivered automatically' : '已自动发货')
                    : (locale === 'en' ? 'Delivered' : '已发货')}
                  {order.deliveredAt && (
                    <span className="ml-1 text-muted-foreground">· {new Date(order.deliveredAt).toLocaleString()}</span>
                  )}
                </span>
                <button
                  onClick={() => onCopy(order.deliveryInfo || '', order.id)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary underline hover:text-primary/80"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? '已复制' : '复制交付内容'}
                </button>
              </div>
              <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                {order.deliveryInfo}
              </pre>
            </div>
          ) : order.virtualProduct?.deliveryType === 'SOCKS_PANEL' ? (
            order.status === 'COMPLETED' ? (
              <span className="mt-2 inline-flex items-center rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-600 ring-1 ring-rose-500/30">
                {locale === 'en'
                  ? 'Node deleted / expired, please purchase the product again'
                  : '节点已删除 / 已失效，如需使用请重新购买'}
              </span>
            ) : (
              <span className="mt-2 inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 ring-1 ring-blue-500/30">
                {locale === 'en' ? 'SOCKS node provisioning…' : 'SOCKS 节点创建中…'}
              </span>
            )
          ) : (
            <span className="mt-2 inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 ring-1 ring-amber-500/30">
              {t('myProducts.awaitingDelivery')}
            </span>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          <span className="font-semibold text-primary">¥{Number(order.payAmount ?? order.amount)}</span>
          <div className="flex gap-2">
            {order.virtualProduct && order.virtualProduct.status === 'ACTIVE' ? (
              <Link href={`/purchase?product=${order.virtualProduct.id}`}>
                <Button size="sm" variant="outline">{t('myProducts.buyAgain')}</Button>
              </Link>
            ) : order.virtualProduct ? (
              <span className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                {t('myProducts.gone')}
              </span>
            ) : null}
            <Link href="/user/orders">
              <Button size="sm" variant="ghost">{t('myProducts.viewOrders')}</Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}