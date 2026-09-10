'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, X, Languages, LayoutDashboard, ShoppingCart } from 'lucide-react';
import { useAuth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/layout/brand-logo';
import { cn } from '@/lib/utils';

export function Navbar() {
  const { user, logout } = useAuth();
  const { t, locale, toggleLocale } = useI18n();
  const { appName, cardPurchaseUrl } = useSettings();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // 官网导航：官方展示页（首页/套餐/使用场景/常见问题）+ 登录注册入口。
  // 用户中心为独立区域（/user 自带侧边栏），不混入官网导航。
  const links = [
    { href: '/', label: t('common.home') },
    { href: '/products', label: t('common.products') },
    { href: '/#scenarios', label: t('nav.scenarios') },
    { href: '/#faq', label: t('nav.faq') },
  ];

  const isActive = (href: string) => {
    // 锚点项（/#scenarios、/#faq）属页内导航，不参与「当前页」高亮
    if (href.includes('#')) return false;
    return href === '/' ? pathname === '/' : pathname === href;
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-lg">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <BrandLogo size={34} />
          <span className="text-lg font-bold tracking-tight">{appName}</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive(link.href)
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              {link.label}
            </Link>
          ))}
          {cardPurchaseUrl && (
            <a
              href={cardPurchaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
            >
              <ShoppingCart className="h-3.5 w-3.5" />
              {t('nav.buyCard')}
            </a>
          )}
        </div>

        {/* Actions */}
        <div className="hidden items-center gap-3 md:flex">
          <Button variant="ghost" size="icon" onClick={toggleLocale} className="text-sm">
            <Languages className="h-4 w-4" />
            <span className="ml-1 text-xs">{locale === 'zh' ? 'EN' : '中'}</span>
          </Button>
          {user ? (
            <div className="flex items-center gap-3">
              <Link href="/user/dashboard">
                <Button variant="outline" size="sm">
                  <LayoutDashboard className="mr-1.5 h-4 w-4" />
                  {t('common.dashboard')}
                </Button>
              </Link>
              <Button variant="ghost" size="sm" onClick={logout}>
                {t('common.logout')}
              </Button>
            </div>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost">{t('common.login')}</Button>
              </Link>
              <Link href="/register">
                <Button variant="gradient">{t('common.register')}</Button>
              </Link>
            </>
          )}
        </div>

        {/* Mobile menu button */}
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(!open)}>
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="border-t bg-background px-4 py-4 md:hidden">
          <div className="flex flex-col gap-2">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent"
              >
                {link.label}
              </Link>
            ))}
            {cardPurchaseUrl && (
              <a
                href={cardPurchaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10"
              >
                <ShoppingCart className="h-4 w-4" />
                {t('nav.buyCard')}
              </a>
            )}
            <div className="mt-2 border-t pt-3">
              {user ? (
                <>
                  <Link href="/user/dashboard" onClick={() => setOpen(false)}>
                    <Button variant="outline" className="w-full">
                      <LayoutDashboard className="mr-1.5 h-4 w-4" />
                      {t('common.dashboard')}
                    </Button>
                  </Link>
                  <Button variant="ghost" className="mt-2 w-full" onClick={() => { logout(); setOpen(false); }}>
                    {t('common.logout')}
                  </Button>
                </>
              ) : (
                <div className="flex gap-2">
                  <Link href="/login" className="flex-1" onClick={() => setOpen(false)}>
                    <Button variant="outline" className="w-full">{t('common.login')}</Button>
                  </Link>
                  <Link href="/register" className="flex-1" onClick={() => setOpen(false)}>
                    <Button variant="gradient" className="w-full">{t('common.register')}</Button>
                  </Link>
                </div>
              )}
              <Button variant="ghost" className="mt-2 w-full" onClick={toggleLocale}>
                <Languages className="h-4 w-4" />
                {locale === 'zh' ? 'Switch to English' : '切换到中文'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
