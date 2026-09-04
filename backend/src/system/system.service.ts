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
    const [revenue, transactions, cards, daysAgo30, protocolGroups] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true,
      }),
      // Recent orders as financial transactions (Order has user relation; Transaction model = TicketMessage)
      this.prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { email: true, username: true } } },
        where: { status: { not: 'CANCELLED' } },
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
        select: { amount: true, paidAt: true },
      }),
      this.prisma.inbound.groupBy({
        by: ['protocol'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);

    // 收入趋势：近30天按天聚合真实 COMPLETED 订单金额
    const revenueMap = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = this.daysAgo(i);
      revenueMap.set(this.formatDay(d), 0);
    }
    for (const o of daysAgo30) {
      if (!o.paidAt) continue;
      const day = this.formatDay(o.paidAt);
      revenueMap.set(day, (revenueMap.get(day) || 0) + Number(o.amount));
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
      totalRevenue: revenue._sum.amount || 0,
      totalOrders: revenue._count,
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
