'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import { Mail, Lock, Loader2, AlertCircle } from 'lucide-react';
import { useAuth, getErrorMessage } from '@/lib/api';
import { BrandLogo } from '@/components/layout/brand-logo';
import { APP_VERSION } from '@/lib/version';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('请输入邮箱和密码');
      return;
    }
    setLoading(true);
    try {
      const u = await login(email, password);
      if (u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') {
        toast.success('登录成功');
        router.push('/dashboard');
      } else {
        setError('该账号没有管理后台权限');
        toast.error('该账号没有管理后台权限');
      }
    } catch (err: any) {
      const status = err?.response?.status;
      let msg: string;
      if (status === 401) {
        msg = '邮箱或密码错误，账号不存在，或账号已被禁用';
      } else if (status === 429) {
        msg = getErrorMessage(err); // 后端已带具体锁定分钟数（中英双语）
      } else if (!err?.response) {
        msg = '网络连接失败，请检查网络后重试';
      } else {
        msg = getErrorMessage(err);
      }
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[500px] w-[800px] -translate-x-1/2 bg-gradient-primary opacity-20 blur-[120px]" />
      </div>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <Card className="border-border/60 shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto">
              <BrandLogo size={48} />
            </div>
            <CardTitle className="text-2xl">管理后台登录</CardTitle>
            <CardDescription>NodeShop Admin · v{APP_VERSION}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>邮箱 Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input type="email" className="pl-10" value={email} onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label>密码 Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input type="password" className="pl-10" value={password} onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }} required />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" variant="gradient" className="w-full" size="lg" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {loading ? '登录中...' : '登录'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
