'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProfilePage() {
  const { user, loading, refreshUser } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const [username, setUsername] = useState(!loading ? (user?.username || '') : '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  if (loading) return <div className="space-y-4"><Skeleton className="h-40 w-full" /></div>;

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await (await import('@/lib/api')).api.put('/users/profile', { username, language: locale });
      await refreshUser();
      toast.success(t('profile.updated'));
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    if (!oldPassword || !newPassword) {
      toast.error('Please fill all fields');
      return;
    }
    setSavingPassword(true);
    try {
      await (await import('@/lib/api')).api.post('/users/change-password', {
        oldPassword,
        newPassword,
      });
      toast.success('Password changed');
      setOldPassword(''); setNewPassword('');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('profile.title')}</h1>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('profile.email')}</Label>
                <Input value={user?.email || ''} disabled />
              </div>
              <div className="space-y-2">
                <Label>{t('profile.username')}</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('profile.referralCode')}</Label>
                <Input value={user?.referralCode || ''} disabled />
              </div>
              <div className="space-y-2">
                <Label>{t('profile.language')}</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as 'zh' | 'en')}
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
            <Button variant="gradient" onClick={saveProfile} disabled={savingProfile}>
              {savingProfile ? t('common.loading') : t('common.save')}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.changePassword')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('profile.oldPassword')}</Label>
            <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{t('profile.newPassword')}</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <Button variant="outline" onClick={changePassword} disabled={savingPassword}>
            {savingPassword ? t('common.loading') : t('common.confirm')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
