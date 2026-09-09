'use client';

import { useRouter } from 'next/navigation';
import { Check, Star, Zap, Timer, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';

export interface Plan {
  id: number;
  name: string;
  nameEn: string | null;
  description: string | null;
  price: string | number;
  originalPrice: string | number | null;
  duration: number;
  traffic: string | number | bigint;
  deviceLimit: number;
  protocols: string[];
  status?: 'ACTIVE' | 'HIDDEN' | 'SOLD_OUT' | 'ARCHIVED';
  stock?: number | null; // null / 缺省 = 不限量
  sold?: number;
  isFeatured?: boolean;
}

function formatTraffic(traffic: any, unlimitedLabel: string) {
  const bytes = Number(traffic);
  if (!bytes || bytes <= 0) return unlimitedLabel;
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb}GB`;
}

/**
 * 套餐价格卡（首页 / 购买页共用）。
 * 未登录点击购买 → 提示并跳登录；已登录 → 跳 /purchase?plan=id。
 */
export function PlanCards({ plans }: { plans: Plan[] }) {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();

  const handleBuy = (planId: number) => {
    if (!user) {
      toast.error('请先登录 / Please login first');
      router.push('/login');
      return;
    }
    router.push(`/purchase?plan=${planId}`);
  };

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((plan, idx) => {
        const soldOut = plan.status === 'SOLD_OUT' || (plan.stock != null && (plan.sold ?? 0) >= plan.stock);
        const remaining = plan.stock != null ? Math.max(0, plan.stock - (plan.sold ?? 0)) : null;
        return (
        <motion.div
          key={plan.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.1 }}
        >
          <Card className={`relative flex h-full flex-col transition-all hover:-translate-y-1 hover:shadow-xl ${plan.isFeatured ? 'border-primary' : 'border-border/60'}`}>
            {plan.isFeatured && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <Badge className="border-primary bg-primary text-white shadow-lg shadow-primary/30">
                  <Star className="mr-1 h-3 w-3 fill-current" />
                  {t('home.popular')}
                </Badge>
              </div>
            )}
            {/* 售罄遮罩（与 NP 店铺卡片一致） */}
            {soldOut && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/60 backdrop-blur-[2px]">
                <Badge variant="danger" className="px-4 py-1.5 text-sm shadow-lg">
                  {t('products.soldOut')}
                </Badge>
              </div>
            )}
            <CardHeader>
              <CardTitle className="text-xl">{locale === 'en' && plan.nameEn ? plan.nameEn : plan.name}</CardTitle>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold">¥{Number(plan.price)}</span>
                {plan.originalPrice && (
                  <span className="text-muted-foreground line-through">¥{Number(plan.originalPrice)}</span>
                )}
                <span className="text-sm text-muted-foreground">
                  / {plan.duration > 0 ? `${plan.duration}${t('products.days')}` : t('products.unlimited')}
                </span>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <ul className="flex-1 space-y-3 text-sm">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  {t('products.traffic')}: {formatTraffic(plan.traffic, t('products.unlimited'))}
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  {t('products.duration')}: {plan.duration > 0 ? `${plan.duration}${t('products.days')}` : t('products.unlimited')}
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  {t('products.device')}: {plan.deviceLimit}
                </li>
                <li className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-violet-500" />
                  {t('products.protocols')}: {plan.protocols.join(' / ')}
                </li>
              </ul>
              <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {soldOut ? (
                    <Timer className="h-3.5 w-3.5" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                  {soldOut ? t('products.soldOut') : `${t('products.sold')} ${plan.sold ?? 0}`}
                </span>
                {/* 限量方案显示剩余份数；不限量不显示 */}
                {remaining != null && !soldOut && (
                  <span className="text-muted-foreground/80">
                    {t('products.leftCount').replace('{n}', String(remaining))}
                  </span>
                )}
              </div>
              <Button
                className="mt-6 w-full"
                variant={plan.isFeatured ? 'gradient' : 'default'}
                disabled={soldOut}
                onClick={() => handleBuy(plan.id)}
              >
                {t('products.buyNow')}
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      );})}
    </div>
  );
}
