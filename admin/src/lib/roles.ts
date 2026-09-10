// 角色枚举 → 中文标签（管理后台全局统一展示）
export const ROLE_LABELS: Record<string, string> = {
  USER: '普通用户',
  ADMIN: '管理员',
  SUPER_ADMIN: '超级管理员',
};

// 角色下拉选项（新建/编辑用户共用）
export const ROLE_OPTIONS = [
  { value: 'USER', label: '普通用户' },
  { value: 'ADMIN', label: '管理员' },
  { value: 'SUPER_ADMIN', label: '超级管理员' },
];