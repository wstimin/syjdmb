'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Package, Copy, ShoppingCart, ArrowRight } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

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
    deliveryType: 'AUTO' | 'MANUAL';
    price: string;
    status: 'ACTIVE' | 'HIDDEN' | 'SOLD_OUT' | 'ARCHIVED';
  } | null;
};

export default function MyProductsPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<PurchasedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    api.get('/orders/mine/products')
      .then((res) => setItems(res.data.data || []))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }

  const copyDelivery = (order: PurchasedProduct) => {
    navigator.clipboard.writeText(order.deliveryInfo || '').then(() => {
      setCopiedId(order.id);
      toast.success('交付内容已复制');
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => toast.error('复制失败 / Copy failed'));
  };

  const nameOf = (p: PurchasedProduct) =>
    p.virtualProduct
      ? locale === 'en' && p.virtualProduct.nameEn ? p.virtualProduct.nameEn : p.virtualProduct.name
      : t('myProducts.gone');

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

      {items.length === 0 ? (
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
          {items.map((order, idx) => (
            <motion.div key={order.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}>
              <Card className="border-border/60">
                <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{nameOf(order)}</span>
                      {order.virtualProduct && (
                        <Badge variant={order.virtualProduct.deliveryType === 'AUTO' ? 'success' : 'warning'}>
                          {order.virtualProduct.deliveryType === 'AUTO'
                            ? (locale === 'en' ? 'Auto delivery' : '自动发货')
                            : (locale === 'en' ? 'Manual delivery' : '人工发货')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {order.orderNo} · {new Date(order.createdAt).toLocaleString()}
                    </div>

                    {/* 交付内容：AUTO 已发码 / MANUAL 已发货 → 展示；MANUAL 未发货 → 等待发货 */}
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
                            onClick={() => copyDelivery(order)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary underline hover:text-primary/80"
                          >
                            <Copy className="h-3 w-3" />
                            {copiedId === order.id ? '已复制' : '复制交付内容'}
                          </button>
                        </div>
                        <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                          {order.deliveryInfo}
                        </pre>
                      </div>
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
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}