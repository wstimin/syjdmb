'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { MessageSquare, Plus } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function TicketsPage() {
  const { t } = useI18n();
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchTickets = () => {
    api.get('/tickets/mine')
      .then((res) => setTickets(res.data.data.tickets))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchTickets(); }, []);

  const createTicket = async () => {
    if (!subject || !message) {
      toast.error('Subject and message required');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/tickets', { subject, message });
      toast.success('Ticket created');
      setDialogOpen(false);
      setSubject(''); setMessage('');
      fetchTickets();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="space-y-4"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('tickets.title')}</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="gradient" size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t('tickets.new')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('tickets.new')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('tickets.subject')}</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t('tickets.message')}</Label>
                <textarea
                  className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>
              <Button className="w-full" variant="gradient" onClick={createTicket} disabled={submitting}>
                {t('tickets.submit')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {tickets.length === 0 ? (
        <div className="py-20 text-center">
          <MessageSquare className="mx-auto h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-muted-foreground">No tickets</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket, idx) => (
            <motion.div key={ticket.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}>
              <Card className="border-border/60">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <div className="font-medium">{ticket.subject}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {new Date(ticket.updatedAt).toLocaleString()} · {ticket._count?.messages || ticket.messages?.length || 0} messages
                    </div>
                  </div>
                  <Badge variant={ticket.status === 'CLOSED' ? 'secondary' : 'warning'}>
                    {t('tickets.' + ticket.status.toLowerCase())}
                  </Badge>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
