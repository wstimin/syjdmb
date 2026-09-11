import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class PlanService implements OnModuleInit {
  private readonly logger = new Logger(PlanService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * 启动自愈：对账限量方案的 sold 与现存节点数，修复「删除/退款释放逻辑上线前已删节点
   * sold 清不掉」的遗留问题（与 SOCKS 对账同源）。按「现存非 DELETED 节点数」重算。
   * 包 try/catch：对账失败绝不断服务启动。
   */
  async onModuleInit() {
    try {
      const r = await this.reconcilePlanQuota();
      if (r.changed > 0 || r.restored > 0) {
        this.logger.log(
          `[reconcile] 启动校准完成: 修正 ${r.changed} 项, 恢复在售 ${r.restored} 项`,
        );
      }
    } catch (e) {
      this.logger.error(`[reconcile] 启动对账失败: ${(e as Error).message}`);
    }
  }

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

  /**
   * 对账校准限量方案的可售名额（手动触发 / 启动自愈共用）。
   * 原理：sold 的权威值 = 现存未删除的节点数。节点通过 remark `Order <orderNo>` 归属到
   * 订单，再经 order.planId 归到方案（一个方案单恰好建一个 Inbound，见 activateOrderInner）。
   * ACTIVE/EXPIRED/SUSPENDED 都占名额，只有 DELETED 才算释放。只对账「设置了库存」的方案
   * （无库存方案 sold 不被扣减口径使用）。附带给满额被置 SOLD_OUT 但名额已释放的方案恢复在售。
   * 返回校准统计供前端展示。
   */
  async reconcilePlanQuota() {
    const plans = await this.prisma.plan.findMany({
      where: { stock: { not: null } },
      select: { id: true, name: true, sold: true, stock: true, status: true },
      orderBy: { id: 'asc' },
    });
    // 无限量方案 → 没有可校准对象，直接返回
    if (plans.length === 0) {
      return { total: 0, changed: 0, restored: 0, details: [] };
    }

    // orderNo → planId：remark 只有 `Order <orderNo>`，没有 planId 列，需经订单反查
    const orders = await this.prisma.order.findMany({
      where: { planId: { not: null } },
      select: { orderNo: true, planId: true },
    });
    const planByOrderNo = new Map(orders.map((o) => [o.orderNo, o.planId as number]));
    const liveByPlan = new Map<number, number>(plans.map((p) => [p.id, 0]));

    // 现存未删除的入站按归属方案归组计数（一次拉全量，避免 N+1）
    const inbounds = await this.prisma.inbound.findMany({
      where: { status: { not: 'DELETED' }, remark: { startsWith: 'Order ' } },
      select: { remark: true },
    });
    for (const i of inbounds) {
      const orderNo = i.remark ? i.remark.slice('Order '.length) : '';
      if (!orderNo) continue;
      const planId = planByOrderNo.get(orderNo);
      if (planId == null) continue;
      liveByPlan.set(planId, (liveByPlan.get(planId) ?? 0) + 1);
    }

    const details: any[] = [];
    let changed = 0;
    let restored = 0;
    for (const p of plans) {
      const live = liveByPlan.get(p.id) ?? 0;
      if (live !== p.sold) {
        await this.prisma.plan.update({ where: { id: p.id }, data: { sold: live } });
        changed += 1;
        this.logger.warn(
          `[reconcile] 方案 #${p.id}「${p.name}」sold 校准 ${p.sold} → ${live}（现存未删除节点数）`,
        );
      }
      if (p.stock != null && live < p.stock && p.status === 'SOLD_OUT') {
        await this.prisma.plan.updateMany({
          where: { id: p.id, status: 'SOLD_OUT' },
          data: { status: 'ACTIVE' },
        });
        restored += 1;
        this.logger.log(`[reconcile] 方案 #${p.id}「${p.name}」售罄恢复在售（${live}/${p.stock}）`);
      }
      details.push({ id: p.id, name: p.name, sold: live, stock: p.stock, status: p.status });
    }
    return {
      total: plans.length,
      changed,
      restored,
      details,
    };
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
