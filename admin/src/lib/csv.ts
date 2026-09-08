'use client';

/**
 * 导出 CSV：用 Blob + a[download] 触发下载。兼容与否不依赖 clipboard。
 * @param rows 数组对象（key 为列名，value 做字符串化 / 跳过 null/undefined）
 * @param filename 不带后缀
 */
export function exportToCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.map(escape).join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
