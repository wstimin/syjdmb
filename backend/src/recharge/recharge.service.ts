import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { SystemService } from '../system/system.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RechargeService {
  private readonly logger = new Logger(RechargeService.name);

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
    private systemService: SystemService,
  ) {}

  // ==========================================
  // 创建直充单（余额充值）
  // ==========================================

  async create(userId: number, amount: number) {
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!(amt > 0)) throw new BadRequestException('充值金额必须大于 0');
    if (amt > 50000) throw new BadRequestException('单笔充值金额不能超过 50000 元');

    const recharge = await this.prisma.recharge.create({
      data: {
        orderNo: this.generateOrderNo(),
        userId,
        amount: amt,
        status: 'PENDING',
      },
    });

    return {
      id: recharge.id,
      orderNo: recharge.orderNo,
      amount: recharge.amount,
      status: recharge.status,
      createdAt: recharge.createdAt,
    };
  }

  // ==========================================
  // 拉起网关支付（微信 / 支付宝）
  // ==========================================

  async createPayment(userId: number, orderNo: string, method: string) {
    const recharge = await this.prisma.recharge.findUnique({ where: { orderNo } });
    if (!recharge) throw new NotFoundException('充值订单不存在');
    if (recharge.userId !== userId) throw new BadRequestException('不是你的充值订单');
    if (recharge.status !== 'PENDING') throw new BadRequestException('充值订单已处理');

    // 复用商品单同一套微信/支付宝下单逻辑（ref.type='recharge' 时支付方式落到 recharge 表）
    return this.paymentService.createGatewayRefPayment(
      {
        id: recharge.id,
        orderNo: recharge.orderNo,
        amount: Number(recharge.amount),
        subject: '余额充值',
        type: 'recharge',
      },
      method,
    );
  }

  // ==========================================
  // 状态查询（前端轮询）
  // ==========================================

  async getStatus(userId: number, orderNo: string) {
    const recharge = await this.prisma.recharge.findUnique({ where: { orderNo } });
    if (!recharge) throw new NotFoundException('充值订单不存在');
    if (recharge.userId !== userId) throw new BadRequestException('不是你的充值订单');

    return {
      orderNo: recharge.orderNo,
      status: recharge.status,
      paid: recharge.status === 'PAID',
      amount: recharge.amount,
      createdAt: recharge.createdAt,
    };
  }

  // ==========================================
  // 我的充值记录
  // ==========================================

  async getMine(userId: number, page = 1, limit = 20) {
    const [list, total] = await Promise.all([
      this.prisma.recharge.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.recharge.count({ where: { userId } }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // 取消直充单（仅未发起支付时允许）
  // ==========================================

  async cancel(userId: number, orderNo: string) {
    const recharge = await this.prisma.recharge.findUnique({ where: { orderNo } });
    if (!recharge) throw new NotFoundException('充值订单不存在');
    if (recharge.userId !== userId) throw new BadRequestException('不是你的充值订单');
    if (recharge.status !== 'PENDING') throw new ConflictException('充值订单已处理，无法取消');
    // 已生成支付二维码/链接的不允许取消：网关延迟到账时钱已收，避免「取消后仍入账」产单
    if (recharge.payMethod && ['WECHAT', 'ALIPAY'].includes(recharge.payMethod)) {
      throw new ConflictException('已发起支付（二维码已生成），暂不能取消，请等待支付结果');
    }

    // CAS 原子取消：把「未发起支付」作为更新条件而不是先读后写。
    // 否则与 createPayment 并发时（先读到 PENDING/null，随后支付刚生成二维码），
    // 无条件 update 会把单子取消掉——用户扫码付了钱，却因 CANCELLED 被终态拒绝入账。
    const updated = await this.prisma.recharge.updateMany({
      where: {
        id: recharge.id,
        status: 'PENDING',
        payMethod: null,
      },
      data: { status: 'CANCELLED' },
    });
    if (updated.count === 0) {
      const cur = await this.prisma.recharge.findUnique({
        where: { id: recharge.id },
        select: { status: true },
      });
      if (cur && cur.status === 'CANCELLED') {
        return this.prisma.recharge.findUnique({ where: { id: recharge.id } });
      }
      throw new ConflictException('充值单已发起支付或已处理，无法取消');
    }
    return this.prisma.recharge.findUnique({ where: { id: recharge.id } });
  }

  // ==========================================
  // Admin
  // ==========================================

  async findAll(page = 1, limit = 20, status?: string, search?: string) {
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    if (search) {
      where.OR = [
        { orderNo: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [list, total] = await Promise.all([
      this.prisma.recharge.findMany({
        where,
        include: { user: { select: { email: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.recharge.count({ where }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // 超时自动关闭（每 2 分钟扫一次）
  // ==========================================

  /**
   * 清理「已发起充值支付但一直未付款/未完成」的 PENDING 充值单：
   * - 超时分钟数跟随后台订单超时配置 orderExpireMinutes（默认 15），与商品单一致。
   * - 用户拉起充值二维码不付款 / 支付未获回调确认，单子永久 PENDING；
   *   这里 CAS 置 EXPIRED（幂等），与商品单 expireStaleGatewayOrders 同一套收敛约束。
   * - EXPIRED 为终态：迟到回调会被拒收，需走后台「人工确认收款」入账。
   */
  @Cron('*/2 * * * *')
  async expireStaleRecharges() {
    const minutes =
      Number(await this.systemService.getSetting('orderExpireMinutes').catch(() => null)) || 15;
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const stale = await this.prisma.recharge.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 200,
    });
    for (const r of stale) {
      await this.prisma.recharge.updateMany({
        where: { id: r.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    }
    if (stale.length) this.logger.log(`Expired ${stale.length} stale PENDING recharges`);
  }

  private generateOrderNo(): string {
    const date = new Date();
    const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const random = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
    return `RC${ymd}${random}`;
  }
}