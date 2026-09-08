import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class PlanService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeArchived = false) {
    const where: any = includeArchived
      ? {}
      : { status: { not: 'ARCHIVED' } };

    return this.prisma.plan.findMany({
      where,
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findActive() {
    return this.prisma.plan.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { price: 'asc' }],
    });
  }

  async findById(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  // 套餐可用的服务器列表（购买页选择服务器用）
  async getPlanServers(planId: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const ids = (plan.serverIds || []) as number[];
    if (ids.length === 0) return [];

    const servers = await this.prisma.server.findMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        host: true,
        country: true,
        flag: true,
        status: true,
        protocol: true,
        port: true,
      },
    });

    return servers;
  }

  async create(data: any) {
    return this.prisma.plan.create({ data });
  }

  async update(id: number, data: any) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return this.prisma.plan.update({ where: { id }, data });
  }

  async remove(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');

    const hasOrders = await this.prisma.order.count({
      where: { planId: id, status: { in: ['PAID', 'COMPLETED'] } },
    });
    if (hasOrders > 0) {
      throw new BadRequestException('Cannot delete plan with existing orders');
    }

    await this.prisma.plan.delete({ where: { id } });
    return { message: 'Plan deleted' };
  }

  async getStats() {
    const [totalPlans, activePlans] = await Promise.all([
      this.prisma.plan.count(),
      this.prisma.plan.count({ where: { status: 'ACTIVE' } }),
    ]);
    // 收入按实付口径 COALESCE(payAmount, amount)（amount 恒为原价，优惠券单只收 payAmount）
    const rows = await this.prisma.$queryRaw<{ revenue: number | string }[]>`
      SELECT COALESCE(SUM(COALESCE("payAmount", "amount")), 0) AS revenue
      FROM "Order"
      WHERE "status" = 'COMPLETED'`;

    return {
      totalPlans,
      activePlans,
      totalRevenue: Number((rows[0] as any)?.revenue ?? 0),
    };
  }
}
