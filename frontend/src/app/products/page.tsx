'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PlanCards, Plan } from '@/components/plans/plan-cards';
import { VpCards, VirtualProduct } from '@/components/virtual-products/vp-cards';
import { Skeleton } from '@/components/ui/skeleton';
import { Store, Network } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tab = 'all' | 'plans' | 'virtual';

export default function ProductsPage() {
  const { t } = useI18n();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [products, setProducts] = useState<VirtualProduct[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>('all');

  useEffect(() => {
    // 并行拉取，任一失败各自静默降级（空态提示，不 toast 遮整页）
    api.get('/plans')
      .then((res) => setPlans(res.data.data || []))
      .catch(() => setPlans([]))
      .finally(() => setPlansLoaded(true));

    api.get('/virtual-products')
      .then((res) => setProducts(res.data.data || []))
      .catch(() => setProducts([]))
      .finally(() => setProductsLoaded(true));
  }, []);

  const loading = !plansLoaded || !productsLoaded;

  const tabs: { id: Tab; label: string; icon?: React.ReactNode }[] = [
    { id: 'all', label: t('products.tabsAll') },
    { id: 'plans', label: t('products.tabsPlans'), icon: <Network className="h-4 w-4" /> },
    { id: 'virtual', label: t('products.tabsVirtual'), icon: <Store className="h-4 w-4" /> },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">{t('products.title')}</h1>
        <p className="mt-3 text-lg text-muted-foreground">{t('products.subtitle')}</p>
      </div>

      {/* 顶部 Tab：全部 / 网络方案 / 虚拟商品 */}
      <div className="mt-10 flex justify-center">
        <div className="inline-flex rounded-full border border-border/60 bg-muted/40 p-1">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-medium transition-colors',
                tab === item.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-96" />
          ))}
        </div>
      ) : (
        <>
          {/* 全部：网络方案在前，虚拟商品在后，同一栅格 */}
          {(tab === 'all') && (
            <div className="mt-12 space-y-14">
              {plans.length > 0 && (
                <section>
                  <h2 className="mb-6 flex items-center gap-2 text-xl font-semibold">
                    <Network className="h-5 w-5 text-primary" />
                    {t('products.tabsPlans')}
                  </h2>
                  <PlanCards plans={plans} />
                </section>
              )}
              {products.length > 0 && (
                <section>
                  <h2 className="mb-6 flex items-center gap-2 text-xl font-semibold">
                    <Store className="h-5 w-5 text-primary" />
                    {t('products.tabsVirtual')}
                  </h2>
                  <VpCards products={products} />
                </section>
              )}
              {plans.length === 0 && products.length === 0 && (
                <p className="mt-12 text-center text-muted-foreground">{t('products.empty')}</p>
              )}
            </div>
          )}

          {tab === 'plans' && (
            <div className="mt-12">
              {plans.length === 0 ? (
                <p className="mt-12 text-center text-muted-foreground">{t('products.emptyPlans')}</p>
              ) : (
                <PlanCards plans={plans} />
              )}
            </div>
          )}

          {tab === 'virtual' && (
            <div className="mt-12">
              {products.length === 0 ? (
                <div className="py-16 text-center">
                  <Store className="mx-auto h-16 w-16 text-muted-foreground/30" />
                  <p className="mt-4 text-muted-foreground">{t('products.emptyVirtual')}</p>
                </div>
              ) : (
                <VpCards products={products} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}