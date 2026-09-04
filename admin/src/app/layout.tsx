import type { Metadata } from 'next';
import './globals.css';
import { AdminRoot } from '@/components/admin-root';

export const metadata: Metadata = {
  title: 'NodeShop 管理后台',
  description: 'NodeShop 管理后台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <AdminRoot>{children}</AdminRoot>
      </body>
    </html>
  );
}
