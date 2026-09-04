'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // Login page doesn't need auth
  if (pathname === '/login') return <>{children}</>;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-32 w-80" />
      </div>
    );
  }

  // Allow both admin and super_admin
  if (!user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return null;
  }

  return <>{children}</>;
}
