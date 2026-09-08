'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  Zap, Shield, Rocket, Globe, ArrowRight, ChevronDown,
  ShoppingBag, Share2, Sparkles, Briefcase,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PlanCards, Plan } from '@/components/plans/plan-cards';

const scenarios = [
  { icon: ShoppingBag, titleKey: 'scenario1Title', descKey: 'scenario1Desc', color: 'text-violet-500' },
  { icon: Share2, titleKey: 'scenario2Title', descKey: 'scenario2Desc', color: 'text-blue-500' },
  { icon: Sparkles, titleKey: 'scenario3Title', descKey: 'scenario3Desc', color: 'text-emerald-500' },
  { icon: Briefcase, titleKey: 'scenario4Title', descKey: 'scenario4Desc', color: 'text-amber-500' },
];

const features = [
  { icon: Zap, titleKey: 'feature1Title', descKey: 'feature1Desc', color: 'text-violet-500' },
  { icon: Shield, titleKey: 'feature2Title', descKey: 'feature2Desc', color: 'text-blue-500' },
  { icon: Rocket, titleKey: 'feature3Title', descKey: 'feature3Desc', color: 'text-emerald-500' },
  { icon: Globe, titleKey: 'feature4Title', descKey: 'feature4Desc', color: 'text-amber-500' },
];

const steps = [
  { titleKey: 'step1Title', descKey: 'step1Desc' },
  { titleKey: 'step2Title', descKey: 'step2Desc' },
  { titleKey: 'step3Title', descKey: 'step3Desc' },
  { titleKey: 'step4Title', descKey: 'step4Desc' },
];

const faqs = [
  { q: 'faq1Q', a: 'faq1A' },
  { q: 'faq2Q', a: 'faq2A' },
  { q: 'faq3Q', a: 'faq3A' },
  { q: 'faq4Q', a: 'faq4A' },
  { q: 'faq5Q', a: 'faq5A' },
  { q: 'faq6Q', a: 'faq6A' },
];

export default function HomePage() {
  const { t } = useI18n();
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState(false);

  // 套餐展示：失败静默降级（不 toast、不遮整页），保证首页其他部分独立渲染
  useEffect(() => {
    api.get('/plans')
      .then((res) => setPlans(res.data.data))
      .catch(() => setPlansError(true))
      .finally(() => setPlansLoading(false));
  }, []);

  return (
    <div className="relative overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[500px] w-[900px] -translate-x-1/2 bg-gradient-primary opacity-20 blur-[120px]" />
      </div>

      {/* ============ Hero ============ */}
      <section className="mx-auto max-w-7xl px-4 pb-16 pt-20 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-3xl text-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm text-muted-foreground">
            {t('home.heroBadge')}
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            {t('home.heroTitle1')}{' '}
            <span className="bg-gradient-to-r from-violet-500 to-blue-500 bg-clip-text text-transparent">
              {t('home.heroTitle2')}
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            {t('home.heroSubtitle')}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link href="/products">
              <Button variant="gradient" size="lg">
                {t('home.getStarted')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <a href="#scenarios">
              <Button variant="outline" size="lg">
                {t('home.learnMore')}
              </Button>
            </a>
          </div>
        </motion.div>

        {/* 数据条 */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-4 sm:grid-cols-4"
        >
          {[
            ['home.stat1Value', 'home.stat1Label'],
            ['home.stat2Value', 'home.stat2Label'],
            ['home.stat3Value', 'home.stat3Label'],
            ['home.stat4Value', 'home.stat4Label'],
          ].map(([v, l]) => (
            <div key={l} className="rounded-xl border bg-card/60 px-4 py-4 text-center">
              <div className="text-lg font-bold">{t(v)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t(l)}</div>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ============ 使用场景 ============ */}
      <section id="scenarios" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">{t('home.scenariosTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('home.scenariosSubtitle')}</p>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {scenarios.map((s) => (
            <Card key={s.titleKey} className="border-border/60 transition-all hover:-translate-y-1 hover:shadow-lg">
              <CardContent className="space-y-3 p-6">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-secondary ${s.color}`}>
                  <s.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold">{t(`home.${s.titleKey}`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`home.${s.descKey}`)}</p>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </section>

      {/* ============ 核心优势 ============ */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {features.map((f) => (
            <Card key={f.titleKey} className="border-border/60 transition-all hover:-translate-y-1 hover:shadow-lg">
              <CardContent className="space-y-3 p-6">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-secondary ${f.color}`}>
                  <f.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold">{t(`home.${f.titleKey}`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`home.${f.descKey}`)}</p>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </section>

      {/* ============ 服务流程 ============ */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">{t('home.stepsTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('home.stepsSubtitle')}</p>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {steps.map((step, idx) => (
            <div key={step.titleKey} className="relative rounded-xl border bg-card/60 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-primary text-sm font-bold text-white">
                {idx + 1}
              </div>
              <h3 className="mt-4 font-semibold">{t(`home.${step.titleKey}`)}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t(`home.${step.descKey}`)}</p>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ============ 套餐展示 ============ */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">{t('home.planSectionTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('home.planSectionSubtitle')}</p>
        </div>
        <div className="mt-12">
          {plansLoading ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-96" />
              ))}
            </div>
          ) : plansError ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <p className="text-muted-foreground">套餐加载失败，请稍后刷新页面查看</p>
              <Link href="/products" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
                {t('home.viewAllPlans')} →
              </Link>
            </div>
          ) : plans.length === 0 ? (
            <p className="text-center text-muted-foreground">{t('products.empty')}</p>
          ) : (
            <PlanCards plans={plans} />
          )}
        </div>
        <div className="mt-10 text-center">
          <Link href="/products">
            <Button variant="outline" size="lg">
              {t('home.viewAllPlans')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight">{t('home.faqTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('home.faqSubtitle')}</p>
        </div>
        <div className="mt-10 space-y-3">
          {faqs.map((item, idx) => {
            const open = openFaq === idx;
            return (
              <div key={item.q} className="overflow-hidden rounded-xl border bg-card/60">
                <button
                  type="button"
                  onClick={() => setOpenFaq(open ? null : idx)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
                >
                  <span className="font-medium">{t(`home.${item.q}`)}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <div className="border-t px-5 py-4 text-sm leading-relaxed text-muted-foreground">
                    {t(`home.${item.a}`)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-primary p-8 text-white sm:p-12">
          <div className="relative z-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-bold sm:text-3xl">{t('home.ctaTitle')}</h2>
              <p className="mt-2 text-white/80">{t('home.ctaSubtitle')}</p>
            </div>
            <Link href="/register">
              <Button className="bg-white text-slate-900 hover:bg-white/90" size="lg">
                {t('home.ctaBtn')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}