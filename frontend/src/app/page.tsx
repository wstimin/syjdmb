'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { Zap, Shield, Rocket, Globe, CheckCircle2, ChevronRight, ArrowRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const features = [
  { icon: Zap, titleKey: 'feature1Title', descKey: 'feature1Desc', color: 'text-violet-500' },
  { icon: Shield, titleKey: 'feature2Title', descKey: 'feature2Desc', color: 'text-blue-500' },
  { icon: Rocket, titleKey: 'feature3Title', descKey: 'feature3Desc', color: 'text-emerald-500' },
  { icon: Globe, titleKey: 'feature4Title', descKey: 'feature4Desc', color: 'text-amber-500' },
];

export default function HomePage() {
  const { t } = useI18n();

  return (
    <div className="relative overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[500px] w-[800px] -translate-x-1/2 bg-gradient-primary opacity-20 blur-[120px]" />
      </div>

      {/* Hero */}
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
          <h1 className="mt-6 text-5xl font-bold leading-tight tracking-tight sm:text-6xl">
            {t('home.heroTitle1')}{' '}
            <span className="bg-gradient-to-r from-violet-500 to-blue-500 bg-clip-text text-transparent">
              {t('home.heroTitle2')}
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            {t('home.heroSubtitle')}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link href="/register">
              <Button variant="gradient" size="lg">
                {t('home.getStarted')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/products">
              <Button variant="outline" size="lg">
                {t('home.viewPlans')}
              </Button>
            </Link>
          </div>
        </motion.div>

        {/* Features */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-20 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
        >
          {features.map((feature) => (
            <Card key={feature.titleKey} className="border-border/60 transition-all hover:-translate-y-1 hover:shadow-lg">
              <CardContent className="space-y-3 p-6">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-secondary ${feature.color}`}>
                  <feature.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold">{t(`home.${feature.titleKey}`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`home.${feature.descKey}`)}</p>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </section>

      {/* CTA Banner */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-primary p-8 text-white sm:p-12">
          <div className="relative z-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-bold sm:text-3xl">{t('home.pricingTitle')}</h2>
              <p className="mt-2 text-white/80">{t('home.pricingSubtitle')}</p>
            </div>
            <Link href="/products">
              <Button className="bg-white text-slate-900 hover:bg-white/90" size="lg">
                {t('home.viewPlans')}
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
