'use client';

import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PlanCards, Plan } from '@/components/plans/plan-cards';
import { Skeleton } from '@/components/ui/skeleton';
import toast from 'react-hot-toast';

export default function ProductsPage() {
  const { t } = useI18n();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/plans')
      .then((res) => setPlans(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

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
      ) : plans.length === 0 ? (
        <p className="mt-12 text-center text-muted-foreground">{t('products.empty')}</p>
      ) : (
        <div className="mt-12">
          <PlanCards plans={plans} />
        </div>
      )}
    </div>
  );
}