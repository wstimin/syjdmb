'use client';

import { ReactNode } from 'react';

interface DataTableColumn<T extends object> {
  key: keyof T | string;
  header: string;
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T extends object> {
  columns: DataTableColumn<T>[];
  data: T[];
  keyField: string;
  emptyMessage?: string;
}

export function DataTable<T extends object>({ columns, data, keyField, emptyMessage = '暂无数据' }: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((col) => (
              <th key={String(col.key)} className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={String((row as any)[keyField])} className="border-b transition-colors hover:bg-muted/40">
                {columns.map((col) => (
                  <td key={String(col.key)} className="px-4 py-3 whitespace-nowrap">
                    {col.render ? col.render(row) : String((row as any)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ACTIVE: { label: '活跃', cls: 'bg-emerald-500/15 text-emerald-600' },
    COMPLETED: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-600' },
    PENDING: { label: '待支付', cls: 'bg-amber-500/15 text-amber-600' },
    PROCESSING: { label: '处理中', cls: 'bg-blue-500/15 text-blue-600' },
    EXPIRED: { label: '已过期', cls: 'bg-gray-500/15 text-gray-600' },
    CANCELLED: { label: '已取消', cls: 'bg-gray-500/15 text-gray-600' },
    SUSPENDED: { label: '已暂停', cls: 'bg-amber-500/15 text-amber-600' },
    USED: { label: '已使用', cls: 'bg-emerald-500/15 text-emerald-600' },
    UNUSED: { label: '未使用', cls: 'bg-blue-500/15 text-blue-600' },
    OFFLINE: { label: '离线', cls: 'bg-red-500/15 text-red-600' },
    DELETED: { label: '已删除', cls: 'bg-gray-500/15 text-gray-600' },
  };
  const s = map[status] || { label: status, cls: 'bg-gray-500/15 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
  );
}
