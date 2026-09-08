import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/providers';

export const metadata: Metadata = {
  title: 'NodeShop - 跨境办公与 AI 直连的国际网络服务',
  description: '面向跨境电商、海外社媒、远程办公与 AI 用户的全球节点网络连接服务——低延迟、安全加密、即买即用。',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
