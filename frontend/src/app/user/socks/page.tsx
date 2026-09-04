'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Server, Plus, Trash2, Copy, Check } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function SocksPage() {
  const { t } = useI18n();
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  // Form state
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remark, setRemark] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchProxies = () => {
    api.get('/socks/mine')
      .then((res) => setProxies(res.data.data))
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchProxies(); }, []);

  const addProxy = async () => {
    if (!host || !port) {
      toast.error('Host and port required');
      return;
    }
    try {
      await api.post('/socks', {
        host,
        port: Number(port),
        username: username || undefined,
        password: password || undefined,
        remark: remark || undefined,
      });
      toast.success('SOCKS proxy added');
      setDialogOpen(false);
      setHost(''); setPort(''); setUsername(''); setPassword(''); setRemark('');
      fetchProxies();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const deleteProxy = async (id: number) => {
    try {
      await api.delete(`/socks/${id}`);
      toast.success('Deleted');
      fetchProxies();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    }
  };

  const copyConn = async (str: string, key: string) => {
    try {
      await navigator.clipboard.writeText(str);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* ignore */ }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('nodes.socksTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            SOCKS5 中转代理，可将本地代理转为标准SOCKS5
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="gradient" size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t('nodes.addSocks')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('nodes.addSocks')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('nodes.socksHost')} *</Label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="1.2.3.4" />
                </div>
                <div className="space-y-2">
                  <Label>{t('nodes.socksPort')} *</Label>
                  <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1080" type="number" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('nodes.socksUser')}</Label>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{t('nodes.socksPass')}</Label>
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>备注 / Remark</Label>
                <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
              </div>
              <Button className="w-full" variant="gradient" onClick={addProxy}>
                {t('nodes.add')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {proxies.length === 0 ? (
        <div className="py-20 text-center">
          <Server className="mx-auto h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">暂无SOCKS中转 / No SOCKS proxies yet</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {proxies.map((p, idx) => (
            <motion.div key={p.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}>
              <Card className="border-border/60">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-primary" />
                      <span className="font-medium">{p.remark || `${p.host}:${p.port}`}</span>
                    </div>
                    <Badge variant={p.status === 'ACTIVE' ? 'success' : 'warning'}>
                      {p.status === 'ACTIVE' ? t('nodes.active') : 'INACTIVE'}
                    </Badge>
                  </div>
                  <div className="mt-3 rounded-lg bg-muted/50 p-3 font-mono text-xs">
                    {p.connectionString}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => copyConn(p.connectionString, p.id)}>
                      {copied === p.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => deleteProxy(p.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
