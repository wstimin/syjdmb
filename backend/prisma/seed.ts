import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@nodeshop.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'admin123456';

  const hashed = await bcrypt.hash(password, 12);

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      password: hashed,
      username: 'admin',
      role: 'SUPER_ADMIN',
      referralCode: 'ADMIN001',
    },
  });
  console.log(`✅ Admin created: ${admin.email} / ${password}`);

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
