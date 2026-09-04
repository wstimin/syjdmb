import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 后端 API 地址（服务端运行时环境变量）
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:3001';

export const config = {
  matcher: '/api/:path*',
};

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  const pathname = url.pathname; // e.g. /api/auth/login

  // 代理到后端，保留原始路径和查询参数
  const backendUrl = new URL(pathname, BACKEND_URL);
  backendUrl.search = url.search;

  const headers = new Headers();
  // 转发重要头信息
  const forwardedHeaders = ['authorization', 'cookie', 'content-type', 'accept'];
  for (const h of forwardedHeaders) {
    const value = request.headers.get(h);
    if (value) headers.set(h, value);
  }

  // 转发真实客户端信息
  headers.set('x-forwarded-for', request.ip || '127.0.0.1');
  headers.set('x-forwarded-host', request.headers.get('host') || '');

  return NextResponse.rewrite(backendUrl, { request: { headers } });
}
