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
import { CouponService } from '../coupon/coupon.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private prisma: PrismaService,
    private inboundService: InboundService,
    private serverService: ServerService,
    private redis: RedisService,
    private couponService: CouponService,
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
    relaySocksId?: number;    // 用户在台账里选的 SOCKS 代理 ID（优先于此路径取值 host/port）
    relaySocksHost?: string;  // 兜底：手填的 SOCKS 节点地址（出口 IP）
    relaySocksPort?: number;
    relaySocksUser?: string;
    relaySocksPass?: string;
    renewalOfInboundId?: number; // 续费单：对已有节点续期/续流量（激活时走 bulkAdjust，不建新节点）
    couponCode?: string;      // 优惠券码（下单即占名额，取消时释放）
  }) {
    const { userId, planId } = params;

    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== 'ACTIVE') throw new BadRequestException('Plan is not available');

    const orderNo = this.generateOrderNo();

    // 优惠券占用放在最后一刻（所有校验通过后、落库前再占名额）：
    // 不能用「先占名额再校验」——校验抛错时订单行不存在，没有任何取消路径能释放名额，
    // 限量券会被永远占死。占用与校验见 claimCouponData()。

    // ---- 续费模式：对已有节点续期/续流量（激活时 panel bulkAdjust 加量，不建新节点）----
    const renewalOfInboundId = params.renewalOfInboundId;
    if (renewalOfInboundId) {
      // 目标节点必须属于当前用户且未软删除；管理员暂停（SUSPENDED）不允许续费（不复活管理停用节点）
      const inbound = await this.prisma.inbound.findFirst({
        where: { id: renewalOfInboundId, userId, status: { not: 'DELETED' } },
      });
      if (!inbound) throw new NotFoundException('目标节点不存在');
      if (inbound.status === 'SUSPENDED') {
        throw new BadRequestException('该节点已被管理员暂停，暂无法续费，请联系客服');
      }
      // 套餐必须能加量：时长或流量至少有一个（纯 UNLIMITED 套餐对续费无意义）
      if (!(plan.duration > 0 || Number(plan.traffic) > 0)) {
        throw new BadRequestException('该套餐无可续内容（需包含时长或流量）');
      }
      // 能力校验：节点【不限时/不限流量】时，对应加量会被面板 bulkAdjust 跳过 → 白付钱，先拦下
      if (plan.duration > 0 && !inbound.expiryTime) {
        throw new BadRequestException('该节点为不限时套餐，无需续期');
      }
      if (Number(plan.traffic) > 0 && (!inbound.trafficLimit || Number(inbound.trafficLimit) <= 0)) {
        throw new BadRequestException('该节点为不限流量套餐，无需充值流量');
      }
      if (params.relay) {
        throw new BadRequestException('续费无需开启 SOCKS 中转');
      }

      // 所有续费校验都通过后才占优惠券名额（校验抛错不会泄漏名额）
      const couponOrderData = await this.claimCouponData(params.couponCode, userId, plan as any);

      const order = await this.createOrderRow({
        orderNo,
        userId,
        planId,
        amount: plan.price,
        ...couponOrderData,
        status: 'PENDING',
        payMethod: (params.payMethod ? String(params.payMethod).toUpperCase() : null) as any,
        renewalOfInboundId,
      });
      return order;
    }

    const relay = !!params.relay;
    if (!relay) {
      // 未勾选中转：清空 relay 相关字段
      params = { ...params, relaySocksId: undefined, relaySocksHost: undefined, relaySocksPort: undefined, relaySocksUser: undefined, relaySocksPass: undefined };
    }

    // 台账选择优先：勾选中转且传了 relaySocksId → 从用户台账记录取值 host/port/user/pass，
    // 校验该代理属于当前用户且为 ACTIVE。手填 host/port 仅作兜底。
    let relayHost = params.relaySocksHost;
    let relayPort = params.relaySocksPort;
    let relayUser = params.relaySocksUser;
    let relayPass = params.relaySocksPass;
    if (relay && params.relaySocksId) {
      const proxy = await this.prisma.socksProxy.findFirst({
        where: { id: params.relaySocksId, userId, status: 'ACTIVE' },
      });
      if (!proxy) {
        throw new BadRequestException('所选 SOCKS 代理不存在或不可用');
      }
      relayHost = proxy.host;
      relayPort = proxy.port;
      relayUser = proxy.username || undefined;
      relayPass = proxy.password || undefined;
    }
    // 勾选中转但既没选台账也没手填地址/端口 → 直接报错，避免下单后激活时才发现
    if (relay && (!relayHost || !relayPort)) {
      throw new BadRequestException('开启中转需要选择或填写 SOCKS 节点的地址和端口');
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

    // 服务器可用性校验：套餐绑定了服务器就只在这些里查，没绑定则查全局；
    // 一台 ACTIVE 都没有 → 下单注定激活失败，直接拦下，避免「付了钱节点建不出来」
    const boundIds = (plan.serverIds || []) as number[];
    const availableCount =
      boundIds.length > 0
        ? await this.prisma.server.count({ where: { id: { in: boundIds }, status: 'ACTIVE' } })
        : await this.prisma.server.count({ where: { status: 'ACTIVE' } });
    if (availableCount === 0) {
      throw new BadRequestException('该套餐暂无可用服务器');
    }

    // 所有校验都通过后才占优惠券名额（校验抛错不会泄漏名额）
    const couponOrderData = await this.claimCouponData(params.couponCode, userId, plan as any);

    const order = await this.createOrderRow({
      orderNo,
      userId,
      planId,
      amount: plan.price,
      ...couponOrderData,
      status: 'PENDING',
      payMethod: (params.payMethod ? String(params.payMethod).toUpperCase() : null) as any,
      relayEnabled: relay,
      relaySocksHost: relay ? relayHost : null,
      relaySocksPort: relay ? relayPort : null,
      relaySocksUser: relay ? relayUser : null,
      relaySocksPass: relay ? relayPass : null,
      serverId,
      protocol,
    });

    return order;
  }

  /**
   * 落库订单行；若落库失败（极端情况）退回已占用的优惠券名额，避免名额被白占。
   */
  private async createOrderRow(data: any): Promise<any> {
    try {
      return await this.prisma.order.create({ data });
    } catch (e) {
      if (data.couponId) await this.couponService.releaseCoupon(data.couponId);
      throw e;
    }
  }

  /**
   * 优惠券占用（在 createOrder 的最后一步调用）：
   * - applyCoupon 会原子抢占 usedCount（并发只有一方成功）
   * - 占用成功后若 createOrderRow 落库失败，releaseCoupon 会把名额退回
   * 只有「校验全部通过 → 占名额 → 落库」的顺序才能保证校验失败时名额不被永久占用。
   */
  private async claimCouponData(couponCode: string | undefined, userId: number, plan: { price: number }) {
    if (!couponCode) return {};
    const applied = await this.couponService.applyCoupon(couponCode, userId, plan);
    return {
      payAmount: applied.chargeAmount,
      couponId: applied.couponId,
      couponAppliedAmount: applied.discount,
    };
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

      // 实付金额：优惠券后金额（payAmount）；amount 恒为原价
      const amount = Number(order.payAmount ?? order.amount);
      if (Number(user.balance) < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      // 原子条件扣款：余额 ≥ 金额才允许扣（并发余额变动也不会互相覆盖，
      // 绝不会出现「两个请求都读到余额充足 → 都扣成功 → 余额变负数/丢一笔」）
      let updatedUser: any;
      try {
        updatedUser = await tx.user.update({
          where: { id: userId, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
      } catch (e: any) {
        if (e && e.code === 'P2025') throw new BadRequestException('Insufficient balance');
        throw e;
      }

      // Record transaction（交易后余额 = 条件扣款后的真实值）
      await tx.transaction.create({
        data: {
          userId,
          type: 'PURCHASE',
          amount: -amount,
          balance: updatedUser.balance,
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
  // 认领式激活：先 CAS 抢占为 PROCESSING 再干活，并发（余额支付 vs cron vs 管理端手动激活）
  // 只有一方能拿到；没拿到的一方走幂等分支，绝不重复建节点。
  async activateOrder(orderId: number, requestedUserId?: number) {
    // 归属校验：用户主动激活只能操作自己的订单（cron / 余额支付 / 管理端等内部调用不传 userId，跳过）
    if (requestedUserId !== undefined) {
      const ownerCheck = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true },
      });
      if (!ownerCheck || ownerCheck.userId !== requestedUserId) {
        throw new NotFoundException('Order not found');
      }
    }

    // 认领条件（关键安全约束）：
    // - 绝不允许 PENDING（未付款）订单被激活 —— 此前 PENDING 也在认领集合里，
    //   等于任何登录用户可以用 /orders/:id/activate 白嫖建节点。现在只有已支付(PAID)才能激活。
    // - PROCESSING 只允许「上一轮中断超过 60 秒」的订单被 cron 重试，
    //   防止回调/余额支付与 cron 并发双跑重复建节点/重复加量。
    const cutoff = new Date(Date.now() - 60_000);
    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        OR: [{ status: 'PAID' }, { status: 'PROCESSING', updatedAt: { lt: cutoff } }],
      },
      data: { status: 'PROCESSING' },
    });
    if (claim.count === 0) {
      // 订单已在别处被认领，或已是终态（COMPLETED/CANCELLED/FAILED）：
      // COMPLETED 且有节点 → 把存量幂等返回
      const later = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!later) throw new NotFoundException('Order not found');
      if (later.status === 'COMPLETED') {
        const existing = await this.prisma.inbound.findFirst({
          where: { userId: later.userId, remark: { contains: `Order ${later.orderNo}` } },
        });
        if (existing) return { inbound: existing, order: later };
      }
      throw new ConflictException('Order cannot be activated');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    // 续费单：不建新节点，给已有节点续期/续流量（面板 bulkAdjust 加量并自动重启节点）
    if (order.renewalOfInboundId) {
      return this.activateRenewal(order);
    }

    // 防重复建：上一次激活可能「面板入站建好了、但回写 COMPLETED 前进程崩溃」，
    // 认领后先查存量；有就直接恢复 COMPLETED，不回滚
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

  // ==========================================
  // Renewal Activation (续期 / 续流量)
  // ==========================================

  /**
   * 续费激活：给已有节点追加时长/流量。
   * 面板侧用 bulkAdjust（addDays/addBytes）—— 加量后自动检测「耗尽被停用」的客户端，
   * 一旦不再耗尽就 BulkSetEnable(true) + 重载 Xray，即续费后节点自动复活重启。
   * 绝不能走 /clients/update/{email}（全量替换会把 totalGB/expiryTime 清空）。
   *
   * 崩溃安全：本地先增量（+renewalAppliedAt 标记，订单留 PROCESSING）→ 面板调用 →
   * 失败回滚本地。cron 兜底重试时若 renewalAppliedAt 已设 → settleRenewalIfApplied 对账，
   * 已生效就完结、未生效就回滚重来，绝不对同一订单重复调面板（防止加量加倍）。
   */
  private async activateRenewal(order: any) {
    const inbound = await this.prisma.inbound.findUnique({
      where: { id: order.renewalOfInboundId },
    });
    if (!inbound || inbound.userId !== order.userId || inbound.status === 'DELETED') {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('目标节点不存在或已被删除，续费失败');
    }
    if (inbound.status === 'SUSPENDED') {
      // 管理停用的节点不因续费复活；置 FAILED（避免 cron 无限重试），人工退款/处理
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('该节点已被管理员暂停，无法续费，请联系客服');
    }

    // 幂等：本地已应用过（上次在面板调用前后崩溃）→ 对账完结，杜绝重复加量
    if (order.renewalAppliedAt) {
      return this.settleRenewalIfApplied(order, inbound);
    }

    const plan = order.plan;
    // 注释：addDays 仅当 plan.duration>0 且节点有限期；addBytes 仅当 plan.traffic>0 且节点限流量。
    // 无限期/不限流量的对应加量会被面板 bulkAdjust 跳过（下单选套餐时已拦过，这里再防御一次）。
    const addDays = plan.duration > 0 && inbound.expiryTime ? plan.duration : 0;
    const addBytes =
      plan.traffic > 0 && inbound.trafficLimit && Number(inbound.trafficLimit) > 0
        ? Number(plan.traffic)
        : 0;
    if (addDays === 0 && addBytes === 0) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('该套餐无可加量内容，续费失败');
    }

    const oldExpiry = inbound.expiryTime; // Date | null
    const oldStatus = inbound.status;

    // 1) 本地先增量（崩溃安全：提交后即使面板调用前进程死掉，cron 也能靠 renewalAppliedAt 对账）
    const newExpiry =
      addDays > 0
        ? new Date((oldExpiry ? oldExpiry.getTime() : Date.now()) + addDays * 24 * 3600 * 1000)
        : oldExpiry;
    const newLimit = addBytes > 0 ? BigInt(Number(inbound.trafficLimit) + addBytes) : inbound.trafficLimit;
    await this.prisma.$transaction([
      this.prisma.inbound.update({
        where: { id: inbound.id },
        data: {
          ...(newExpiry ? { expiryTime: newExpiry } : {}),
          ...(addBytes > 0 ? { trafficLimit: newLimit } : {}),
          status: 'ACTIVE', // EXPIRED→ACTIVE（复活）；ACTIVE 保持不变
          // 重置到期提醒档位：新周期从「3 天内」开始重新提醒，否则旧的 24h 档位
          // 会让整轮新周期静默（档位门控 stage <= 已发出的最高档 直接跳过）
          expiryReminderStage: 0,
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { renewalAppliedAt: new Date() },
      }),
    ]);

    // 2) 面板加量（bulkAdjust 自动重新启用被停用的客户端并重载 Xray）
    const panelRes = await this.serverService.adjustClientQuota(
      inbound.serverId,
      inbound.email,
      addDays,
      addBytes,
    );
    if (!panelRes?.success) {
      // 3) 面板失败 → 回滚本地增量，订单留 PROCESSING 交给 cron 下轮重试
      this.logger.error(
        `Renewal bulkAdjust failed for order ${order.orderNo}: ${panelRes?.msg || 'unknown'}`,
      );
      await this.rollbackRenewalLocal(order, inbound, { expiry: oldExpiry, status: oldStatus });
      throw new BadRequestException(`面板加量失败：${panelRes?.msg || '未知错误'}`);
    }

    // 4) 成功 → 完结订单
    const done = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
    });
    const freshInbound = await this.prisma.inbound.findUnique({ where: { id: inbound.id } });
    this.logger.log(
      `Renewal applied order ${order.orderNo}: +${addDays}d / +${addBytes}B on ${inbound.email}`,
    );
    return { inbound: freshInbound, order: done };
  }

  /**
   * 崩溃对账：renewalAppliedAt 已设但订单未 COMPLETED（上次在面板调用前后进程崩溃）。
   * 读面板核对是否已生效：已生效 → 直接完结；未生效 → 回滚本地增量（清标记），
   * 让 cron 下一轮重新走完整 apply（本地增量与面板都只发生一次）。
   */
  private async settleRenewalIfApplied(order: any, inbound: any) {
    const traffic = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
    const obj = traffic?.obj || {};
    const plan = order.plan;
    let applied = false;

    const extendedExpiry = plan.duration > 0 && inbound.expiryTime;
    const addedBytes = plan.traffic > 0 && inbound.trafficLimit && Number(inbound.trafficLimit) > 0;

    if (extendedExpiry) {
      // 续期：面板到期时间（ms）应 ≥ 本地续后到期（本地已增量，二者同源同公式）。
      // 面板流量记录的 JSON 键是驼峰 expiryTime（internal/xray/client_traffic.go:14），
      // 不是 expiry_time —— 读错键会恒为 0，导致纯时长续费被误判「未生效」而无限回滚重试。
      const localExpiryMs = new Date(inbound.expiryTime).getTime();
      applied = Number(obj.expiryTime || 0) >= localExpiryMs;
    }
    if (!applied && addedBytes) {
      // 仅续流量（或续期未生效说明整体未应用）：面板剩余配额 + 已用 应 ≥ 本地续后额度 - 容差
      // 容差 10MB 吸收对账瞬间的并发用量（否则已生效会被误判为未生效 → 重复加量）
      const used = Number(obj.up || 0) + Number(obj.down || 0);
      const localLimit = Number(inbound.trafficLimit);
      const slack = 10 * 1024 * 1024;
      applied = Number(obj.total || 0) + used >= localLimit - slack;
    }

    if (applied) {
      const done = await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
      });
      this.logger.log(`Renewal order ${order.orderNo} verified applied on panel, completed`);
      return { inbound, order: done };
    }

    // 面板没有这次加量 → 回滚本地（按相同公式减回去）+ 清标记，下一次 cron 完整重来
    this.logger.warn(
      `Renewal order ${order.orderNo} not applied on panel, rolling back local changes`,
    );
    await this.rollbackRenewalLocal(order, inbound, {
      expiry: null, // 由 rollbackRenewalLocal 按公式重算，见下
      status: null,
    });
    throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
  }

  /**
   * 回滚续费本地增量：按与 apply 相同的公式把 inbound 的 expiryTime/trafficLimit 减回去，
   * 清掉订单的 renewalAppliedAt 标记。
   * - expiry: 传入回滚后应恢复的到期时间；传 null 时按 (当前到期 - addDays) 重算（对账回滚场景）。
   * - status: 传入回滚后应恢复的状态；传 null 时按面板用量重算（已耗尽 → EXPIRED，否则 ACTIVE），
   *   与 updateTraffic cron 的判定一致。
   */
  private async rollbackRenewalLocal(
    order: any,
    inbound: any,
    prev: { expiry: Date | null; status: string | null },
  ) {
    const plan = order.plan;
    const rollbackDays =
      plan.duration > 0 && inbound.expiryTime ? plan.duration : 0;
    const rollbackBytes =
      plan.traffic > 0 && inbound.trafficLimit && Number(inbound.trafficLimit) > 0
        ? Number(plan.traffic)
        : 0;

    let expiry: Date | null = prev.expiry;
    if (!expiry && rollbackDays > 0 && inbound.expiryTime) {
      expiry = new Date(new Date(inbound.expiryTime).getTime() - rollbackDays * 24 * 3600 * 1000);
    }
    let trafficLimit = inbound.trafficLimit;
    if (rollbackBytes > 0) {
      trafficLimit = BigInt(Number(inbound.trafficLimit) - rollbackBytes);
    }

    // 状态恢复：无法还原为「原始状态」时，按面板当前用量重算（耗尽 → EXPIRED，否则 ACTIVE）
    let status: string | null = prev.status;
    if (!status) {
      try {
        const t = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
        const used = Number(t?.obj?.up || 0) + Number(t?.obj?.down || 0);
        const expired =
          expiry !== null && new Date(expiry).getTime() <= Date.now();
        const limitExceeded = Number(trafficLimit) > 0 && used >= Number(trafficLimit);
        status = expired || limitExceeded ? 'EXPIRED' : 'ACTIVE';
      } catch {
        status = 'ACTIVE';
      }
    }

    await this.prisma.$transaction([
      this.prisma.inbound.update({
        where: { id: inbound.id },
        data: { expiryTime: expiry, trafficLimit, status: status as any },
      }),
      this.prisma.order.update({ where: { id: order.id }, data: { renewalAppliedAt: null } }),
    ]);
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
    const lockToken = uuidv4();
    // 300s 锁 + token：单轮批量建节点可能远超 55s；token 保证 finally 只释放「自己的」锁，
    // 避免上一轮超时后误删下一轮实例刚拿到的锁 → 双跑重复建节点
    const gotLock = await this.redis.setNx(lockKey, lockToken, 300).catch(() => false);
    if (!gotLock) return; // 另一个实例/上一轮还在跑

    try {
      const cutoff = new Date(Date.now() - 60_000);
      const orders = await this.prisma.order.findMany({
        where: { status: { in: ['PAID', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
        include: { plan: true },
        take: 20,
      });

      for (const order of orders) {
        // 长轮次续期：防止本轮还没跑完锁就过期，下一个实例带着新锁进来双跑
        await this.redis.expire(lockKey, 300).catch(() => {});
        try {
          const result = await this.activateOrder(order.id);
          this.logger.log(`Auto-activated order ${order.orderNo} (${order.status} → ${result.order.status})`);
        } catch (e) {
          // 失败不动状态：activateOrder 认领时已把订单置为 PROCESSING，下一轮 cron 会继续重试
          this.logger.warn(`Auto-activate order ${order.orderNo} failed: ${e.message}`);
        }
      }
    } finally {
      // 只释放自己的锁：token 匹配才 del
      const cur = await this.redis.get(lockKey).catch(() => null);
      if (cur === lockToken) {
        await this.redis.del(lockKey).catch(() => {});
      }
    }
  }

  /**
   * 清理「已发起支付但一直未付款/未完成」的 PENDING 订单（每小时跑一次）：
   * - 网关二维码/支付链接有时间窗（微信约 2h、支付宝约 30m），窗口过后不会再扣款；
   *   48h 远超正常回调延迟，也给人工对账留了时间。
   * - BALANCE 单也要清理：余额支付失败（如余额不足）会留下 PENDING BALANCE 单，
   *   前端不会再自动重试，不清理会一直占着优惠券名额。
   * - 置 EXPIRED 并释放占用的优惠券名额 —— 否则每次「扫码不付就关页」都会白占
   *   一个券名额（usedCount + 每人限用次数），限量券可能被非付款用户耗尽。
   * - 说明：EXPIRED 为终态，若极端情况下日后真有延迟回调到达，
   *   handlePaymentSuccess 会按终态拒绝（防"取消后收款"的既有安全约束），需管理员核对。
   */
  @Cron('0 * * * *')
  async expireStaleGatewayOrders() {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stale = await this.prisma.order.findMany({
      where: {
        status: 'PENDING',
        payMethod: { in: ['WECHAT', 'ALIPAY', 'BALANCE'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, couponId: true },
      take: 200,
    });
    for (const order of stale) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'EXPIRED' },
      });
      if (order.couponId) await this.couponService.releaseCoupon(order.couponId);
    }
    if (stale.length) this.logger.log(`Expired ${stale.length} stale gateway PENDING orders`);
  }

  // ==========================================
  // Queries
  // ==========================================

  async getUserOrders(userId: number, page = 1, limit = 20) {
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        include: {
          plan: { select: { name: true, duration: true, traffic: true } },
          renewalOfInbound: {
            select: { id: true, remark: true, server: { select: { name: true, host: true } } },
          },
          coupon: { select: { code: true, name: true, type: true } },
          // 退款申请（含 adminNote：前端展示拒绝原因，让用户看到为什么被拒）
          refundRequests: {
            select: { id: true, status: true, adminNote: true, reason: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
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
          renewalOfInbound: {
            select: { id: true, remark: true, server: { select: { name: true, host: true } } },
          },
          coupon: { select: { code: true, name: true, type: true } },
          // 退款申请（含 adminNote：管理财务页展示退款状态与审批意见）
          refundRequests: {
            select: { id: true, status: true, adminNote: true, reason: true, amount: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
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
    // 已生成支付二维码/发起网关支付的单不能取消：网关通知延迟到达时，
    // 若订单已取消，钱收了节点却没开通（孤儿单）。等支付结果或超时后再处理。
    if (order.status === 'PENDING' && order.payMethod && ['WECHAT', 'ALIPAY'].includes(order.payMethod)) {
      throw new ConflictException('订单已发起支付（二维码已生成），暂不能取消，请等待支付结果或联系客服');
    }

    // CAS 原子取消：把「当前状态」作为更新条件而不是先读后写。
    // 并发双击取消 / 取消与取消同时到 → 只有一方 count=1 成功释放名额，
    // 杜绝同一条订单把优惠券名额释放两次（usedCount 被多扣）。
    const cancelled = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: { in: ['PENDING', 'FAILED'] },
        // 网关已发起支付的单不可取消（CAS 内复合复核，与并发发起支付形成互斥）
        OR: [
          { status: 'FAILED' },
          { payMethod: null },
          { payMethod: { notIn: ['WECHAT', 'ALIPAY'] } },
        ],
      },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 0) {
      const cur = await this.prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
      if (cur && cur.status === 'CANCELLED') {
        return this.prisma.order.findUnique({ where: { id: order.id } });
      }
      throw new ConflictException('订单状态已变更，无法取消，请刷新后重试');
    }
    // 优惠券名额释放：仅当本次真的把订单置为 CANCELLED 才退回
    if (order.couponId) await this.couponService.releaseCoupon(order.couponId);
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  /** 用户取消自己的未支付订单（仅 PENDING/FAILED，且必须属于当前用户）。 */
  async cancelSelf(id: number, userId: number) {
    const order = await this.prisma.order.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('Order not found');
    if (!['PENDING', 'FAILED'].includes(order.status)) {
      throw new ConflictException('该订单已支付或处理中，无法取消');
    }
    if (order.status === 'PENDING' && order.payMethod && ['WECHAT', 'ALIPAY'].includes(order.payMethod)) {
      throw new ConflictException('该订单已发起支付（二维码已生成），暂不能取消，请等待支付结果或联系客服');
    }
    // CAS 原子取消（与 cancel() 同理）：并发双击只会释放一次名额。
    // CAS 条件里带上 userId，即使并发下归属也保持成立。
    const cancelled = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        userId,
        status: { in: ['PENDING', 'FAILED'] },
        OR: [
          { status: 'FAILED' },
          { payMethod: null },
          { payMethod: { notIn: ['WECHAT', 'ALIPAY'] } },
        ],
      },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 0) {
      const cur = await this.prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
      if (cur && cur.status === 'CANCELLED') {
        return this.prisma.order.findUnique({ where: { id: order.id } });
      }
      throw new ConflictException('订单状态已变更，无法取消，请刷新后重试');
    }
    if (order.couponId) await this.couponService.releaseCoupon(order.couponId); // 退回已占名额（仅成功取消才退）
    return this.prisma.order.findUnique({ where: { id: order.id } });
  }

  async getStats() {
    const now = new Date();
    const startOfToday = new Date(now.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // 收入按实付口径：COALESCE(payAmount, amount)（amount 恒为原价，优惠券单只收 payAmount）。
    // Prisma aggregate 无法对两列做合并计算，用一条参数化原生 SQL 取合计数。
    const revenueSince = async (from: Date): Promise<number> => {
      const rows = await this.prisma.$queryRaw<{ revenue: number | string }[]>`
        SELECT COALESCE(SUM(COALESCE("payAmount", "amount")), 0) AS revenue
        FROM "Order"
        WHERE "status" = 'COMPLETED' AND "createdAt" >= ${from}`;
      return Number((rows[0] as any)?.revenue ?? 0);
    };

    const [todayRevenue, monthRevenue, totalRevenue, todayOrders, monthOrders, totalOrders, pendingCount] =
      await Promise.all([
        revenueSince(startOfToday),
        revenueSince(startOfMonth),
        revenueSince(new Date(0)),
        this.prisma.order.count({ where: { status: 'COMPLETED', createdAt: { gte: startOfToday } } }),
        this.prisma.order.count({ where: { status: 'COMPLETED', createdAt: { gte: startOfMonth } } }),
        this.prisma.order.count({ where: { status: 'COMPLETED' } }),
        this.prisma.order.count({ where: { status: 'PENDING' } }),
      ]);

    return {
      today: { revenue: todayRevenue, orders: todayOrders },
      month: { revenue: monthRevenue, orders: monthOrders },
      total: { revenue: totalRevenue, orders: totalOrders },
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
