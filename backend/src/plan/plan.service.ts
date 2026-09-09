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
    // 售罄方案保留展示（前端打「已售罄」遮罩），隐藏/下架的不出现在商城
    return this.prisma.plan.findMany({
      where: { status: { in: ['ACTIVE', 'SOLD_OUT'] } },
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
    // 限量：库存至少 1（0 或负数没有可售内容）；sold 走 schema 默认 0
    if (data.stock != null && data.stock < 1) {
      throw new BadRequestException('库存至少为 1');
    }
    return this.prisma.plan.create({ data });
  }

  async update(id: number, data: any) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');

    // 编辑库存时不得低于已售数量（否则已完成的订单会超出库存）
    if (data.stock != null && data.stock < plan.sold) {
      throw new BadRequestException(`库存不能低于已售数量（已售 ${plan.sold}）`);
    }

    // 显式手动置回「在售」但库存已售罄 → 拦截（防绕过限量）
    if (data.status === 'ACTIVE' && plan.stock != null && plan.sold >= plan.stock) {
      throw new BadRequestException('库存已售罄，请先调高库存');
    }

    // 未显式传状态：售罄方案被调高库存后自动恢复在售（重新开卖）
    if (!data.status && plan.status === 'SOLD_OUT') {
      const nextStock = data.stock ?? plan.stock;
      if (nextStock != null && nextStock > plan.sold) {
        data.status = 'ACTIVE';
      }
    }

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
    const [totalPlans, activePlans, soldOutPlans] = await Promise.all([
      this.prisma.plan.count(),
      this.prisma.plan.count({ where: { status: 'ACTIVE' } }),
      this.prisma.plan.count({ where: { status: 'SOLD_OUT' } }),
    ]);
    // 收入按实付口径 COALESCE(payAmount, amount)（amount 恒为原价，优惠券单只收 payAmount）
    const rows = await this.prisma.$queryRaw<{ revenue: number | string }[]>`
      SELECT COALESCE(SUM(COALESCE("payAmount", "amount")), 0) AS revenue
      FROM "Order"
      WHERE "status" = 'COMPLETED'`;

    return {
      totalPlans,
      activePlans,
      soldOutPlans,
      totalRevenue: Number((rows[0] as any)?.revenue ?? 0),
    };
  }
}
