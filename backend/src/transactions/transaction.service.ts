import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class TransactionService {
  constructor(private prisma: PrismaService) {}

  /** 我的余额流水（分页，按时间倒序） */
  async getMine(userId: number, page = 1, limit = 20) {
    const [list, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where: { userId } }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** 管理端全量流水（可按类型筛选 / 按邮箱搜索） */
  async findAll(page = 1, limit = 20, type?: string, search?: string) {
    const where: any = {};
    if (type && type !== 'ALL') where.type = type;
    if (search) {
      // Transaction 表无 User 关联，先按邮箱查 userId 交集
      const users = await this.prisma.user.findMany({
        where: { email: { contains: search, mode: 'insensitive' } },
        select: { id: true },
        take: 200,
      });
      where.userId = { in: users.map((u) => u.id) };
      if (users.length === 0) {
        return { list: [], total: 0, page, limit, totalPages: 0 };
      }
    }

    const [list, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    // 批量取用户名补齐展示（Transaction 表无外键关联，避免加迁移约束）
    const userIds = [...new Set(list.map((t) => t.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, username: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return {
      list: list.map((t) => ({ ...t, user: userMap.get(t.userId) || null })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** 管理端：按类型汇总（充值/消费/退款/卡密/返利/人工调整） */
  async getStats() {
    const rows = await this.prisma.transaction.groupBy({
      by: ['type'],
      _sum: { amount: true },
      _count: { _all: true },
    });
    const result: Record<string, { amount: number; count: number }> = {};
    for (const r of rows) {
      result[r.type] = { amount: Number(r._sum.amount || 0), count: r._count._all };
    }
    // 汇总进出
    // 注意：totalOut 是「资金流出(毛)」——余额支付的订单（PURCHASE -amount）若又被退款（REFUND +amount），
    // 两个方向都会计入毛流出（2×amount），即使净流出为 0。这是有意的毛口径，
    // 退款数额单独在 refundTotal 中给出，管理页展示为冲减而非叠加（见 refunds 模块）。
    const inflowTypes = ['RECHARGE', 'CARD_REDEEM', 'REFERRAL'];
    const outflowTypes = ['PURCHASE', 'REFUND'];
    let totalIn = 0;
    let totalOut = 0;
    for (const r of rows) {
      const amt = Number(r._sum.amount || 0);
      if (inflowTypes.includes(r.type)) totalIn += amt;
      else if (outflowTypes.includes(r.type)) totalOut += Math.abs(amt);
    }
    const refundTotal = result['REFUND'] ? Math.abs(result['REFUND'].amount) : 0;
    return { byType: result, totalIn, totalOut, refundTotal };
  }
}