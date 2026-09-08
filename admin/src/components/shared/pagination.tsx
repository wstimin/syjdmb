'use client';

/**
 * 通用分页组件：复用后端返回的 { page, limit, total, totalPages }。
 * 支持页码切换 + 每页条数选择。
 */
export default function Pagination({
  page,
  limit,
  total,
  totalPages,
  onPageChange,
  onLimitChange,
}: {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onLimitChange?: (limit: number) => void;
}) {
  if (total === 0) return null;

  const pages: (number | '...')[] = [];
  const max = 7;
  if (totalPages <= max) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + max - 1);
    if (start > 1) pages.push(1, '...');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages) pages.push('...', totalPages);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <div className="text-xs text-muted-foreground">
        共 {total} 条 · 第 {page}/{totalPages || 1} 页
      </div>
      <div className="flex items-center gap-1">
        {onLimitChange && (
          <select
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="mr-2 rounded-md border bg-background px-2 py-1 text-xs"
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>{n} 条/页</option>
            ))}
          </select>
        )}
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
        >
          上一页
        </button>
        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="px-1 text-xs text-muted-foreground">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                p === page ? 'bg-primary text-white border-primary' : ''
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
