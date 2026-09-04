'use client';

import { cn } from '@/lib/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'secondary' | 'outline';
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: 'bg-primary/15 text-primary border-primary/20',
    success: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
    warning: 'bg-amber-500/15 text-amber-500 border-amber-500/20',
    danger: 'bg-red-500/15 text-red-500 border-red-500/20',
    secondary: 'bg-secondary text-secondary-foreground border-transparent',
    outline: 'border border-input text-foreground',
  };
  return (
    <div className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', variants[variant], className)} {...props} />
  );
}
