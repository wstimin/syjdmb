'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Save } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/shared/data-table';
import { Skeleton } from '@/components/ui/skeleton';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-input bg-background px-3 py-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-input'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className="text-sm font-medium">{label}</span>
    </label>
  );
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<any>({});

  const set = (key: string, value: any) => setForm((f: any) => ({ ...f, [key]: value }));

  useEffect(() => {
    api.get('/system/settings')
      .then((res) => {
        const s = res.data.data;
        setForm({
          // general
          appName: s.appName || 'NodeShop',
          supportEmail: s.supportEmail || '',
          siteUrl: s.siteUrl || '',
          // wechat
          wechatEnabled: s.wechatEnabled === true || s.wechatEnabled === 'true' || false,
          wechatAppId: s.wechatAppId || '',
          wechatMchId: s.wechatMchId || '',
          wechatApiKey: s.wechatApiKey || '',
          wechatApiV3Key: s.wechatApiV3Key || '',
          wechatCertPath: s.wechatCertPath || '',
          wechatNotifyUrl: s.wechatNotifyUrl || '',
          // alipay
          alipayEnabled: s.alipayEnabled === true || s.alipayEnabled === 'true' || false,
          alipayAppId: s.alipayAppId || '',
          alipayPrivateKey: s.alipayPrivateKey || '',
          alipayPublicKey: s.alipayPublicKey || '',
          alipayGateway: s.alipayGateway || 'https://openapi.alipay.com/gateway.do',
          alipayNotifyUrl: s.alipayNotifyUrl || '',
        });
      })
      .catch(() => toast.error('加载系统设置失败'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/system/settings', [
        // general
        { key: 'appName', value: form.appName, type: 'string', group: 'general' },
        { key: 'supportEmail', value: form.supportEmail, type: 'string', group: 'general' },
        { key: 'siteUrl', value: form.siteUrl, type: 'string', group: 'general' },
        // wechat
        { key: 'wechatEnabled', value: form.wechatEnabled, type: 'boolean', group: 'payment' },
        { key: 'wechatAppId', value: form.wechatAppId, type: 'string', group: 'payment' },
        { key: 'wechatMchId', value: form.wechatMchId, type: 'string', group: 'payment' },
        { key: 'wechatApiKey', value: form.wechatApiKey, type: 'string', group: 'payment' },
        { key: 'wechatApiV3Key', value: form.wechatApiV3Key, type: 'string', group: 'payment' },
        { key: 'wechatCertPath', value: form.wechatCertPath, type: 'string', group: 'payment' },
        { key: 'wechatNotifyUrl', value: form.wechatNotifyUrl, type: 'string', group: 'payment' },
        // alipay
        { key: 'alipayEnabled', value: form.alipayEnabled, type: 'boolean', group: 'payment' },
        { key: 'alipayAppId', value: form.alipayAppId, type: 'string', group: 'payment' },
        { key: 'alipayPrivateKey', value: form.alipayPrivateKey, type: 'string', group: 'payment' },
        { key: 'alipayPublicKey', value: form.alipayPublicKey, type: 'string', group: 'payment' },
        { key: 'alipayGateway', value: form.alipayGateway, type: 'string', group: 'payment' },
        { key: 'alipayNotifyUrl', value: form.alipayNotifyUrl, type: 'string', group: 'payment' },
      ]);
      toast.success('设置已保存');
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-80 w-full" /></div>;

  return (
    <div>
      <PageHeader title="系统设置" subtitle="配置平台信息与微信、支付宝支付参数（保存在数据库中，商家密钥不会被写入代码）">
        <Button variant="gradient" onClick={save} disabled={saving}>
          <Save className="mr-1 h-4 w-4" />{saving ? '保存中...' : '保存设置'}
        </Button>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>基础设置</CardTitle><CardDescription>平台名称与联系方式</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Field label="平台名称">
              <Input value={form.appName} onChange={(e) => set('appName', e.target.value)} />
            </Field>
            <Field label="客服邮箱">
              <Input type="email" value={form.supportEmail} onChange={(e) => set('supportEmail', e.target.value)} />
            </Field>
            <Field label="站点地址" hint="用于生成支付回调地址">
              <Input value={form.siteUrl} onChange={(e) => set('siteUrl', e.target.value)} placeholder="https://your-domain.com" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>微信支付</CardTitle>
            <CardDescription>微信 Native 扫码（V2 统一下单），启用后前端生成真实付款二维码</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Toggle
              checked={form.wechatEnabled}
              onChange={(v) => set('wechatEnabled', v)}
              label={form.wechatEnabled ? '已启用' : '未启用'}
            />
            <Field label="APP ID">
              <Input value={form.wechatAppId} onChange={(e) => set('wechatAppId', e.target.value)} placeholder="wx..." />
            </Field>
            <Field label="商户号 MCH ID">
              <Input value={form.wechatMchId} onChange={(e) => set('wechatMchId', e.target.value)} placeholder="商户号" />
            </Field>
            <Field label="API 密钥 (APIv2)" hint="支付平台 -> API安全 -> 设置APIv2密钥">
              <Input type="password" value={form.wechatApiKey} onChange={(e) => set('wechatApiKey', e.target.value)} placeholder="32位密钥" />
            </Field>
            <Field label="APIv3 密钥（可选）" hint="若使用V3接口可填写">
              <Input type="password" value={form.wechatApiV3Key} onChange={(e) => set('wechatApiV3Key', e.target.value)} />
            </Field>
            <Field label="商户证书路径（可选）">
              <Input value={form.wechatCertPath} onChange={(e) => set('wechatCertPath', e.target.value)} placeholder="/path/to/apiclient_cert.pem" />
            </Field>
            <Field label="异步回调地址">
              <Input value={form.wechatNotifyUrl} onChange={(e) => set('wechatNotifyUrl', e.target.value)} placeholder="留空则默认 /api/payments/callback/wechat" />
            </Field>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>支付宝</CardTitle>
            <CardDescription>支付宝当面付/扫码（alipay.trade.precreate），启用后前端生成真实付款链接二维码</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4 lg:col-span-2">
              <Toggle
                checked={form.alipayEnabled}
                onChange={(v) => set('alipayEnabled', v)}
                label={form.alipayEnabled ? '已启用' : '未启用'}
              />
            </div>
            <Field label="APP ID">
              <Input value={form.alipayAppId} onChange={(e) => set('alipayAppId', e.target.value)} placeholder="支付宝开放平台应用APPID" />
            </Field>
            <Field label="支付宝网关">
              <Input value={form.alipayGateway} onChange={(e) => set('alipayGateway', e.target.value)} />
            </Field>
            <Field label="应用私钥 (RSA2)" hint="开放平台密钥工具生成的 应用私钥，用于签名">
              <textarea
                className="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.alipayPrivateKey}
                onChange={(e) => set('alipayPrivateKey', e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----"
              />
            </Field>
            <Field label="支付宝公钥" hint="用于验签回调">
              <textarea
                className="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.alipayPublicKey}
                onChange={(e) => set('alipayPublicKey', e.target.value)}
                placeholder="支付宝公钥内容"
              />
            </Field>
            <Field label="异步回调地址" hint="留空则默认 /api/payments/callback/alipay">
              <Input value={form.alipayNotifyUrl} onChange={(e) => set('alipayNotifyUrl', e.target.value)} />
            </Field>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
