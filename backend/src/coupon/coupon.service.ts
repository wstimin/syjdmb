import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { RedisService } from '../common/redis/redis.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // ==========================================
  // 优惠计算（口径唯一，下单/校验共用）
  // ==========================================

  /**
   * 按券与订单原价计算优惠。
   * - PERCENT：value 是「优惠百分比」（如 10 = 打 9 折，优惠 10%），优惠 = 原价 × value/100
   * - AMOUNT：立减 value 元，优惠 = min(value, 原价)
   * - 两者都受 maxDiscount（封顶）约束；实付最低保留 ¥0.01，避免「免费订单」走支付流程
   */
  private computeDiscount(coupon: any, price: number) {
    let discount = 0;
    if (coupon.type === 'PERCENT') {
      discount = (price * Number(coupon.value)) / 100;
    } else {
      discount = Number(coupon.value);
    }
    if (coupon.maxDiscount != null && Number(coupon.maxDiscount) > 0) {
      discount = Math.min(discount, Number(coupon.maxDiscount));
    }
    discount = Math.min(discount, price);
    // 精确到分
    discount = Math.round(discount * 100) / 100;
    const charge = Math.max(0.01, Math.round((price - discount) * 100) / 100);
    return { discount, chargeAmount: charge };
  }

  private normalizeCode(input: string): string {
    return String(input || '').trim().toUpperCase();
  }

  // ==========================================
  // 校验 + 占用（下单调用，下单即占名额，取消时释放）
  // ==========================================

  /**
   * 下单时校验并占用优惠券名额，返回 { couponId, discount, chargeAmount }。
   * - 校验：启用状态 / 有效期内 / 满足最低消费 / 未超总发行量 / 未超每人限用次数
   * - 占名额：原子抢（updateMany 条件 usedCount < totalCount），并发下只有一方能占到
   * - 占用后订单取消（cancel/cancelSelf）必须调 releaseCoupon 释放，否则券会被一直占着
   */
  async applyCoupon(code: string, userId: number, plan: { price: number }): Promise<{
    couponId: number;
    discount: number;
    chargeAmount: number;
  }> {
    const normalized = this.normalizeCode(code);
    if (!normalized) throw new BadRequestException('请输入优惠券码');

    const coupon = await this.prisma.coupon.findUnique({ where: { code: normalized } });
    if (!coupon) throw new BadRequestException('优惠券不存在');

    const now = Date.now();
    if (coupon.status !== 'ACTIVE') throw new BadRequestException('优惠券已停用');
    if (coupon.startAt && now < new Date(coupon.startAt).getTime()) {
      throw new BadRequestException('优惠券尚未开始使用');
    }
    if (coupon.endAt && now > new Date(coupon.endAt).getTime()) {
      throw new BadRequestException('优惠券已过期');
    }

    const price = Number(plan.price);
    if (Number(coupon.minAmount) > 0 && price < Number(coupon.minAmount)) {
      throw new BadRequestException(`本订单满 ¥${Number(coupon.minAmount)} 才可使用该优惠券`);
    }

    // 每人限用次数：统计该用户使用本券的未取消订单（已占名额的 PENDING 也算在内，取消后自然释放）
    // 并发防护：同一用户对同一券的下单串行化，杜绝「两个并发请求都读到 0 次 → 都通过」的竞态绕过。
    const lockKey = `coupon:user:${coupon.id}:${userId}`;
    const lockToken = uuidv4();
    let gotLock = false;
    try {
      gotLock = await this.redis.setNx(lockKey, lockToken, 30);
    } catch (e) {
      // Redis 故障放行（fail-open，不阻塞正当下单）；锁只是防并发，不是安全边界
      this.logger.warn(`优惠券并发锁异常，本次放行: ${(e as Error).message}`);
    }
    if (!gotLock) {
      throw new ConflictException('操作过于频繁，请稍后重试');
    }
    try {
      const myOrders = await this.prisma.order.count({
        where: {
          userId,
          couponId: coupon.id,
          // 退款=交易撤销：被退款的订单不再占「每人限用」名额，用户可复用同一券。
          // 与 approve 退款事务内的 releaseCoupon（回收 usedCount 名额）必须同步上线，
          // 只改一边会让「券名额」和「每人限用」两个计数器错位。
          status: { notIn: ['CANCELLED', 'EXPIRED', 'FAILED', 'REFUNDED'] },
        },
      });
      if (myOrders >= Number(coupon.perUserLimit || 1)) {
        throw new BadRequestException('该优惠券你已使用过，每个用户限用一次');
      }

      // 原子占名额（仅限量券需要；不限量券无竞争）
      if (Number(coupon.totalCount) > 0) {
        const claimed = await this.prisma.coupon.updateMany({
          where: { id: coupon.id, status: 'ACTIVE', usedCount: { lt: coupon.totalCount } },
          data: { usedCount: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw new ConflictException('该优惠券已被领完/停用，请选择其他支付方式');
        }
      } else {
        await this.prisma.coupon.update({
          where: { id: coupon.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      const { discount, chargeAmount } = this.computeDiscount(coupon, price);
      return { couponId: coupon.id, discount, chargeAmount };
    } finally {
      // 只释放自己的锁（token 匹配才删），避免误删下一请求刚拿到的锁
      try {
        const cur = await this.redis.get(lockKey);
        if (cur === lockToken) await this.redis.del(lockKey);
      } catch {
        // 忽略，锁 30s 自动过期
      }
    }
  }

  /**
   * 订单取消/退款时释放占用的名额。
   * tx 可选：传入 Prisma 事务客户端 → 扣减与资金事务原子提交（退款 approve 必须传，
   * 否则券扣减在事务外 autocommit，资金事务回滚后名额仍被扣）；不传 → 独立执行。
   */
  async releaseCoupon(couponId: number, tx?: Prisma.TransactionClient) {
    if (!couponId) return;
    const client = tx || this.prisma;
    await client.coupon.updateMany({
      where: { id: couponId, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
  }

  // ==========================================
  // 用户侧校验（购买页输入时实时显示优惠，不下单不占名额）
  // ==========================================

  async validate(code: string, plan: { price: number }) {
    const normalized = this.normalizeCode(code);
    const coupon = await this.prisma.coupon.findUnique({ where: { code: normalized } });
    if (!coupon) throw new BadRequestException('优惠券不存在');

    const now = Date.now();
    if (coupon.status !== 'ACTIVE') throw new BadRequestException('优惠券已停用');
    if (coupon.startAt && now < new Date(coupon.startAt).getTime()) {
      throw new BadRequestException('优惠券尚未开始使用');
    }
    if (coupon.endAt && now > new Date(coupon.endAt).getTime()) {
      throw new BadRequestException('优惠券已过期');
    }
    const price = Number(plan.price);
    if (Number(coupon.minAmount) > 0 && price < Number(coupon.minAmount)) {
      throw new BadRequestException(`本订单满 ¥${Number(coupon.minAmount)} 才可使用该优惠券`);
    }
    const { discount, chargeAmount } = this.computeDiscount(coupon, price);

    return {
      valid: true,
      coupon: {
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        minAmount: coupon.minAmount,
        maxDiscount: coupon.maxDiscount,
      },
      price,
      discount,
      chargeAmount,
    };
  }

  // ==========================================
  // Admin CRUD
  // ==========================================

  async createCoupon(params: {
    code?: string;
    name: string;
    type: 'PERCENT' | 'AMOUNT';
    value: number;
    minAmount?: number;
    maxDiscount?: number;
    totalCount?: number;
    perUserLimit?: number;
    startAt?: string;
    endAt?: string;
  }) {
    const type = String(params.type || '').toUpperCase();
    if (!['PERCENT', 'AMOUNT'].includes(type)) {
      throw new BadRequestException('优惠类型必须是 PERCENT 或 AMOUNT');
    }
    const couponType = type as 'PERCENT' | 'AMOUNT'; // 收窄为 Prisma 枚举字面量类型
    const value = Number(params.value);
    if (!(value > 0)) throw new BadRequestException('优惠值必须大于 0');
    if (type === 'PERCENT' && value > 100) {
      throw new BadRequestException('折扣百分比不能超过 100');
    }
    if (Number(params.minAmount || 0) < 0) throw new BadRequestException('最低消费不能为负数');
    if (Number(params.totalCount ?? 0) < 0) throw new BadRequestException('发行量不能为负数');
    if (Number(params.perUserLimit ?? 1) < 1) throw new BadRequestException('每人限用次数至少为 1');
    if (params.startAt && params.endAt && new Date(params.endAt) <= new Date(params.startAt)) {
      throw new BadRequestException('失效时间需晚于生效时间');
    }

    // 兑换码：不传则自动生成（大写，带 COUPON- 前缀）
    let code = this.normalizeCode(params.code || '');
    if (!code) code = `COUPON-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          code,
          name: String(params.name || code),
          type: couponType,
          value,
          minAmount: Number(params.minAmount || 0),
          maxDiscount: params.maxDiscount != null ? Number(params.maxDiscount) : null,
          totalCount: Number(params.totalCount ?? 0),
          perUserLimit: Number(params.perUserLimit ?? 1),
          startAt: params.startAt ? new Date(params.startAt) : null,
          endAt: params.endAt ? new Date(params.endAt) : null,
          status: 'ACTIVE',
        },
      });
      return coupon;
    } catch (e: any) {
      if (e && e.code === 'P2002') throw new BadRequestException('该优惠券码已存在');
      throw e;
    }
  }

  async findAll(page = 1, limit = 20, status?: string, search?: string) {
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [list, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.coupon.count({ where }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async update(
    id: number,
    patch: {
      name?: string;
      value?: number;
      minAmount?: number;
      maxDiscount?: number;
      totalCount?: number;
      perUserLimit?: number;
      startAt?: string;
      endAt?: string;
      status?: 'ACTIVE' | 'DISABLED';
    },
  ) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('优惠券不存在');

    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.value !== undefined) {
      if (!(Number(patch.value) > 0)) throw new BadRequestException('优惠值必须大于 0');
      if (coupon.type === 'PERCENT' && Number(patch.value) > 100) {
        throw new BadRequestException('折扣百分比不能超过 100');
      }
      data.value = Number(patch.value);
    }
    if (patch.minAmount !== undefined) {
      if (Number(patch.minAmount) < 0) throw new BadRequestException('最低消费不能为负数');
      data.minAmount = Number(patch.minAmount);
    }
    if (patch.maxDiscount !== undefined) {
      data.maxDiscount = patch.maxDiscount != null ? Number(patch.maxDiscount) : null;
    }
    if (patch.totalCount !== undefined) {
      if (Number(patch.totalCount) < 0) throw new BadRequestException('发行量不能为负数');
      if (Number(patch.totalCount) < Number(coupon.usedCount)) {
        throw new BadRequestException(`发行量不能低于当前已使用数（${coupon.usedCount}）`);
      }
      data.totalCount = Number(patch.totalCount);
    }
    if (patch.perUserLimit !== undefined) {
      if (Number(patch.perUserLimit) < 1) throw new BadRequestException('每人限用次数至少为 1');
      data.perUserLimit = Number(patch.perUserLimit);
    }
    if (patch.startAt !== undefined) data.startAt = patch.startAt ? new Date(patch.startAt) : null;
    if (patch.endAt !== undefined) data.endAt = patch.endAt ? new Date(patch.endAt) : null;
    if (patch.status !== undefined && ['ACTIVE', 'DISABLED'].includes(patch.status)) {
      data.status = patch.status;
    }

    return this.prisma.coupon.update({ where: { id }, data });
  }

  async getStats() {
    const [total, active, disabled, totalUsed] = await Promise.all([
      this.prisma.coupon.count(),
      this.prisma.coupon.count({ where: { status: 'ACTIVE' } }),
      this.prisma.coupon.count({ where: { status: 'DISABLED' } }),
      this.prisma.coupon.aggregate({ _sum: { usedCount: true } }),
    ]);
    return {
      total,
      active,
      disabled,
      totalUsed: totalUsed._sum.usedCount || 0,
    };
  }
}