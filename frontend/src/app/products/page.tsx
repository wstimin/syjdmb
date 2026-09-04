'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Star, Zap } from 'lucide-react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import toast from 'react-hot-toast';

interface Plan {
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
  isFeatured?: boolean;
}

function formatTraffic(traffic: any, t: (k: string) => string) {
  const bytes = Number(traffic);
  if (!bytes || bytes <= 0) return t('products.unlimited');
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb}GB`;
}

export default function ProductsPage() {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/plans')
      .then((res) => setPlans(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const handleBuy = (planId: number) => {
    if (!user) {
      toast.error('请先登录 / Please login first');
      router.push('/login');
      return;
    }
    router.push(`/purchase?plan=${planId}`);
  };

  // Determine "monthly" equivalent for display
  const perMonth = (price: string | number, duration: number) => {
    const p = Number(price);
    if (duration <= 0) return p;
    return (p * 30 / duration).toFixed(2);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">{t('products.title')}</h1>
        <p className="mt-3 text-lg text-muted-foreground">{t('products.subtitle')}</p>
      </div>

      {loading ? (
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-96" />
          ))}
        </div>
      ) : (
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan, idx) => (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1 }}
            >
              <Card className={`relative flex h-full flex-col transition-all hover:-translate-y-1 hover:shadow-xl ${plan.isFeatured ? 'border-primary' : 'border-border/60'}`}>
                {plan.isFeatured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-white border-primary shadow-lg shadow-primary/30">
                      <Star className="mr-1 h-3 w-3 fill-current" />
                      {t('home.popular')}
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
                      {t('products.traffic')}: {formatTraffic(plan.traffic, t)}
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
                  <Button
                    className="mt-6 w-full"
                    variant={plan.isFeatured ? 'gradient' : 'default'}
                    onClick={() => handleBuy(plan.id)}
                  >
                    {t('products.buyNow')}
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
