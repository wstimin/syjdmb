// JWT 密钥安全加载
// 生产环境必须显式配置足够强的 JWT_SECRET；缺失或过短直接抛错拒绝启动——
// 否则任何人都能用公开的默认密钥离线伪造管理员令牌（等同于无密码后台）。
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET 未设置或长度不足 16 位：生产环境必须配置强密钥，否则登录令牌可被伪造。' +
        '请在环境变量中配置 JWT_SECRET（可用 openssl rand -hex 32 生成）。',
    );
  }
  console.warn('[auth] 警告：JWT_SECRET 未设置，正在使用开发默认密钥（仅限本地开发环境）');
  return 'dev-only-insecure-jwt-secret-do-not-use-in-production';
}