'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Mail, Zap, ArrowLeft, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('请输入注册邮箱');
      return;
    }
    setLoading(true);
    try {
      // 后端统一文案：无论邮箱是否存在都返回同样提示，避免泄露已注册邮箱
      const res = await api.post('/auth/forgot-password', { email });
      setSent(true);
      toast.success(res.data?.message || '如果该邮箱已注册，重置链接已发送至邮箱');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <Card className="border-border/60 shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-primary">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <CardTitle className="text-2xl">找回密码</CardTitle>
            <CardDescription>输入注册邮箱，我们将向该邮箱发送重置密码链接（30 分钟内有效）</CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="space-y-4 py-4 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                  <CheckCircle2 className="h-7 w-7 text-emerald-500" />
                </div>
                <p className="text-sm text-muted-foreground">
                  如果该邮箱已注册，重置链接已发送至邮箱
                  <br />
                  请前往邮箱查收（注意检查垃圾邮件），30 分钟内有效
                </p>
                <Link href="/login" className="block pt-2 text-sm font-medium text-primary hover:underline">
                  返回登录
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label>注册邮箱</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      className="pl-10"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <Button type="submit" variant="gradient" className="w-full" size="lg" disabled={loading}>
                  {loading ? '发送中...' : '发送重置链接'}
                </Button>
                <Link
                  href="/login"
                  className="flex items-center justify-center gap-1.5 pt-1 text-sm text-muted-foreground hover:text-primary"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回登录
                </Link>
              </form>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}