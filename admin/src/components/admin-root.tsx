'use client';

import { ReactNode } from 'react';
import { AuthProvider } from '@/lib/api';
import { AuthGate } from '@/components/auth-gate';

export function AdminRoot({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
