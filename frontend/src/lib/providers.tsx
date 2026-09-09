'use client';

import { usePathname } from 'next/navigation';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // 官方页面（官网导航 + 页脚）与用户中心（/user/* 独立侧边栏布局）分离：
  // 用户中心不展示官网导航与页脚，保持后台式的专注体验。
  const isUserArea = pathname.startsWith('/user');

  return (
    <AuthProvider>
      <I18nProvider>
        <div className="flex min-h-screen flex-col">
          {!isUserArea && <Navbar />}
          <main className="flex-1">{children}</main>
          {!isUserArea && <Footer />}
        </div>
        <Toaster position="top-center" toastOptions={{ style: { borderRadius: '8px' } }} />
      </I18nProvider>
    </AuthProvider>
  );
}
