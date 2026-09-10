'use client';

import Link from 'next/link';
import { Mail, Clock, MapPin } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { BrandLogo } from '@/components/layout/brand-logo';

export function Footer() {
  const { t } = useI18n();
  const { appName, supportEmail, contactHours } = useSettings();
  const year = new Date().getFullYear();

  // 联系方式优先取后台设置（后台「系统设置 → 客服邮箱 / 营业时间」），未配置时回退到文案默认值
  const contactEmail = supportEmail || t('footer.contactEmail');
  const hours = contactHours || t('footer.hours');

  return (
    <footer className="border-t bg-muted/40">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          {/* 品牌与定位标语 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <BrandLogo size={30} />
              <span className="text-lg font-bold">{appName}</span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('home.footerSlogan')}</p>
          </div>

          {/* 产品 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('footer.product')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/" className="hover:text-foreground">{t('common.home')}</Link></li>
              <li><Link href="/products" className="hover:text-foreground">{t('common.products')}</Link></li>
              <li><Link href="/#scenarios" className="hover:text-foreground">{t('nav.scenarios')}</Link></li>
            </ul>
          </div>

          {/* 帮助与支持 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('footer.support')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/#faq" className="hover:text-foreground">{t('nav.faq')}</Link></li>
              <li><Link href="/agreement" className="hover:text-foreground">{t('footer.terms')}</Link></li>
            </ul>
          </div>

          {/* 联系方式 */}
          <div>
            <h4 className="mb-3 text-sm font-semibold">{t('footer.contact')}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <Mail className="h-4 w-4 shrink-0" />
                <a href={`mailto:${contactEmail}`} className="hover:text-foreground">
                  {contactEmail}
                </a>
              </li>
              <li className="flex items-center gap-2">
                <Clock className="h-4 w-4 shrink-0" />
                <span>{hours}</span>
              </li>
              <li className="flex items-center gap-2">
                <MapPin className="h-4 w-4 shrink-0" />
                <span>{t('footer.service')}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t pt-6 text-center text-sm text-muted-foreground">
          © {year} {appName} · {t('home.footerSlogan')} · {t('home.rightsReserved')}.
        </div>
      </div>
    </footer>
  );
}