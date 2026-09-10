'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Server, Ticket, User, ArrowLeft, Network, Wallet, Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { BrandLogo } from '@/components/layout/brand-logo';
import { cn } from '@/lib/utils';

export default function UserLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { appName } = useSettings();
  const pathname = usePathname();

  const nav = [
    { href: '/user/dashboard', label: t('common.dashboard'), icon: LayoutDashboard },
    { href: '/user/nodes', label: t('common.nodes'), icon: Server },
    { href: '/user/products', label: t('myProducts.title'), icon: Store },
    { href: '/user/balance', label: '余额', icon: Wallet },
    { href: '/user/socks', label: 'SOCKS出站', icon: Network },
    { href: '/user/tickets', label: t('tickets.title'), icon: Ticket },
    { href: '/user/profile', label: t('profile.title'), icon: User },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 用户中心顶部条：仅返回官网，不带任何官网导航 */}
      <div className="mb-6 flex items-center justify-between border-b pb-4">
        <Link href="/" className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('nav.official')}
        </Link>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BrandLogo size={26} />
          <span>{appName}</span>
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">· {t('common.dashboard')}</span>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
        {/* Sidebar */}
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  pathname === item.href
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Mobile nav */}
        <div className="flex gap-2 overflow-x-auto pb-2 lg:hidden">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium',
                pathname === item.href ? 'border-primary bg-primary/10 text-primary' : 'border-border'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </div>

        {/* Content */}
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
