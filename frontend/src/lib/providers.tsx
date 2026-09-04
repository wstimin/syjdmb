'use client';

import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <I18nProvider>
        <div className="flex min-h-screen flex-col">
          <Navbar />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
        <Toaster position="top-center" toastOptions={{ style: { borderRadius: '8px' } }} />
      </I18nProvider>
    </AuthProvider>
  );
}
