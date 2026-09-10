import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class SystemService {
  constructor(private prisma: PrismaService) {}

  async getSettings(group?: string) {
    const where: any = {};
    if (group) where.group = group;

    const settings = await this.prisma.systemSetting.findMany({ where });
    const result: Record<string, any> = {};
    for (const s of settings) {
      result[s.key] = this.parseValue(s.value, s.type);
    }
    return result;
  }

  async setSettings(settings: { key: string; value: any; type?: string; group?: string; remark?: string }[]) {
    for (const setting of settings) {
      const value = typeof setting.value === 'object'
        ? JSON.stringify(setting.value)
        : String(setting.value);

      await this.prisma.systemSetting.upsert({
        where: { key: setting.key },
        update: { value, type: setting.type || 'string', group: setting.group || 'general' },
        create: {
          key: setting.key,
          value,
          type: setting.type || 'string',
          group: setting.group || 'general',
          remark: setting.remark,
        },
      });
    }
    return { success: true };
  }

  async getSetting(key: string) {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!setting) return null;
    return this.parseValue(setting.value, setting.type);
  }

  /**
   * 公开端点：只暴露 general 组（appName/supportEmail/siteUrl），不暴露支付/邮件密钥。
   * siteUrl 为空时 fallback 到环境变量（APP_URL / FRONTEND_URL），供前端 SSR 使用。
   */
  async getGeneralPublic() {
    const s = await this.prisma.systemSetting.findMany({ where: { group: 'general' } });
    const map: Record<string, any> = {};
    for (const row of s) map[row.key] = this.parseValue(row.value, row.type);
    return {
      appName: map.appName || 'NodeShop',
      supportEmail: map.supportEmail || '',
      siteUrl: map.siteUrl || process.env.FRONTEND_URL || process.env.APP_URL || '',
    };
  }

  private parseValue(value: string, type: string): any {
    switch (type) {
      case 'number': return Number(value);
      case 'boolean': return value === 'true' || value === '1';
      case 'json': try { return JSON.parse(value); } catch { return value; }
      default: return value;
    }
  }

  // Dashboard financial overview
  async getFinanceOverview() {
    // 收入按实付口径（COALESCE("payAmount","amount")，amount 恒为原价）：
    // 与 order.service.getStats 同口径，否则 ¥100 订单用券实付 ¥5，退款影响显示为 ¥100——20 倍失真。
    const revenue = await this.prisma.$queryRaw<{ revenue: number | string; cnt: number | string }[]>`
      SELECT COALESCE(SUM(COALESCE("payAmount", "amount")), 0) AS revenue,
             COUNT(*) AS cnt
      FROM "Order"
      WHERE "status" = 'COMPLETED'`;

    // 已退款统计（管理页「退款净额」展示，让退款作为冲减可见而非叠加进流水）
    const refundAgg = await this.prisma.refundRequest.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const [transactions, cards, daysAgo30, protocolGroups] = await Promise.all([
      // Recent orders as financial transactions (Order has user relation; Transaction model = TicketMessage)
      // 已退款订单剔除：退款单不是收入，不能混进「交易记录」当成交
      this.prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { email: true, username: true } } },
        where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      }),
      this.prisma.card.aggregate({
        where: { status: 'USED' },
        _sum: { amount: true },
      }),
      this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          paidAt: { gte: this.daysAgo(30) },
        },
        select: { payAmount: true, amount: true, paidAt: true },
      }),
      this.prisma.inbound.groupBy({
        by: ['protocol'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);

    // 收入趋势：近30天按天聚合真实 COMPLETED 订单实付金额（与收入口径一致）
    const revenueMap = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = this.daysAgo(i);
      revenueMap.set(this.formatDay(d), 0);
    }
    for (const o of daysAgo30) {
      if (!o.paidAt) continue;
      const day = this.formatDay(o.paidAt);
      revenueMap.set(day, (revenueMap.get(day) || 0) + Number(o.payAmount ?? o.amount));
    }
    const revenueData = Array.from(revenueMap.entries()).map(([date, revenue]) => ({
      date,
      revenue: Math.round(revenue * 100) / 100,
    }));

    // 协议分布：真实活跃节点按协议统计
    const protocolData = protocolGroups.map((g) => ({
      name: g.protocol,
      value: g._count._all,
    }));

    return {
      totalRevenue: Number((revenue as any)[0]?.revenue ?? 0),
      totalOrders: Number((revenue as any)[0]?.cnt ?? 0),
      refundedAmount: Number(refundAgg._sum.amount || 0),
      refundedCount: refundAgg._count._all,
      cardRevenue: cards._sum.amount || 0,
      recentTransactions: transactions,
      revenueData,
      protocolData,
    };
  }

  private daysAgo(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private formatDay(d: Date): string {
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}
