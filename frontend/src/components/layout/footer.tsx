'use client';

import Link from 'next/link';
import { Zap, Mail, Clock, Github, Twitter } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function Footer() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t bg-muted/40">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          {/* 品牌与定位标语 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <span className="text-lg font-bold">{t('common.appName')}</span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('home.footerSlogan')}</p>
            <div className="flex gap-3 pt-2 text-muted-foreground">
              <Github className="h-4 w-4" />
              <Twitter className="h-4 w-4" />
            </div>
          </div>

          {/* 服务 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">服务 / Services</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/" className="hover:text-foreground">{t('common.home')}</Link></li>
              <li><Link href="/products" className="hover:text-foreground">{t('home.viewAllPlans')}</Link></li>
              <li><Link href="/user/dashboard" className="hover:text-foreground">{t('common.dashboard')}</Link></li>
            </ul>
          </div>

          {/* 帮助与支持 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">帮助 / Help</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/#faq" className="hover:text-foreground">{t('home.faqTitle')}</Link></li>
              <li><Link href="/agreement" className="hover:text-foreground">用户协议 / Terms</Link></li>
              <li><Link href="/user/tickets" className="hover:text-foreground">{t('tickets.title')}</Link></li>
            </ul>
          </div>

          {/* 联系方式 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">联系 / Contact</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                <span className="hover:text-foreground">hello@sitename.com</span>
              </li>
              <li className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {t('home.stat4Value')} · {t('home.stat4Label')}
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t pt-6 text-center text-sm text-muted-foreground">
          © {year} {t('common.appName')} · {t('home.footerSlogan')} · {t('home.rightsReserved')}.
        </div>
      </div>
    </footer>
  );
}