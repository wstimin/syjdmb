import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // 【对抗复核确认：默认口令后门】旧实现按 email upsert —— 管理员在后台改过登录邮箱后，
  // 每次跑 seed 都找不到默认邮箱，会用默认口令 admin123456 凭空再造一个 SUPER_ADMIN
  // （永不禁用、永不删除的生产后门）。修复：只在「全新库（User 表一条都没有）」时才引导
  // 创建默认管理员用于首次登录；一旦库里已有任何用户（无论是否还有 SUPER_ADMIN），都
  // 不创建也不改口令。绝不能靠 create 补一个默认口令账号 —— 若超管被删除/降级，应由
  // deploy.sh 菜单 4（cmd_reset_login）在无超管时人工重建，而不是 seed 自动补一个。
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    console.log('ℹ️  用户表已非空，跳过管理员创建/口令重置（避免重建默认口令后门）；若需重置管理员请用 deploy.sh 菜单 4');
  } else {
    const email = process.env.SEED_ADMIN_EMAIL || 'admin@nodeshop.com';
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin123456';
    const hashed = await bcrypt.hash(password, 12);
    const admin = await prisma.user.create({
      data: {
        email,
        password: hashed,
        username: 'admin',
        role: 'SUPER_ADMIN',
        referralCode: 'ADMIN001',
      },
    });
    console.log(`✅ Admin created: ${admin.email} / ${password}`);
  }

  // Initial system settings
  const settings = [
    // general
    { key: 'appName', value: 'NodeShop', type: 'string', group: 'general' },
    { key: 'supportEmail', value: 'support@nodeshop.com', type: 'string', group: 'general' },
    { key: 'siteUrl', value: '', type: 'string', group: 'general' },
    // wechat pay
    { key: 'wechatEnabled', value: 'false', type: 'boolean', group: 'payment' },
    { key: 'wechatAppId', value: '', type: 'string', group: 'payment' },
    { key: 'wechatMchId', value: '', type: 'string', group: 'payment' },
    { key: 'wechatApiKey', value: '', type: 'string', group: 'payment' },
    { key: 'wechatApiV3Key', value: '', type: 'string', group: 'payment' },
    { key: 'wechatCertPath', value: '', type: 'string', group: 'payment' },
    { key: 'wechatNotifyUrl', value: '', type: 'string', group: 'payment' },
    // alipay
    { key: 'alipayEnabled', value: 'false', type: 'boolean', group: 'payment' },
    { key: 'alipayAppId', value: '', type: 'string', group: 'payment' },
    { key: 'alipayPrivateKey', value: '', type: 'string', group: 'payment' },
    { key: 'alipayPublicKey', value: '', type: 'string', group: 'payment' },
    { key: 'alipayGateway', value: 'https://openapi.alipay.com/gateway.do', type: 'string', group: 'payment' },
    { key: 'alipayNotifyUrl', value: '', type: 'string', group: 'payment' },
  ];
  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }
  console.log('✅ System settings initialized');
  console.log('ℹ️  无预置演示套餐：请到管理后台「套餐管理」创建真实套餐后再开放售卖');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
