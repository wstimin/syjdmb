import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { CouponService } from '../coupon/coupon.service';
import { InboundService } from '../inbound/inbound.service';
import { EmailService } from '../email/email.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * 退款申请 → 审批 → 退款入余额。
 *
 * 语义（与全系统口径统一）：
 * - 退款金额 = 订单实付（payAmount ?? amount，优惠券后金额），申请时快照。
 * - 退款去向 = 退回用户余额（微信/支付宝原路退回不在本站范围）。
 * - 审批通过 = 订单置 REFUNDED（终态）+ 余额入账 + REFUND 流水 + 停节点 + 回收券名额。
 *
 * 已知取舍（写入代码注释）：
 * - 「先退钱、后停节点」：停节点在资金事务提交后执行，面板失败只记日志不阻断退款，
 *   钱安全第一；节点由管理员人工核（adminNote 追加提示）。
 * - 退款回余额而非原路退回；续费单/充值单退款走人工调整（userService.adjustBalance）。
 * - 优惠券名额回收后允许用户复用同一券——逐单人工审批，行为可见可控。
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  /** 单用户最多几条 PENDING 申请（防刷；靠 Redis 锁保证计数与创建不并发撕裂） */
  private readonly MAX_PENDING_PER_USER = 5;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private couponService: CouponService,
    private inboundService: InboundService,
    private emailService: EmailService,
  ) {}

  // ==========================================
  // 用户申请退款
  // ==========================================

  /**
   * 校验 + 创建在同一事务内，杜绝「校验读到 COMPLETED → 并发审批把订单置 REFUNDED → 创建落库」的竞态。
   * 跨订单并发防刷（同用户 PENDING ≤ 5）用 Redis 锁串行化：计数与创建都在锁内。
   */
  async create(userId: number, orderId?: number, reason?: string) {
    if (!orderId) throw new BadRequestException('订单 ID 必填');
    if (!reason || !String(reason).trim()) throw new BadRequestException('请填写退款理由');

    // 同用户退款申请串行化（复用 applyCoupon 的锁形状：setNx + token 匹配才释放 + fail-open）
    const lockKey = `refund:user:${userId}`;
    const lockToken = uuidv4();
    let gotLock = false;
    try {
      gotLock = await this.redis.setNx(lockKey, lockToken, 30);
    } catch (e) {
      // Redis 故障放行（fail-open，不阻塞正常申请）；锁只是防并发，不是安全边界
      this.logger.warn(`退款申请锁异常，本次放行: ${(e as Error).message}`);
    }
    if (!gotLock) {
      throw new ConflictException('操作过于频繁，请稍后重试');
    }

    try {
      // 锁内数 PENDING：并发下多个申请不会被计数撕裂出上限（TOCTOU 修复）
      const pendingCount = await this.prisma.refundRequest.count({
        where: { userId, status: 'PENDING' },
      });
      if (pendingCount >= this.MAX_PENDING_PER_USER) {
        throw new BadRequestException(`待审核的退款申请已达上限（${this.MAX_PENDING_PER_USER} 条），请等待处理后再申请`);
      }

      try {
        const req = await this.prisma.$transaction(async (tx) => {
          const order = await tx.order.findFirst({ where: { id: orderId, userId } });
          if (!order) throw new NotFoundException('订单不存在');
          if (order.status !== 'COMPLETED') {
            throw new ConflictException('只有已完成的订单可以申请退款');
          }
          if (order.renewalOfInboundId) {
            throw new BadRequestException('续费订单不支持退款，涉及费用问题请联系客服处理');
          }
          // 有真实付款凭据才可退款：手动激活（adminActivate）未收款的订单不能被退钱
          if (!order.payMethod && !order.tradeNo) {
            throw new BadRequestException('该订单没有支付记录，不支持退款');
          }
          const amount = Number(order.payAmount ?? order.amount);
          if (!(amount > 0)) throw new BadRequestException('订单金额异常，无法退款');

          return tx.refundRequest.create({
            data: {
              orderId: order.id,
              userId,
              reason: String(reason).trim(),
              amount,
            },
          });
        });
        return req;
      } catch (e: any) {
        // 同订单并发重复申请：unique([orderId, status=PENDING]) 兜底 → 友好提示
        if (e && e.code === 'P2002') {
          throw new ConflictException('该订单已提交过退款申请，请等待审核');
        }
        throw e;
      }
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

  // ==========================================
  // 我的退款申请
  // ==========================================

  async getMine(userId: number, page = 1, limit = 20) {
    const [list, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where: { userId },
        include: {
          order: { select: { orderNo: true, plan: { select: { name: true } }, amount: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refundRequest.count({ where: { userId } }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // 用户自行撤销（申请错了/改主意了）
  // ==========================================

  async cancelSelf(userId: number, id: number) {
    // CAS 原子撤销：只认领属于本人的 PENDING 申请
    const updated = await this.prisma.refundRequest.updateMany({
      where: { id, userId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (updated.count === 0) {
      throw new ConflictException('该申请不存在或已被处理，无法撤销');
    }
    return this.prisma.refundRequest.findUnique({ where: { id } });
  }

  // ==========================================
  // Admin：全部申请（筛选 / 搜索）
  // ==========================================

  async findAll(page = 1, limit = 20, status?: string, search?: string) {
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    if (search) {
      where.OR = [
        { order: { orderNo: { contains: search } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [list, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where,
        include: {
          order: { select: { orderNo: true, plan: { select: { name: true } }, amount: true, payAmount: true } },
          user: { select: { email: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // Admin：审批 → 退款入余额
  // ==========================================

  /**
   * 核心：单 $transaction（认领 + 入账 + 流水 + 券回收原子），绝无「订单已退款但钱没退」窗口。
   * 并发双击审批 → 只有一方双认领都 count=1，另一方 409 回滚 —— 绝不二次入账。
   */
  async approve(id: number, adminId: number) {
    const req = await this.prisma.refundRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('退款申请不存在');
    if (req.status !== 'PENDING') {
      throw new ConflictException('该退款申请已处理');
    }

    const amount = Number(req.amount);
    const refundId = req.id;

    // 资金事务。任何一步抛错整个回滚，认领/入账/流水/券回收要么全成、要么全不成。
    const committed = await this.prisma.$transaction(async (tx) => {
      // ① 认领退款申请：PENDING → APPROVED（只认领这一条）
      const claimReq = await tx.refundRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() },
      });
      if (claimReq.count === 0) throw new ConflictException('该退款申请已被处理');

      // ② 认领订单：COMPLETED → REFUNDED（终态）。这条 count 检查是「防二次入账」的最后闸门：
      //    若并发下已有一条申请被审批通过（订单已 REFUNDED），这里 count=0 → 回滚，绝不重复入账。
      const claimOrder = await tx.order.updateMany({
        where: { id: req.orderId, status: 'COMPLETED' },
        data: { status: 'REFUNDED' },
      });
      if (claimOrder.count === 0) {
        throw new ConflictException('订单状态已变更（可能已退款），无法重复退款');
      }

      // 订单号 + 券归属一次性取（退款请求可能落在审批途中，这里在事务内重读，保证与认领一致）
      const order = await tx.order.findUnique({
        where: { id: req.orderId },
        select: { orderNo: true, couponId: true },
      });
      const orderNo = order?.orderNo || '';

      // ③ 余额入账（原子递增，返回递增后真实余额供流水快照）
      const user = await tx.user.update({
        where: { id: req.userId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });

      // ④ REFUND 流水（amount 记正数，余额方向由前端 txSign 显示为 +；relatedId=orderNo 提供溯源）
      await tx.transaction.create({
        data: {
          userId: req.userId,
          type: 'REFUND',
          amount,
          balance: user.balance,
          description: `订单 ${orderNo} 退款`,
          relatedId: orderNo,
        },
      });

      // ⑤ 回收优惠券名额：必须把 tx client 传进去，否则券扣减在事务外 autocommit，
      //    资金事务回滚后名额仍被扣（限量券被多扣 / 回滚不一致）。
      if (order?.couponId) {
        await this.couponService.releaseCoupon(order.couponId, tx);
      }

      return { userId: req.userId, orderNo, amount };
    });

    // ============ 事务提交后（网络 IO / 通知不进资金事务） ============

    // 停节点：按 remark contains 'Order <orderNo>' 找该订单创建的节点 → 面板停用 + 本地 SUSPENDED。
    // 失败只记日志 + adminNote 提示，不阻断已提交的退款（先保钱，再保节点）。
    this.suspendOrderNodes(committed.userId, committed.orderNo, refundId).catch(() => {});

    // 邮件通知用户（approve 与 reject 都有；节点被停前用户先知道原因）
    this.notifyUser(committed.userId, 'approve', committed.orderNo, committed.amount, undefined).catch(() => {});

    return { success: true, refund: committed };
  }

  /**
   * 停用该订单创建的所有节点（remark 约定 `Order <orderNo>`，与 activateOrder 共用同一查找模式）。
   * 面板失败不影响已提交的退款——钱已退，节点留给管理员人工核。
   */
  private async suspendOrderNodes(userId: number, orderNo: string, refundId: number) {
    if (!orderNo) return;
    try {
      const inbounds = await this.prisma.inbound.findMany({
        where: { userId, remark: { contains: `Order ${orderNo}` }, status: { notIn: ['DELETED'] } },
        select: { id: true },
      });
      let failed = 0;
      for (const inbound of inbounds) {
        try {
          await this.inboundService.suspend(inbound.id);
        } catch (e) {
          failed += 1;
          this.logger.warn(`退款后停节点失败 inbound=${inbound.id}: ${(e as Error).message}`);
        }
      }
      if (failed > 0) {
        await this.prisma.refundRequest.update({
          where: { id: refundId },
          data: { adminNote: '退款已完成；部分节点面板停用失败，需管理员人工核实（钱已退，请尽快处理）' },
        });
      }
    } catch (e) {
      this.logger.warn(`退款后查询节点失败: ${(e as Error).message}`);
    }
  }

  /** 退款结果邮件（尽力而为，不阻断主流程；EmailService 内部对未启用/失败只告警不抛错） */
  private async notifyUser(
    userId: number,
    kind: 'approve' | 'reject',
    orderNo: string,
    amount: number,
    note?: string,
  ) {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user?.email) return;

      if (kind === 'approve') {
        await this.emailService.send({
          to: user.email,
          subject: '退款已到账',
          html: this.emailService.wrap(
            '退款已到账',
            `<p>您好：</p>
             <p>您对订单 <b>${this.emailService.escapeHtml(orderNo)}</b> 的退款申请已审批通过，退款金额 <b>¥${amount}</b> 已退回您的账户余额（非原支付渠道）。</p>
             <p>该订单对应的节点将被停用。如有疑问，请联系客服。</p>`,
          ),
        });
      } else {
        await this.emailService.send({
          to: user.email,
          subject: '退款申请未通过',
          html: this.emailService.wrap(
            '退款申请未通过',
            `<p>您好：</p>
             <p>您对订单 <b>${this.emailService.escapeHtml(orderNo)}</b> 的退款申请未通过审核。</p>
             <p style="color:#6b7280;">审批意见：${this.emailService.escapeHtml(note || '—')}</p>
             <p>如有疑问，请联系客服。</p>`,
          ),
        });
      }
    } catch (e) {
      this.logger.warn(`退款邮件通知失败 userId=${userId}: ${(e as Error).message}`);
    }
  }

  // ==========================================
  // Admin：拒绝（备注必填）
  // ==========================================

  async reject(id: number, adminId: number, note?: string) {
    const noteText = String(note || '').trim();
    if (!noteText) throw new BadRequestException('请填写审批意见（用户与邮件都会看到该备注）');

    const updated = await this.prisma.refundRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', adminNote: noteText, reviewedBy: adminId, reviewedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new ConflictException('该退款申请已被处理');
    }

    const req = await this.prisma.refundRequest.findUnique({
      where: { id },
      include: { order: { select: { orderNo: true } } },
    });
    if (req) {
      this.notifyUser(req.userId, 'reject', req.order?.orderNo || '', Number(req.amount), noteText).catch(() => {});
    }

    return { success: true };
  }
}