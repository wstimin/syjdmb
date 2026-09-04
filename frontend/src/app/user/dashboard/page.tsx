'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Wallet, Server, Clock, Activity, Plus, ArrowRight } from 'lucide-react';
import { api, useAuth, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const [stats, setStats] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      api.get('/orders/mine?limit=5'),
      api.get('/inbounds/mine'),
    ])
      .then(([o, n]) => {
        setOrders(o.data.data.orders);
        setNodes(n.data.data);
      })
      .catch((err) => toast.error(getErrorMessage(err)));
  }, [user]);

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  // Calculate traffic usage across nodes
  const totalUsed = nodes.reduce((s, n) => s + (Number(n.totalTraffic) || 0), 0);
  const totalLimit = nodes.reduce((s, n) => s + (Number(n.trafficLimit) || 0), 0);
  const usagePct = totalLimit > 0 ? Math.min(100, (totalUsed / totalLimit) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Welcome banner */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="relative overflow-hidden border-border/60">
          <div className="pointer-events-none absolute inset-0 bg-gradient-primary opacity-10" />
          <CardContent className="relative p-6">
            <h1 className="text-2xl font-bold">
              {t('dashboard.welcome')}, {user?.username || user?.email.split('@')[0]} 👋
            </h1>
            <p className="mt-1 text-muted-foreground">{t('common.appName')}</p>
          </CardContent>
        </Card>
      </motion.div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="flex items-center justify-between p-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.balance')}</p>
              <p className="mt-1 text-2xl font-bold text-primary">¥{Number(user?.balance || 0)}</p>
            </div>
            <Wallet className="h-8 w-8 text-muted-foreground/50" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.nodes')}</p>
              <p className="mt-1 text-2xl font-bold">{nodes.length}</p>
            </div>
            <Server className="h-8 w-8 text-muted-foreground/50" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.trafficUsed')}</p>
              <p className="mt-1 text-2xl font-bold">
                {totalUsed > 0 ? `${(totalUsed / 1024 / 1024 / 1024).toFixed(2)}GB` : '0GB'}
              </p>
            </div>
            <Activity className="h-8 w-8 text-muted-foreground/50" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between p-6">
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.usageRate')}</p>
              <p className="mt-1 text-2xl font-bold">{usagePct.toFixed(0)}%</p>
            </div>
            <Clock className="h-8 w-8 text-muted-foreground/50" />
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-3">
        <Link href="/products">
          <Button variant="gradient">
            <Plus className="mr-1 h-4 w-4" />
            {t('dashboard.buyNew')}
          </Button>
        </Link>
        <Link href="/user/nodes">
          <Button variant="outline">
            {t('dashboard.viewNodes')}
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </Link>
        <Link href="/user/tickets">
          <Button variant="outline">{t('dashboard.support')}</Button>
        </Link>
      </div>

      {/* Recent orders */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t('dashboard.recentOrders')}</CardTitle>
          <Link href="/user/orders" className="text-sm text-primary hover:underline">View all</Link>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">No orders yet</p>
          ) : (
            <div className="space-y-3">
              {orders.map((order) => (
                <div key={order.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium">{order.plan?.name}</div>
                    <div className="text-xs text-muted-foreground">{order.orderNo}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-primary">¥{Number(order.amount)}</span>
                    <Badge
                      variant={
                        order.status === 'COMPLETED' ? 'success' :
                        order.status === 'PENDING' ? 'warning' : 'secondary'
                      }
                    >
                      {order.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
