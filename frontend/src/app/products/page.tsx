'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PlanCards, Plan } from '@/components/plans/plan-cards';
import { VpCards, VirtualProduct } from '@/components/virtual-products/vp-cards';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Store, Network, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tab = 'all' | 'plans' | 'virtual';
type CatFilter = number | 'all'; // 分类 id 或「全部」

interface Category {
  id: number;
  name: string;
  nameEn?: string | null;
  scope: 'PLAN' | 'VIRTUAL';
}

// 分类筛选按钮组（「全部」+ 各分类）。无分类数据时整行隐藏（老部署兼容）。
function CategoryChips({ categories, value, onChange, allLabel, locale }: {
  categories: Category[];
  value: CatFilter;
  onChange: (v: CatFilter) => void;
  allLabel: string;
  locale: string;
}) {
  if (!categories || categories.length === 0) return null;
  const label = (c: Category) =>
    locale === 'en' && c.nameEn ? c.nameEn : c.name;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange('all')}
        className={cn(
          'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
          value === 'all'
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border/70 bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
        )}
      >
        {allLabel}
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          className={cn(
            'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
            value === c.id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border/70 bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
          )}
        >
          {label(c)}
        </button>
      ))}
    </div>
  );
}

export default function ProductsPage() {
  const { t, locale } = useI18n();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [products, setProducts] = useState<VirtualProduct[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [planCat, setPlanCat] = useState<CatFilter>('all');
  const [vpCat, setVpCat] = useState<CatFilter>('all');

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

    // 分类按钮数据（老部署无此接口 → 静默降级为无分类模式）
    api.get('/categories')
      .then((res) => setCategories(res.data.data || []))
      .catch(() => setCategories([]));
  }, []);

  const loading = !plansLoaded || !productsLoaded;

  // 搜索：名称/英文名大小写不敏感；分类筛选：卡片 category.id 命中
  const q = search.trim().toLowerCase();
  const matches = (name?: string | null, nameEn?: string | null) => {
    if (!q) return true;
    return [name, nameEn].some((v) => String(v ?? '').toLowerCase().includes(q));
  };
  const planCategories = categories.filter((c) => c.scope === 'PLAN');
  const vpCategories = categories.filter((c) => c.scope === 'VIRTUAL');
  const filteredPlans = plans.filter(
    (p) => matches(p.name, p.nameEn) && (planCat === 'all' || p.category?.id === planCat),
  );
  const filteredProducts = products.filter(
    (p) => matches(p.name, p.nameEn) && (vpCat === 'all' || p.category?.id === vpCat),
  );

  const tabs: { id: Tab; label: string; icon?: React.ReactNode }[] = [
    { id: 'all', label: t('products.tabsAll') },
    { id: 'plans', label: t('products.tabsPlans'), icon: <Network className="h-4 w-4" /> },
    { id: 'virtual', label: t('products.tabsVirtual'), icon: <Store className="h-4 w-4" /> },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 lg:px-8">
      {/* 紧凑头部：标题区 + 搜索框同行 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('products.title')}</h1>
          <p className="mt-1.5 text-muted-foreground">{t('products.subtitle')}</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9 pr-8"
            placeholder={t('products.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 顶部 Tab：全部 / 网络产品 / NP店铺 */}
      <div className="mt-6 flex justify-center">
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
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-96" />
          ))}
        </div>
      ) : (
        <>
          {/* 全部：网络产品在前，NP店铺在后；各自 segment 标题带自己的分类按钮 */}
          {tab === 'all' && (
            <div className="mt-10 space-y-12">
              {plans.length > 0 && (
                <section>
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 className="mr-2 flex items-center gap-2 text-lg font-semibold">
                      <Network className="h-5 w-5 text-primary" />
                      {t('products.tabsPlans')}
                    </h2>
                    <CategoryChips
                      categories={planCategories}
                      value={planCat}
                      onChange={setPlanCat}
                      allLabel={t('products.tabsAll')}
                      locale={locale}
                    />
                  </div>
                  {filteredPlans.length === 0 ? (
                    <p className="py-8 text-center text-muted-foreground">{t('products.emptyPlans')}</p>
                  ) : (
                    <PlanCards plans={filteredPlans} />
                  )}
                </section>
              )}
              {products.length > 0 && (
                <section>
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 className="mr-2 flex items-center gap-2 text-lg font-semibold">
                      <Store className="h-5 w-5 text-primary" />
                      {t('products.tabsVirtual')}
                    </h2>
                    <CategoryChips
                      categories={vpCategories}
                      value={vpCat}
                      onChange={setVpCat}
                      allLabel={t('products.tabsAll')}
                      locale={locale}
                    />
                  </div>
                  {filteredProducts.length === 0 ? (
                    <p className="py-8 text-center text-muted-foreground">{t('products.emptyVirtual')}</p>
                  ) : (
                    <VpCards products={filteredProducts} />
                  )}
                </section>
              )}
              {plans.length === 0 && products.length === 0 && (
                <p className="mt-12 text-center text-muted-foreground">{t('products.empty')}</p>
              )}
            </div>
          )}

          {tab === 'plans' && (
            <div className="mt-10">
              {planCategories.length > 0 && (
                <div className="mb-6 flex justify-center">
                  <CategoryChips
                    categories={planCategories}
                    value={planCat}
                    onChange={setPlanCat}
                    allLabel={t('products.tabsAll')}
                    locale={locale}
                  />
                </div>
              )}
              {filteredPlans.length === 0 ? (
                <p className="py-16 text-center text-muted-foreground">{t('products.emptyPlans')}</p>
              ) : (
                <PlanCards plans={filteredPlans} />
              )}
            </div>
          )}

          {tab === 'virtual' && (
            <div className="mt-10">
              {vpCategories.length > 0 && (
                <div className="mb-6 flex justify-center">
                  <CategoryChips
                    categories={vpCategories}
                    value={vpCat}
                    onChange={setVpCat}
                    allLabel={t('products.tabsAll')}
                    locale={locale}
                  />
                </div>
              )}
              {filteredProducts.length === 0 ? (
                <div className="py-16 text-center">
                  <Store className="mx-auto h-16 w-16 text-muted-foreground/30" />
                  <p className="mt-4 text-muted-foreground">{t('products.emptyVirtual')}</p>
                </div>
              ) : (
                <VpCards products={filteredProducts} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}