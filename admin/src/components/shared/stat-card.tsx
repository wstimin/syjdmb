'use client';

import { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';

/** 统计卡片：标题 + 数值 + 可选副标题/颜色。 */
export function StatCard({
  title,
  value,
  sub,
  color,
}: {
  title: string;
  value: ReactNode;
  sub?: string;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{title}</div>
        <div className="text-xl font-bold" style={color ? { color } : undefined}>{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
