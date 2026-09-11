import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

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
    if (!plan) throw new NotFoundException('方案不存在');
    return plan;
  }

  // 套餐可用的服务器列表（购买页选择服务器用）
  async getPlanServers(planId: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('方案不存在');

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
    if (!plan) throw new NotFoundException('方案不存在');

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

  /**
   * 释放网络方案的一个可售名额（sold -1）。
   * - 与 order 激活时 sold+1（限量方案 CAS 扣减）对称补充：节点被删除（管理员删除 / 到期自动
   *   清理）/ 订单退款后名额回归，否则 sold 只增不减会让「已售 n/stock」虚高，且限量方案下
   *   createOrder 的 sold>=stock 仍会拦掉后来的买家。
   * - 幂等/并发安全：where sold > 0 保证下限不为负；同一方案多个节点并发删除各减各自份额。
   * - sold 减到位后若方案此前因满额被自动置为 SOLD_OUT 且现在有空位 → 恢复 ACTIVE（对称于激活
   *   满额置 SOLD_OUT 的自动逻辑）；仅限 SOLD_OUT，绝不覆盖管理员的显式 HIDDEN/ARCHIVED。
   */
  async releasePlanQuota(planId: number) {
    await this.prisma.plan.updateMany({
      where: { id: planId, sold: { gt: 0 } },
      data: { sold: { decrement: 1 } },
    });
    const latest = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { sold: true, stock: true, status: true },
    });
    if (
      latest &&
      latest.stock != null &&
      latest.sold < latest.stock &&
      latest.status === 'SOLD_OUT'
    ) {
      await this.prisma.plan.updateMany({
        where: { id: planId, status: 'SOLD_OUT' },
        data: { status: 'ACTIVE' },
      });
      this.logger.log(
        `Plan quota released for plan #${planId}: sold ${latest.sold}/${latest.stock} — plan back to ACTIVE`,
      );
    }
  }

  async remove(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('方案不存在');

    const hasOrders = await this.prisma.order.count({
      where: { planId: id, status: { in: ['PAID', 'COMPLETED'] } },
    });
    if (hasOrders > 0) {
      throw new BadRequestException('该方案已有订单，无法删除');
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
