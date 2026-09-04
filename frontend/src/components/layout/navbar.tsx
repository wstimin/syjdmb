'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, X, Zap, Languages } from 'lucide-react';
import { useAuth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Navbar() {
  const { user, logout } = useAuth();
  const { t, locale, toggleLocale } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = [
    { href: '/', label: t('common.home') },
    { href: '/products', label: t('common.products') },
    { href: user ? '/user/dashboard' : '/login', label: t('common.dashboard') },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-lg">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <span className="text-lg font-bold tracking-tight">{t('common.appName')}</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname === link.href
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              {link.label}
            </Link>
          ))}
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
                <span className="text-sm font-medium">
                  {user.username || user.email.split('@')[0]}
                </span>
              </Link>
              <Button variant="outline" size="sm" onClick={logout}>
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
            <div className="mt-2 border-t pt-3">
              {user ? (
                <Button variant="outline" className="w-full" onClick={() => { logout(); setOpen(false); }}>
                  {t('common.logout')}
                </Button>
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
