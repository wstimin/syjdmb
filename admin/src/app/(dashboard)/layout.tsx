'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Toaster } from 'react-hot-toast';
import {
  LayoutDashboard, Users, Package, ShoppingCart, Server, Wifi,
  Network, Ticket as TicketIcon, Megaphone, Settings, LogOut, Zap, CreditCard, DollarSign,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/api';

const navItems = [
  { href: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { href: '/users', label: '用户管理', icon: Users },
  { href: '/plans', label: '套餐管理', icon: Package },
  { href: '/orders', label: '订单管理', icon: ShoppingCart },
  { href: '/cards', label: '卡密管理', icon: CreditCard },
  { href: '/finances', label: '财务统计', icon: DollarSign },
  { href: '/servers', label: '服务器管理', icon: Server },
  { href: '/inbounds', label: '节点管理', icon: Wifi },
  { href: '/socks', label: 'SOCKS管理', icon: Network },
  { href: '/tickets', label: '工单管理', icon: TicketIcon },
  { href: '/announcements', label: '公告管理', icon: Megaphone },
  { href: '/settings', label: '系统设置', icon: Settings },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-card lg:block">
        <div className="flex items-center gap-2 border-b px-6 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-bold leading-tight">NodeShop</div>
            <div className="text-xs text-muted-foreground">管理后台</div>
          </div>
        </div>
        <nav className="space-y-1 p-4">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                pathname === item.href || pathname.startsWith(item.href + '/')
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full border-t p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user?.email}</div>
              <div className="text-xs text-muted-foreground">{user?.role}</div>
            </div>
            <button onClick={logout} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 lg:pl-64">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/80 px-4 backdrop-blur lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold">NodeShop</span>
          </Link>
          <button onClick={logout} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <LogOut className="h-4 w-4" />
          </button>
        </header>

        <main className="min-h-screen p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}
