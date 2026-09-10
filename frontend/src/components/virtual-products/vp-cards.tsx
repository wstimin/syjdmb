'use client';

import { useRouter } from 'next/navigation';
import { Store, Zap, Timer, CheckCircle2, Truck, Cable } from 'lucide-react';
import { useAuth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';

export interface VirtualProduct {
  id: number;
  name: string;
  nameEn: string | null;
  description: string | null;
  price: string | number;
  originalPrice: string | number | null;
  coverUrl: string | null;
  deliveryType: 'AUTO' | 'MANUAL' | 'SOCKS_PANEL';
  duration?: number | null; // SOCKS_PANEL 交付时长（天）；时长制、不限流量
  status: 'ACTIVE' | 'HIDDEN' | 'SOLD_OUT' | 'ARCHIVED';
  sold: number;
  stock?: number | null; // 可售总数（null=不限量；达到 sold=stock 自动售罄）
  _count?: { keys?: number }; // 剩余未售交付码数（AUTO 商品）
}

/**
 * 虚拟商品卡片（商城页「虚拟商品」Tab / 「全部」合并区使用）。
 * 交付标识：AUTO=自动发货徽标；MANUAL=人工发货徽标。
 * 售罄判定：状态 SOLD_OUT，或 AUTO 商品剩余未售交付码为 0。
 * 未登录点击购买 → 提示并跳登录；已登录 → /purchase?product=id。
 */
export function VpCards({ products }: { products: VirtualProduct[] }) {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();

  const handleBuy = (id: number) => {
    if (!user) {
      toast.error('请先登录 / Please login first');
      router.push('/login');
      return;
    }
    router.push(`/purchase?product=${id}`);
  };

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((p, idx) => {
        const remaining = p.deliveryType === 'AUTO' ? Number(p._count?.keys ?? 0) : Infinity;
        const soldOut =
          p.status === 'SOLD_OUT' ||
          (p.deliveryType === 'AUTO' && remaining <= 0) ||
          (p.stock != null && p.sold >= p.stock);
        const isAuto = p.deliveryType === 'AUTO';
        const isSocks = p.deliveryType === 'SOCKS_PANEL';
        return (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.1 }}
          >
            <Card className="relative flex h-full flex-col overflow-hidden transition-all hover:-translate-y-1 hover:shadow-xl">
              {/* 商品图 / 渐变占位 */}
              <div
                className={`relative h-36 w-full overflow-hidden ${
                  p.coverUrl ? '' : 'bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500'
                }`}
              >
                {p.coverUrl ? (
                  // 外链图（后台填写）；加载失败自动落到同一个渐变占位
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.coverUrl}
                    alt={locale === 'en' && p.nameEn ? p.nameEn : p.name}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      const img = e.currentTarget;
                      img.style.display = 'none';
                      img.parentElement?.classList.add(
                        'bg-gradient-to-br',
                        'from-violet-500',
                        'via-indigo-500',
                        'to-sky-500',
                      );
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Store className="h-12 w-12 text-white/90" strokeWidth={1.5} />
                  </div>
                )}
              </div>

              {/* Sold out 遮罩 */}
              {soldOut && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
                  <Badge variant="danger" className="px-4 py-1.5 text-sm shadow-lg">
                    {t('products.soldOut')}
                  </Badge>
                </div>
              )}

              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-xl">
                    {locale === 'en' && p.nameEn ? p.nameEn : p.name}
                  </CardTitle>
                  <Badge variant={isSocks ? 'default' : isAuto ? 'success' : 'outline'} className="shrink-0">
                    {isSocks ? (
                      <>
                        <Cable className="mr-1 h-3 w-3" />
                        {t('products.deliverySocks')}
                      </>
                    ) : isAuto ? (
                      <>
                        <Zap className="mr-1 h-3 w-3" />
                        {t('products.deliveryAuto')}
                      </>
                    ) : (
                      <>
                        <Truck className="mr-1 h-3 w-3" />
                        {t('products.deliveryManual')}
                      </>
                    )}
                  </Badge>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">¥{Number(p.price)}</span>
                  {p.originalPrice && Number(p.originalPrice) > 0 && (
                    <span className="text-muted-foreground line-through">¥{Number(p.originalPrice)}</span>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col">
                <p className="line-clamp-2 flex-1 text-sm text-muted-foreground">
                  {p.description || t('products.virtualDesc')}
                </p>
                <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {soldOut && p.stock == null ? (
                      <Timer className="h-3.5 w-3.5" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    {soldOut && p.stock == null
                      ? t('products.soldOut')
                      : `${t('products.sold')} ${p.sold}${p.stock != null ? ` / ${p.stock}` : ''}`}
                  </span>
                  {isAuto && !soldOut && (
                    <span className="text-muted-foreground/80">
                      {t('products.leftCount').replace('{n}', String(remaining))}
                    </span>
                  )}
                  {isSocks && !soldOut && (
                    <span className="text-muted-foreground/80">
                      {t('products.duration')} {p.duration} {t('products.days')}
                    </span>
                  )}
                </div>
                <Button
                  className="mt-5 w-full"
                  variant="default"
                  disabled={soldOut}
                  onClick={() => handleBuy(p.id)}
                >
                  {t('products.buyNow')}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        );
      })}
    </div>
  );
}