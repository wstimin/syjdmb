import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { InboundService } from '../inbound/inbound.service';
import { ServerService } from '../server/server.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private prisma: PrismaService,
    private inboundService: InboundService,
    private serverService: ServerService,
    private redis: RedisService,
  ) {}

  // ==========================================
  // Create Order
  // ==========================================

  async createOrder(params: {
    userId: number;
    planId: number;
    payMethod?: string;
    serverId?: number;
    protocol?: string;
    quantity?: number;
    relay?: boolean;          // 购买时勾选中转
    relaySocksHost?: string;  // 用户填写的 SOCKS 节点地址（出口 IP）
    relaySocksPort?: number;
    relaySocksUser?: string;
    relaySocksPass?: string;
  }) {
    const { userId, planId } = params;

    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== 'ACTIVE') throw new BadRequestException('Plan is not available');

    const orderNo = this.generateOrderNo();

    const relay = !!params.relay;
    // 勾选中转但没填 SOCKS 地址/端口 → 直接报错，避免下单后激活时才发现
    if (relay && (!params.relaySocksHost || !params.relaySocksPort)) {
      throw new BadRequestException('开启中转需要填写 SOCKS 节点的地址和端口');
    }

    // 服务器选择：只允许套餐绑定的服务器；未传则取第一个绑定（激活时兜底自动选）
    let serverId: number | null = null;
    if (params.serverId) {
      const boundIds = (plan.serverIds || []) as number[];
      if (!boundIds.includes(params.serverId)) {
        throw new BadRequestException('所选服务器不在该套餐的可用服务器列表中');
      }
      serverId = params.serverId;
    }

    // 协议：系统默认 vless（vless+reality）；不存用户选择
    const protocol = 'vless';

    const order = await this.prisma.order.create({
      data: {
        orderNo,
        userId,
        planId,
        amount: plan.price,
        status: 'PENDING',
        payMethod: (params.payMethod ? String(params.payMethod).toUpperCase() : null) as any,
        relayEnabled: relay,
        relaySocksHost: relay ? params.relaySocksHost : null,
        relaySocksPort: relay ? params.relaySocksPort : null,
        relaySocksUser: relay ? params.relaySocksUser : null,
        relaySocksPass: relay ? params.relaySocksPass : null,
        serverId,
        protocol,
      },
    });

    return order;
  }

  // ==========================================
  // Payment Then Activate
  // ==========================================

  // 用余额支付
  async payWithBalance(userId: number, orderId: number) {
    // 事务只做扣款+标记，避免把 XUI 网络调用（建节点）拖进长事务
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { plan: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'PENDING') throw new ConflictException('Order already processed');
      if (order.userId !== userId) throw new BadRequestException('Not your order');

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      const amount = Number(order.amount);
      if (Number(user.balance) < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      // Deduct balance
      await tx.user.update({
        where: { id: userId },
        data: { balance: Number(user.balance) - amount },
      });

      // Record transaction
      await tx.transaction.create({
        data: {
          userId,
          type: 'PURCHASE',
          amount: -amount,
          balance: Number(user.balance) - amount,
          description: `Purchase plan: ${order.plan.name}`,
          relatedId: order.orderNo,
        },
      });

      // Mark order as paid
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'PAID', paidAt: new Date(), payMethod: 'BALANCE' },
      });

      return { success: true, order };
    });

    // 事务提交后再激活（自动创建节点；失败则由后台 cron 兜底重试）
    try {
      const activation = await this.activateOrder(orderId);
      return { ...result, activation };
    } catch (e) {
      this.logger.error(`Balance payment activated failed for order ${orderId}: ${e.message}`);
      // 订单已是 PAID，交给 autoActivate cron 重试
      return { ...result, activationFailed: true, message: e.message };
    }
  }

  // 支付成功后激活节点（核心流程）
  async activateOrder(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!['PAID', 'PENDING', 'PROCESSING'].includes(order.status)) {
      throw new ConflictException('Order cannot be activated');
    }
    // 避免重复激活：已 COMPLETED 直接返回
    if (['PAID', 'PENDING', 'PROCESSING'].includes(order.status)) {
      const existing = await this.prisma.inbound.findFirst({
        where: { userId: order.userId, remark: { contains: `Order ${order.orderNo}` } },
      });
      if (existing) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: 'COMPLETED' },
        });
        return { inbound: existing, order: { ...order, status: 'COMPLETED' } };
      }
    }

    // Select server：优先用户下单时选的服务器；否则负载均衡选
    const preferredProtocol =
      order.protocol || (order.plan.protocols?.includes('vless') ? 'vless' : order.plan.protocols?.[0] || 'vless');
    const serverId = order.serverId
      ? await this.serverService.selectServer(preferredProtocol, order.serverId)
      : await this.serverService.selectServer(preferredProtocol, order.plan.serverIds?.[0]);

    // Create inbound in XUI
    const inbound = await this.inboundService.createInbound({
      userId: order.userId,
      plan: order.plan,
      serverId,
      protocol: preferredProtocol,
      relay: !!order.relayEnabled, // 购买时勾选中转 → 在该源节点上挂 SOCKS
      relaySocksHost: order.relaySocksHost || undefined,
      relaySocksPort: order.relaySocksPort || undefined,
      relaySocksUser: order.relaySocksUser || undefined,
      relaySocksPass: order.relaySocksPass || undefined,
      orderNo: order.orderNo,
    });

    // Update order status
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        paidAt: order.paidAt || new Date(),
      },
    });

    return { inbound, order };
  }

  /**
   * 兜底重试：每分钟扫描已支付/激活失败的订单，自动建节点直到成功。
   * PAID：已支付但从未激活（如网关回调后未被激活的存量单）
   * PROCESSING：激活失败的单子（面板瞬时故障等）
   * 带防重入：Redis SETNX 锁，避免多实例重叠跑。
   */
  @Cron('*/1 * * * *')
  async autoActivatePending() {
    const lockKey = 'order:autoActivate:lock';
    const gotLock = await this.redis.setNx(lockKey, '1', 55).catch(() => false);
    if (!gotLock) return; // 另一个实例/上一轮还在跑

    try {
      const cutoff = new Date(Date.now() - 60_000);
      const orders = await this.prisma.order.findMany({
        where: { status: { in: ['PAID', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
        include: { plan: true },
        take: 20,
      });

      for (const order of orders) {
        try {
          await this.activateOrder(order.id);
          this.logger.log(`Auto-activated order ${order.orderNo} (${order.status} → COMPLETED)`);
        } catch (e) {
          this.logger.warn(`Auto-activate order ${order.orderNo} failed: ${e.message}`);
          // 保持 PROCESSING，下一次 cron 重试
          if (order.status === 'PAID') {
            await this.prisma.order.update({
              where: { id: order.id },
              data: { status: 'PROCESSING' },
            });
          }
        }
      }
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  // ==========================================
  // Queries
  // ==========================================

  async getUserOrders(userId: number, page = 1, limit = 20) {
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        include: { plan: { select: { name: true, duration: true, traffic: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { userId } }),
    ]);

    return { orders, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findAll(page = 1, limit = 20, status?: string, search?: string) {
    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { orderNo: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          plan: { select: { name: true } },
          user: { select: { email: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { orders, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const order = await this.prisma.order.findFirst({
      where,
      include: { plan: true, user: { select: { email: true, username: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ==========================================
  // Admin Operations
  // ==========================================

  async adminActivate(id: number) {
    // Mark as paid then activate
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    if (order.status === 'PENDING') {
      await this.prisma.order.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date() },
      });
    }

    return this.activateOrder(id);
  }

  async cancel(id: number, reason = '') {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    if (!['PENDING', 'FAILED'].includes(order.status)) {
      throw new ConflictException('Order cannot be cancelled');
    }

    return this.prisma.order.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  async getStats() {
    const now = new Date();
    const startOfToday = new Date(now.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [todaySummary, monthSummary, totalSummary, pendingCount] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', createdAt: { gte: startOfToday } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED', createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      today: { revenue: todaySummary._sum.amount || 0, orders: todaySummary._count },
      month: { revenue: monthSummary._sum.amount || 0, orders: monthSummary._count },
      total: { revenue: totalSummary._sum.amount || 0, orders: totalSummary._count },
      pending: pendingCount,
    };
  }

  private generateOrderNo(): string {
    const date = new Date();
    const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const random = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
    return `SO${ymd}${random}`;
  }
}
