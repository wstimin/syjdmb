'use client';

import Link from 'next/link';
import { Zap, Github, Twitter, Mail } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function Footer() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t bg-muted/40">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <span className="text-lg font-bold">{t('common.appName')}</span>
            </div>
            <p className="text-sm text-muted-foreground">{t('home.heroSubtitle')}</p>
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('common.products')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/products" className="hover:text-foreground">{t('home.pricingTitle')}</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('common.dashboard')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/user/dashboard" className="hover:text-foreground">{t('common.dashboard')}</Link></li>
              <li><Link href="/user/nodes" className="hover:text-foreground">{t('common.nodes')}</Link></li>
              <li><Link href="/user/tickets" className="hover:text-foreground">{t('tickets.title')}</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('home.support')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/agreement" className="hover:text-foreground">用户协议 / Terms</Link></li>
              <li className="flex gap-3 pt-2">
                <Github className="h-4 w-4" />
                <Twitter className="h-4 w-4" />
                <Mail className="h-4 w-4" />
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t pt-6 text-center text-sm text-muted-foreground">
          © {year} {t('common.appName')}. {t('home.rightsReserved')}.
        </div>
      </div>
    </footer>
  );
}
