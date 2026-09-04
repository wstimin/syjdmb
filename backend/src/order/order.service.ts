import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
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

    const order = await this.prisma.order.create({
      data: {
        orderNo,
        userId,
        planId,
        amount: plan.price,
        status: 'PENDING',
        payMethod: params.payMethod as any,
        relayEnabled: relay,
        relaySocksHost: relay ? params.relaySocksHost : null,
        relaySocksPort: relay ? params.relaySocksPort : null,
        relaySocksUser: relay ? params.relaySocksUser : null,
        relaySocksPass: relay ? params.relaySocksPass : null,
      },
    });

    return order;
  }

  // ==========================================
  // Payment Then Activate
  // ==========================================

  // 用余额支付
  async payWithBalance(userId: number, orderId: number) {
    return this.prisma.$transaction(async (tx) => {
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
  }

  // 支付成功后激活节点（核心流程）
  async activateOrder(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID' && order.status !== 'PENDING') {
      throw new ConflictException('Order cannot be activated');
    }

    // Select server
    const preferredProtocol = order.plan.protocols[0] || 'vless';
    const serverId = await this.serverService.selectServer(
      preferredProtocol,
      order.plan.serverIds?.[0],
    );

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
