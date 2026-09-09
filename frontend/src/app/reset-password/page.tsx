'use client';

import { useState, Suspense } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Lock, CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { BrandLogo } from '@/components/layout/brand-logo';
import { useSearchParams } from 'next/navigation';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

function ResetContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirm) {
      toast.error('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/reset-password', { token, newPassword });
      setDone(true);
      toast.success(res.data?.message || '密码已重置，请使用新密码登录');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // 链接里没有 token：视为无效/已过期链接
  if (!token) {
    return (
      <div className="space-y-4 py-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <XCircle className="h-7 w-7 text-destructive" />
        </div>
        <p className="text-sm text-muted-foreground">重置链接无效或已过期</p>
        <p className="text-sm">
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">
            重新发送重置链接
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4 py-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle2 className="h-7 w-7 text-emerald-500" />
        </div>
        <p className="text-sm text-emerald-600 font-medium">密码已重置成功</p>
        <Link
          href="/login"
          className="inline-block rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          去登录
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>新密码</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="password"
            placeholder="至少 6 位"
            className="pl-10"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>确认新密码</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="password"
            placeholder="再次输入新密码"
            className="pl-10"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
      </div>
      <Button type="submit" variant="gradient" className="w-full" size="lg" disabled={loading}>
        {loading ? '提交中...' : '重置密码'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <Card className="border-border/60 shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center">
              <BrandLogo size={46} />
            </div>
            <CardTitle className="text-2xl">重置密码</CardTitle>
            <CardDescription>设置一个新密码，完成后即可用新密码登录</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">加载中...</div>}>
              <ResetContent />
            </Suspense>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}