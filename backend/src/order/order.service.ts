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
import { SystemService } from '../system/system.service';
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
    private systemService: SystemService,
  ) {}

  // 未支付/支付未成功订单的超时时间（分钟）——后台「订单超时关闭（分钟）」配置，默认 15
  private async getOrderExpireMs(): Promise<number> {
    const minutes = Number(await this.systemService.getSetting('orderExpireMinutes').catch(() => null)) || 15;
    return minutes * 60 * 1000;
  }

  // ==========================================
  // Create Order
  // ==========================================

  async createOrder(params: {
    userId: number;
    planId?: number;
    virtualProductId?: number; // 虚拟商品单：商城虚拟商品（与 planId 互斥）；交付=AUTO 自动发码 / MANUAL 人工发货
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
    renewType?: 'EXPIRY' | 'TRAFFIC'; // 续费类型：EXPIRY=到期续费（顺延/开新周期）；TRAFFIC=流量续费（额度叠加）；不传=旧版叠加行为
    couponCode?: string;      // 优惠券码（下单即占名额，取消时释放）
  }) {
    const { userId, planId, virtualProductId } = params;

    // ---- 虚拟商品单：无 plan，付款后走交付（AUTO 自动发码 / MANUAL 人工发货）----
    if (virtualProductId) {
      if (planId) throw new BadRequestException('网络方案与虚拟商品不能同时下单');
      const product = await this.prisma.virtualProduct.findUnique({
        where: { id: virtualProductId },
      });
      if (!product) throw new NotFoundException('虚拟商品不存在');
      if (product.status !== 'ACTIVE') throw new BadRequestException('该商品已下架');
      // AUTO 商品必须有未售交付码，避免「付了钱没货发」
      if (product.deliveryType === 'AUTO') {
        const available = await this.prisma.productKey.count({
          where: { productId: virtualProductId, status: 'UNUSED' },
        });
        if (available === 0) throw new BadRequestException('该商品库存不足或已售罄');
      }

      const orderNo = this.generateOrderNo();
      // 优惠券口径按商品实价校验/占用（applyCoupon 只读 plan.price）
      const couponOrderData = await this.claimCouponData(
        params.couponCode,
        userId,
        { price: Number(product.price) } as any,
      );
      const order = await this.createOrderRow({
        orderNo,
        userId,
        planId: null,
        virtualProductId,
        amount: product.price,
        ...couponOrderData,
        status: 'PENDING',
        payMethod: (params.payMethod ? String(params.payMethod).toUpperCase() : null) as any,
      });
      return order;
    }

    if (!planId) throw new BadRequestException('缺少商品参数（网络方案或虚拟商品）');
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('方案不存在');
    // 已售罄不影响老用户续费（续费不消耗库存，下方续费分支处理）；其余非在售状态一律拦截
    const isRenewal = !!params.renewalOfInboundId;
    if (plan.status !== 'ACTIVE' && !(plan.status === 'SOLD_OUT' && isRenewal)) {
      throw new BadRequestException('该方案不可用');
    }

    const orderNo = this.generateOrderNo();

    // 优惠券占用放在最后一刻（所有校验通过后、落库前再占名额）：
    // 不能用「先占名额再校验」——校验抛错时订单行不存在，没有任何取消路径能释放名额，
    // 限量券会被永远占死。占用与校验见 claimCouponData()。

    // ---- 续费模式：对已有节点续期/续流量（激活时 panel bulkAdjust/重置，不建新节点）----
    const renewalOfInboundId = params.renewalOfInboundId;
    if (renewalOfInboundId) {
      // 订阅周期制常量：到期后保留一天续费宽限期，越过宽限期节点被 cron 自动删除（只能重新购买套餐）
      const DAY_MS = 24 * 3600 * 1000;
      // 续费类型校验：只允许 EXPIRY（到期续费）或 TRAFFIC（流量续费=额度叠加）
      const renewType = params.renewType;
      if (renewType && renewType !== 'EXPIRY' && renewType !== 'TRAFFIC') {
        throw new BadRequestException('无效的续费类型');
      }
      // 目标节点必须属于当前用户且未软删除；管理员暂停（SUSPENDED）不允许续费（不复活管理停用节点）
      const inbound = await this.prisma.inbound.findFirst({
        where: { id: renewalOfInboundId, userId, status: { not: 'DELETED' } },
      });
      if (!inbound) throw new NotFoundException('目标节点不存在');
      if (inbound.status === 'SUSPENDED') {
        throw new BadRequestException('该节点已被管理员暂停，暂无法续费，请联系客服');
      }
      // 【订阅周期制·过期宽限期】时间到期后保留一天续费宽限期；越过宽限期的节点由 cron 自动删除，
      // 只能重新购买套餐。所有续费类型统一拦截（旧版叠加续费同此门：过期超一天补续没有可交付内容）。
      if (inbound.expiryTime && new Date(inbound.expiryTime).getTime() + DAY_MS < Date.now()) {
        throw new BadRequestException('该节点已过期超过一天，过期节点仅保留一天续费宽限期，之后将被自动删除；请重新购买方案');
      }

      // —— 按续费类型校验（订阅周期制）——
      const wantsExpiry = renewType === 'EXPIRY';
      const wantsTraffic = renewType === 'TRAFFIC';
      if (wantsExpiry) {
        // 到期续费：套餐必须含时长，节点必须限期（不限时节点无可顺延）
        if (!(plan.duration > 0)) {
          throw new BadRequestException('该方案不含时长，请选择「流量续费」续费');
        }
        if (!inbound.expiryTime) {
          throw new BadRequestException('该节点为不限时方案，无需续期');
        }
        // 套餐含流量但节点不限流量 → 套餐内的流量价值无法到账，直接拒绝（避免白付流量部分）
        if (Number(plan.traffic) > 0 && (!inbound.trafficLimit || Number(inbound.trafficLimit) <= 0)) {
          throw new BadRequestException('该节点为不限流量方案，无法兑换方案内的流量部分');
        }
        // 【订阅周期制·严格周期锚】已到期节点仅保留「一天续费宽限期」（上方已统一拦截超期）。
        // 宽限期内续费的周期锚在「原到期日」：新到期日 = 原到期日 + 套餐时长（不因续费时刻顺延）；
        // 周期切换点（原到期日）已过 → 激活时直接按周期切换语义恢复满额流量。
        const expMs = new Date(inbound.expiryTime).getTime();
        // 极端兜底：原到期日落后超过一个完整周期 → 顺延后仍在过去，无可交付，拒绝补续
        if (new Date(expMs + Number(plan.duration) * DAY_MS).getTime() <= Date.now()) {
          throw new BadRequestException('该节点已过期超过一个完整周期，无法通过续费恢复，请重新购买方案');
        }
      } else if (wantsTraffic) {
        // 流量续费：套餐必须含流量，节点必须限流量（不限流量节点无可叠加）
        if (!(Number(plan.traffic) > 0)) {
          throw new BadRequestException('该方案不含流量，请选择「到期续费」');
        }
        if (!inbound.trafficLimit || Number(inbound.trafficLimit) <= 0) {
          throw new BadRequestException('该节点为不限流量方案，无需充值流量');
        }
        // 已到期节点叠加流量没有意义（时间维度仍停用）→ 引导走到期续费
        if (inbound.expiryTime && new Date(inbound.expiryTime).getTime() <= Date.now()) {
          throw new BadRequestException('该节点已到期，请选择「到期续费」');
        }
      } else {
        // 旧版叠加续费（renewType 未传，兼容已上线的旧前端）：保留历史校验
        if (!(plan.duration > 0 || Number(plan.traffic) > 0)) {
          throw new BadRequestException('该方案无可续内容（需包含时长或流量）');
        }
        if (plan.duration > 0 && !inbound.expiryTime) {
          throw new BadRequestException('该节点为不限时方案，无需续期');
        }
        if (Number(plan.traffic) > 0 && (!inbound.trafficLimit || Number(inbound.trafficLimit) <= 0)) {
          throw new BadRequestException('该节点为不限流量方案，无需充值流量');
        }
      }
      if (params.relay) {
        throw new BadRequestException('续费无需开启 SOCKS 出站');
      }

      // 【#续费批处理 对抗复核】同节点同类型已存在未完成续费单（未支付/已付未激活/激活中）→
      // 拒绝再下单：用户重复付款后到期/流量会被激活两次（EXPIRY 开新周期虽不叠加，但会
      // 白付第二笔）；已 EXPIRED/CANCELLED 的单不拦（终态可重新下单）。
      const dup = await this.prisma.order.findFirst({
        where: {
          userId,
          renewalOfInboundId,
          renewType: (renewType as any) ?? null,
          status: { in: ['PENDING', 'PAID', 'PROCESSING'] },
        },
        select: { id: true },
      });
      if (dup) {
        throw new BadRequestException('该节点已有一笔未完成的续费订单，请先完成支付或取消后再试');
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
        renewType: renewType as any,
      }).catch((e: any) => {
        // 【#续费批处理 对抗复核】DB 级兜底：上面 findFirst 预检挡串行重复，但两个并发
        // 请求可同时通过预检 → 后到的 INSERT 命中部分唯一索引 Order_renewal_dup_key 抛
        // P2002 → 转成与预检一致的友好报错（不重复释放优惠券：createOrderRow 落库失败
        // 时已自行 releaseCoupon）。
        const target = e?.meta?.target;
        const isDup = Array.isArray(target)
          ? target.includes('Order_renewal_dup_key')
          : String(target ?? '').includes('Order_renewal_dup_key');
        if (e?.code === 'P2002' && isDup) {
          throw new BadRequestException('该节点已有一笔未完成的续费订单，请先完成支付或取消后再试');
        }
        throw e;
      });
      return order;
    }

    // 库存校验：限量方案售罄后不再接受新购（续费单已在续费分支处理，不消耗库存）
    if (plan.stock != null && plan.sold >= plan.stock) {
      throw new BadRequestException('该方案已售罄');
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
        // 归属或授权的 SOCKS 都可用作中转出口（后台「绑定给用户」授权）
        where: {
          id: params.relaySocksId,
          status: 'ACTIVE',
          OR: [{ userId }, { grants: { some: { userId } } }],
        },
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
      throw new BadRequestException('开启出站需要选择或填写 SOCKS 节点的地址和端口');
    }

    // 服务器选择：只允许套餐绑定的服务器；未传则取第一个绑定（激活时兜底自动选）
    let serverId: number | null = null;
    if (params.serverId) {
      const boundIds = (plan.serverIds || []) as number[];
      if (!boundIds.includes(params.serverId)) {
        throw new BadRequestException('所选服务器不在该方案的可用服务器列表中');
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
      throw new BadRequestException('该方案暂无可用服务器');
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
        include: { plan: true, virtualProduct: true },
      });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.status !== 'PENDING') throw new ConflictException('订单已处理');
      if (order.userId !== userId) throw new BadRequestException('不是你的订单');
      // 【对抗复核 F2/F13：跨渠道双重扣款】网关支付（WECHAT/ALIPAY）的二维码已生成、
      // 支付窗口开着时，这张单不能被余额再付一遍。若允许，用户扫码付了真钱、又点「余额支付」，
      // 余额 CAS 抢先把它标成 PAID/BALANCE 后，网关回调到达只会拿到 alreadyPaid——
      // 真钱既不入账也不退款，用户为同一个节点付了两次。与 cancel()/cancelSelf() 对
      // 「已发起网关支付的单不可取消」一致，这里同样把「已发起网关支付的 PENDING 单」
      // 当作禁止余额支付的互斥状态。
      if (order.payMethod && ['WECHAT', 'ALIPAY'].includes(order.payMethod)) {
        throw new ConflictException('该订单已发起扫码支付（二维码已生成），请勿重复支付，请等待支付结果或联系客服');
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('用户不存在');

      // 实付金额：优惠券后金额（payAmount）；amount 恒为原价
      const amount = Number(order.payAmount ?? order.amount);
      if (Number(user.balance) < amount) {
        throw new BadRequestException('余额不足');
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
        if (e && e.code === 'P2025') throw new BadRequestException('余额不足');
        throw e;
      }

      // Record transaction（交易后余额 = 条件扣款后的真实值）
      await tx.transaction.create({
        data: {
          userId,
          type: 'PURCHASE',
          amount: -amount,
          balance: updatedUser.balance,
          description: order.plan
            ? `Purchase plan: ${order.plan.name}`
            : `Purchase product: ${order.virtualProduct?.name ?? order.orderNo}`,
          relatedId: order.orderNo,
        },
      });

      // Mark order as paid —— CAS 认领：上方预检读到 PENDING 之后、这里写回之前，
      // 并发的第二笔余额支付可能已把订单标成 PAID。用 updateMany(status=PENDING→PAID)
      // 原子抢占：败者 count=0 → 抛错 → 整个事务回滚（已扣的余额、已写的流水一并还原），
      // 从根上杜绝同一订单被扣两次款（对抗复核 #759 确认的 TOCTOU：余额支付是全站
      // 唯一未走 CAS 的收款路径）。
      // CAS 条件额外带上「payMethod 不是 WECHAT/ALIPAY」：即便上方预检读到的快照在
      // 事务内已过期（另一会话刚发起网关支付并把 QR 生成、payMethod 写为 WECHAT/ALIPAY），
      // 这里也不会把一个已挂起扫码支付的单认领成 BALANCE —— 与预检一起把「跨渠道双重扣款」
      // （对抗复核 F2/F13）在原子层关死。
      const claimed = await tx.order.updateMany({
        where: {
          id: orderId,
          status: 'PENDING',
          OR: [{ payMethod: null }, { payMethod: { notIn: ['WECHAT', 'ALIPAY'] } }],
        },
        data: { status: 'PAID', paidAt: new Date(), payMethod: 'BALANCE' },
      });
      if (claimed.count === 0) throw new ConflictException('订单已处理');

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

  // ==========================================
  // 订单级进程内互斥（对抗复核 #759「settle 与激活并发双加」）
  // ==========================================

  /**
   * 支付线程与 autoActivate cron（同一 Nest 进程）会并发认领同一续费单：
   * cron 的认领门允许「updatedAt 超 60s 的 PROCESSING」单，而激活线程做完本地提交后
   * 会在面板调用（getClientTraffic/bulkAdjust）上空等数秒~数十秒，期间订单 updatedAt
   * 停留在 T0 → cron 认领成功并发执行 settle。无互斥时两者都读到「续前」面板快照、
   * 各自按差值补加 → 面板加量/加时长两次（违背「绝不重复加量」）。
   * 用 per-order promise 链互斥：后到者等先到者完成（订单已 COMPLETED → 认领 CAS
   * 失败 → 幂等返回），从根上掐断双写。进程崩溃时锁一并消失，只剩单写者走 settle 对账，
   * 完整路径依旧正确。
   */
  private readonly orderLocks = new Map<number, Promise<void>>();

  private withOrderLock<T>(orderId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.orderLocks.get(orderId) ?? Promise.resolve();
    // prev 失败也继续执行本次操作（互斥只保证顺序，不传递上一次的错误）
    const run: Promise<T> = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.orderLocks.set(orderId, tail);
    tail.then(() => {
      // 队列已空（无新的调用者接链）→ 清理，防 Map 无限增长
      if (this.orderLocks.get(orderId) === tail) this.orderLocks.delete(orderId);
    });
    return run;
  }

  async activateOrder(orderId: number, requestedUserId?: number) {
    return this.withOrderLock(orderId, () => this.activateOrderInner(orderId, requestedUserId));
  }

  // 支付成功后激活节点（核心流程）
  // 认领式激活：先 CAS 抢占为 PROCESSING 再干活，并发（余额支付 vs cron vs 管理端手动激活）
  // 只有一方能拿到；没拿到的一方走幂等分支，绝不重复建节点。
  private async activateOrderInner(orderId: number, requestedUserId?: number) {
    // 归属校验：用户主动激活只能操作自己的订单（cron / 余额支付 / 管理端等内部调用不传 userId，跳过）
    if (requestedUserId !== undefined) {
      const ownerCheck = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true },
      });
      if (!ownerCheck || ownerCheck.userId !== requestedUserId) {
        throw new NotFoundException('订单不存在');
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
      if (!later) throw new NotFoundException('订单不存在');
      if (later.status === 'COMPLETED') {
        // 虚拟商品单已完成（AUTO 已发码 / MANUAL 已完结整单）→ 幂等返回
        if (later.virtualProductId) return { order: later };
        const existing = await this.prisma.inbound.findFirst({
          where: { userId: later.userId, remark: { contains: `Order ${later.orderNo}` } },
        });
        if (existing) return { inbound: existing, order: later };
      }
      throw new ConflictException('订单无法开通');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true, virtualProduct: { select: { id: true, deliveryType: true } } },
    });
    if (!order) throw new NotFoundException('订单不存在');

    // 虚拟商品单：不建节点、不续费，走交付（AUTO=自动发码 / MANUAL=人工发货）
    if (order.virtualProductId) {
      return this.activateVirtualDelivery(order);
    }

    // 续费单：不建新节点，给已有节点续期/续流量（面板 bulkAdjust 加量并自动重启节点）
    if (order.renewalOfInboundId) {
      return this.activateRenewal(order);
    }

    // 走到这里必是网络方案单（虚拟单/续费单已 return）；plan 理论上非空，TS 窄化兜底
    if (!order.plan) {
      throw new ConflictException('订单缺少网络方案，无法开通节点');
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

    // 【限量库存·CAS 扣减】只有设置了库存的方案才扣。顺序敏感：入站已建好 → 扣库存 → 标完成；
    // 若中途崩溃，activateOrderInner 顶部的「查存量入站」早退分支会幂等返回，不会重复扣库存。
    if (order.plan.stock != null) {
      const claimed = await this.prisma.plan.updateMany({
        where: { id: order.plan.id, sold: { lt: order.plan.stock } },
        data: { sold: { increment: 1 } },
      });
      if (claimed.count === 0) {
        // 并发激活把最后一份抢走了 → 删掉刚建的节点、订单置 FAILED 引导退款（不假装开通）
        await this.inboundService.delete(inbound.id).catch(() => undefined);
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: 'FAILED' },
        });
        throw new BadRequestException('该方案已售罄，无法开通，请联系客服退款');
      }
      // 扣完即满 → 同步置 SOLD_OUT，商城展示售罄遮罩、新购被入口拦截（并发多条都命中，幂等）
      const latest = await this.prisma.plan.findUnique({
        where: { id: order.plan.id },
        select: { sold: true, stock: true },
      });
      if (latest && latest.stock != null && latest.sold >= latest.stock) {
        await this.prisma.plan.updateMany({ where: { id: order.plan.id }, data: { status: 'SOLD_OUT' } });
      }
    }

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
  // Virtual Delivery (虚拟商品交付)
  // ==========================================

  /**
   * 虚拟商品单交付（付款后激活，崩溃安全 + 幂等 + 并发安全）：
   * - AUTO：事务内用 FOR UPDATE SKIP LOCKED 行锁原子抢占一个 UNUSED 交付码；
   *   抢到 → 码置 SOLD 并挂 orderNo、订单 COMPLETED + deliveryInfo=码 + deliveredAt、
   *   商品 sold++，整个过程一个事务 → 「码已发」与「单已完结」绝不裂开（进程崩溃
   *   不会出现「码没了/单没完结」或「单完结了/码没发」的孤岛）。
   *   码全部耗尽（没抢到）→ 订单置 FAILED（提示售罄请退款），不假装发货。
   * - MANUAL：订单直接 COMPLETED（deliveryInfo 留空 = 等待管理员后台发货）。
   *   前置校验商品未 ARCHIVED（下架单不允许交付）。
   *
   * 兜底：认领把订单标成 PROCESSING，这里任意一步抛错订单停在 PROCESSING，
   * 由 autoActivatePending cron（每分钟，SETNX 锁）重试；COMPLETED 幂等返回由
   * activateOrderInner 顶部兜底。
   */
  private async activateVirtualDelivery(order: any) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id: order.virtualProductId },
      select: { id: true, name: true, deliveryType: true, status: true },
    });
    if (!product || product.status === 'ARCHIVED') {
      // 商品被删/归档：不能交付，订单置 FAILED 引导退款
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('该商品已下架，无法交付，请联系客服退款');
    }

    // MANUAL：完结整单，等待管理员后台发货
    if (product.deliveryType === 'MANUAL') {
      const done = await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
      });
      this.logger.log(`Virtual order ${order.orderNo} (MANUAL) completed, waiting admin delivery`);
      return { order: done };
    }

    // AUTO：事务内行锁抢占交付码 —— 并发（余额支付 vs cron 重试）下只有一方抢到
    // 同一个码；SKIP LOCKED 让双方各拿各的码，绝不重复发码，也不互相阻塞。
    const txn = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: number; code: string }>>`
        SELECT "id", "code" FROM "ProductKey"
        WHERE "productId" = ${product.id} AND "status" = 'UNUSED'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return { outOfStock: true } as const;

      const key = rows[0];
      await tx.productKey.update({
        where: { id: key.id },
        data: { status: 'SOLD', orderNo: order.orderNo },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'COMPLETED',
          paidAt: order.paidAt || new Date(),
          deliveryInfo: key.code,
          deliveredAt: new Date(),
        },
      });
      await tx.virtualProduct.update({
        where: { id: product.id },
        data: { sold: { increment: 1 } },
      });
      return { code: key.code };
    });

    if (txn.outOfStock) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('该商品库存不足或已售罄，订单已标记失败，请联系客服退款');
    }

    this.logger.log(`Virtual order ${order.orderNo} (AUTO) delivered`);
    return { order: await this.prisma.order.findUnique({ where: { id: order.id } }), delivered: true };
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
   * 崩溃安全：本地先增量（+renewalAppliedAt 标记，订单留 PROCESSING）→ 面板调用。
   * 面板失败 ≠ 未生效（3xui 先落库后返回）→ 绝不回滚；cron 兜底重试时若
   * renewalAppliedAt 已设 → settleRenewalIfApplied 按「面板当前值 vs 本地目标」差量
   * 补齐后完结（diff 幂等，绝不对同一订单重复整量调面板，防止加量加倍）。
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

    // 订阅周期制续费（EXPIRY/TRAFFIC，用户确认的「周期制」语义，实现见 activateRenewalNewCycle）：
    // - EXPIRY：到期日顺延。未到期=当前周期流量不变、到周期切换点（原到期日）cron 自动清零并
    //   回归套餐满额；已到期（宽限期内）=新周期锚在原到期日、切换点已过 → 激活即按周期切换恢复满额。
    // - TRAFFIC：在当前额度上叠加套餐流量（不清已用、叠加量随周期切换清零）。
    // 过期超过一天的到期节点已被 cron 自动删除，只能重新购买套餐（见 inbound.updateTraffic）。
    if (order.renewType === 'EXPIRY' || order.renewType === 'TRAFFIC') {
      return this.activateRenewalNewCycle(order, inbound);
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
      throw new BadRequestException('该方案无可加量内容，续费失败');
    }

    // 捕获续费前的到期时间（回滚/公式基准用；面板失败不再走主动回滚，改为 settle 对账）
    const oldExpiry = inbound.expiryTime;

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
          // 会让整轮新周期静默（档位门控 stage <= 已发出的最高档 直接跳过）。
          // 仅当到期时间实际变化才重置（纯流量续费不动提醒档位）
          ...(addDays > 0 ? { expiryReminderStage: 0 } : {}),
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
      // 【major#512 对抗复核确认】面板返回失败 ≠ 未生效：3xui 的 updateSetting 是
      // 「保存模板 → CheckXrayConfig 校验 → RestartXray 应用」一路下来的，success=false
      // 时模板可能已持久化（校验/应用步骤才失败）。绝不能主动回滚 —— 回滚会清掉
      // renewalAppliedAt，下一轮 cron 整量重跑对面板再 +addDays/+addBytes → 重复加量。
      // 保留本地增量与 renewalAppliedAt，交 settle 按面板实际状态对账：
      //   已生效 → 直接完结；未生效 → settle 自己回滚让 cron 干净重来。
      this.logger.error(
        `Renewal bulkAdjust failed for order ${order.orderNo}: ${panelRes?.msg || 'unknown'} — reconciling against panel`,
      );
      const fresh = await this.prisma.inbound.findUnique({ where: { id: inbound.id } });
      if (!fresh) {
        await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
        throw new BadRequestException('目标节点不存在或已被删除，续费失败');
      }
      return this.settleRenewalIfApplied(order, fresh);
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
   * 订阅周期制续费激活（renewType=EXPIRY/TRAFFIC，用户确认的「周期制」语义）：
   * - EXPIRY（到期续费）：
   *     · 节点未到期：到期日顺延 plan.duration 天，流量/额度/周期切换点一概不动 —— 当前
   *      周期内流量不变；到「周期切换点」（原到期日）由 updateTraffic cron 自动清零已用、
   *      额度回归周期基础（periodQuota）、保持启用。提前续费不提前重置。
   *     · 节点已到期（宽限期内）：新周期锚在「原到期日」→ 到期日 = 原到期日 + duration。
   *      周期切换点（原到期日）已过 → 激活即按周期切换语义恢复流量（已用清零、额度 = 周期
   *      基础 periodQuota）、节点复活，切换点推进为新的到期日。过期超过一天的节点已被 cron
   *      自动删除，只能重新购买套餐。
   * - TRAFFIC（流量续费）：到期时间不动；在当前流量额度上【叠加】plan.traffic（不清已用），
   *   叠加量随本周期结束（周期切换）清零、不跨周期。
   *
   * 面板侧：
   * 1) bulkAdjust(addDays, addBytes)：顺延到期日 + 配额叠加/补足。面板 quota（total）只能增
   *    不能减，且本地 trafficLimit 才是额度权威，因此：
   *     - EXPIRY：只加天数（已到期开新周期按「面板当前到期 → 原到期日+duration」差值补天数）；
   *     - TRAFFIC：只加字节（addBytes = plan.traffic，面板天然叠加）
   *    注意 addDays/addBytes 都为 0 时 bulkAdjust 会报「no adjustment specified」→ 跳过不调。
   * 2) 仅已到期开新周期：bulkResetTraffic 清零已用 + enable=true 复活。
   *
   * 崩溃安全与旧版一致：本地先提交（+renewalAppliedAt & renewalResetTraffic）→ 面板调用 →
   * 失败交 settle 按「面板当前值 vs 本地目标」差值对账（diff 幂等），绝不回滚本地、
   * 绝不对同一订单重复整量加量。
   */
  private async activateRenewalNewCycle(order: any, inbound: any) {
    const plan = order.plan;
    const renewType: 'EXPIRY' | 'TRAFFIC' = order.renewType;
    // 周期基础额度（本地权威）：已到期开新周期 / 周期切换回退到它；0 = 不限流量（无周期概念）
    const periodQuota = Number(inbound.periodQuota || 0);
    const wantsExpiry = renewType === 'EXPIRY' && Number(plan.duration) > 0 && inbound.expiryTime;
    // TRAFFIC 必须套餐含流量且节点限流量（createOrder 已拦，这里防御）
    const wantsTraffic = renewType === 'TRAFFIC' && Number(plan.traffic) > 0 && periodQuota > 0;
    if (!wantsExpiry && !wantsTraffic) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('该方案无可加量内容，续费失败');
    }
    // 【对抗复核确认】TRAFFIC 激活时刻到期复核：下单后支付窗口内可能已到期。到期后叠加流量
    // 毫无意义 —— 下一分钟 cron 会按本地到期日打回 EXPIRED（用户白付）。与旧版同标准。
    if (
      wantsTraffic &&
      !wantsExpiry &&
      inbound.expiryTime &&
      new Date(inbound.expiryTime).getTime() <= Date.now()
    ) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('该节点已到期，流量续费无法恢复到期状态，请选择「到期续费」顺延节点');
    }

    const DAY_MS = 24 * 3600 * 1000;
    const now = Date.now();

    // —— 本地目标（权威）——
    let newExpiry: Date | null = inbound.expiryTime; // 未到期=原到期日顺延；已到期=原到期日+duration（严格周期锚）
    let newLimit: bigint | null = null;              // 需要变才写；null=额度不变
    let periodQuotaUpdate: bigint | null = null;     // 下一周期基础额度（套餐含流量时更新）
    let resetLocalUsed = false;                      // 本地已用清零（仅已到期：切换点已过→按周期切换恢复）
    let needsPanelReset = false;                     // 需面板清零已用 + 复活（同左）
    let addDays = 0;
    let addBytes = 0;

    if (wantsExpiry) {
      const oldExpiryMs = new Date(inbound.expiryTime).getTime();
      const expiredNow = oldExpiryMs <= now;
      if (expiredNow) {
        // 【已到期·宽限期内】严格周期锚：新周期从「原到期日」起算（到期日不顺延续费时刻到了续费
        // 当天），新到期日 = 原到期日 + duration。周期切换点（原到期日）已过 → 本轮激活即按周期
        // 切换语义恢复——清零已用、额度 = 周期基础、面板复活。不是「续费生效即开新周期」。
        // （过期超过一天的节点已被 cron 自动删除，只有宽限期内的已到期节点能走到这里）
        newExpiry = new Date(oldExpiryMs + Number(plan.duration) * DAY_MS);
        resetLocalUsed = true;
        needsPanelReset = true; // 面板清零已用 + enable=true 复活
        if (periodQuota > 0) newLimit = BigInt(periodQuota);
      } else {
        // 未到期 → 原到期日顺延；当前周期流量不变（到切换点由 cron 自动重置）
        newExpiry = new Date(oldExpiryMs + Number(plan.duration) * DAY_MS);
      }
      // 套餐含流量 → 更新下一周期基础额度为套餐额度（未到期续费也更新：新周期按新套餐回满）
      if (Number(plan.traffic) > 0 && periodQuota > 0) {
        periodQuotaUpdate = BigInt(plan.traffic);
        // 已到期开新周期时 newLimit 直接用新套餐额度（上一 if 已在已到期分支写入 periodQuota）
        if (expiredNow) newLimit = BigInt(plan.traffic);
      }
      // addDays：未到期 = duration；已到期 = 面板当前到期 → 新到期日（原到期日+duration）的差值，
      // 修正面板侧漂移。读面板失败保守按 duration（settle 会对账修正）。
      if (expiredNow) {
        try {
          const t = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
          const panelExpiryMs = Number(t?.obj?.expiryTime || 0);
          if (panelExpiryMs > 0) {
            const diffMs = newExpiry.getTime() - panelExpiryMs;
            addDays = Math.max(0, Math.ceil(diffMs / DAY_MS));
          } else addDays = Number(plan.duration);
          // 面板配额补足到周期基础：面板 total < periodQuota 时面板会过早切断（本地是权威，
          // 但面板只在 total 用完后才停用，补足避免面板早于本地 cron 切断）
          if (periodQuota > 0) {
            const panelTotal = Number(t?.obj?.total || 0);
            if (panelTotal < periodQuota) addBytes = periodQuota - panelTotal;
          }
        } catch {
          addDays = Number(plan.duration);
          if (periodQuota > 0) addBytes = periodQuota;
        }
      } else {
        addDays = Number(plan.duration);
      }
    } else {
      // TRAFFIC：额度叠加 plan.traffic（不清已用；叠加量随周期切换清零）
      newLimit = BigInt(Number(inbound.trafficLimit || 0) + Number(plan.traffic));
      addBytes = Number(plan.traffic);
    }

    // 1) 本地先提交（崩溃安全：提交后即使面板调用前进程死掉，cron 也能靠 renewalAppliedAt 对账）
    await this.prisma.$transaction([
      this.prisma.inbound.update({
        where: { id: inbound.id },
        data: {
          ...(wantsExpiry && newExpiry ? { expiryTime: newExpiry } : {}),
          ...(newLimit !== null ? { trafficLimit: newLimit } : {}),
          ...(periodQuotaUpdate !== null ? { periodQuota: periodQuotaUpdate } : {}),
          // 仅已到期开新周期清零已用；未到期续费 / TRAFFIC 叠加都不动已用
          ...(resetLocalUsed ? { totalTraffic: BigInt(0) } : {}),
          // 已到期开新周期：周期切换点 = 新到期日（下个周期到点再自动重置）
          ...(needsPanelReset && newExpiry ? { trafficResetAt: newExpiry } : {}),
          status: 'ACTIVE', // EXPIRED→ACTIVE（复活）；ACTIVE 保持不变
          // 【minor#578】到期提醒档位仅当到期时间实际变化才重置（纯流量续费不动提醒节奏）
          ...(wantsExpiry ? { expiryReminderStage: 0 } : {}),
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: {
          renewalAppliedAt: new Date(),
          // settle 对账区分「已到期开新周期需清零+复活」/「未到期只顺延」/「TRAFFIC 叠加」
          renewalResetTraffic: needsPanelReset,
        },
      }),
    ]);

    // 2) 面板加量（到期顺延 + 配额叠加/补足；两者都无操作时跳过 —— bulkAdjust 对 0/0 会报错）
    if (addDays > 0 || addBytes > 0) {
      const panelRes = await this.serverService.adjustClientQuota(
        inbound.serverId,
        inbound.email,
        addDays,
        addBytes,
      );
      if (!panelRes?.success) {
        // 【major#512】面板失败 ≠ 未生效（3xui 先落库后校验/应用）；不主动回滚，交 settle
        // 以面板实际状态对账：已生效→完结，未生效→settle 回滚让 cron 干净重来。
        // 绝不对同一订单重复整量加量。
        this.logger.error(
          `Renewal bulkAdjust failed for order ${order.orderNo}: ${panelRes?.msg || 'unknown'} — reconciling against panel`,
        );
        const fresh = await this.prisma.inbound.findUnique({ where: { id: inbound.id } });
        if (!fresh) {
          await this.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
          throw new BadRequestException('目标节点不存在或已被删除，续费失败');
        }
        return this.settleRenewalIfApplied(order, fresh);
      }
    }

    // 3) 仅已到期开新周期：清零已用流量并重新启用（面板自动复活耗尽客户端）
    if (needsPanelReset) {
      const resetRes = await this.serverService.resetClientTraffic(inbound.serverId, inbound.email);
      if (!resetRes?.success) {
        // 清零失败：本地已提交、面板配额（如需）已加 —— 不要回滚（避免重复加量）。
        // 订单保持 PROCESSING，cron 对账将按已生效完结（up/down 由本地 cron 以面板为准同步）
        this.logger.error(
          `Renewal traffic reset failed for order ${order.orderNo}: ${resetRes?.msg || 'unknown'}`,
        );
        throw new BadRequestException('流量清零失败，系统将自动重试');
      }
    }

    // 4) 成功 → 完结订单
    const done = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
    });
    const freshInbound = await this.prisma.inbound.findUnique({ where: { id: inbound.id } });
    this.logger.log(
      `Renewal applied order ${order.orderNo}: type=${renewType} +${addDays}d / quota→${
        newLimit !== null ? Number(newLimit) : '不变'
      } / ${resetLocalUsed ? 'used→0（开新周期）' : 'used 不变'} / periodQuota→${
        periodQuotaUpdate !== null ? Number(periodQuotaUpdate) : '不变'
      } on ${inbound.email}`,
    );
    return { inbound: freshInbound, order: done };
  }

  /**
   * 崩溃对账：renewalAppliedAt 已设但订单未 COMPLETED（上次在面板调用前后进程崩溃）。
   * 读面板核对是否已生效 → 已生效：直接完结；未生效：按差值补齐缺失的维度和清零，
   * 补完复核，仍不达标则保持 PROCESSING + renewalAppliedAt 等下一轮 cron ——
   * 绝不回滚本地（回滚会让 cron 整量重跑，面板若已部分持久化就重复加量）。
   * 新周期续费（renewType=EXPIRY/TRAFFIC）按维度分别核对；旧版叠加单沿用历史 OR 逻辑。
   */
  private async settleRenewalIfApplied(order: any, inbound: any) {
    const traffic = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
    let obj = traffic?.obj || {}; // 对账中可能重读面板刷新（repair 后），用 let
    const plan = order.plan;

    // ---- 订阅周期制续费（renewType=EXPIRY/TRAFFIC）：维度核对 + 对缺失的幂等面板操作自愈 ----
    // 对账语义必须与 activateRenewalNewCycle 完全同构，否则同一订单两个路径的判定会打架。
    // 覆盖三类：
    //  · EXPIRY 未到期（renewalResetTraffic=false）：只核对到期维度 —— 面板到期 ≥ 本地顺延后
    //    到期。流量维度由周期切换 cron 负责（提前续费不提前重置），settle 绝不碰流量/配额。
    //  · EXPIRY 已到期开新周期（renewalResetTraffic=true）：到期需追到本地新到期（原到期日+duration）、
    //    配额应 ≥ 本地周期基础额度（防面板早切）、已用必须清零 + enable=true（复活）。
    //  · TRAFFIC 叠加：配额应 ≥ 本地额度-容差（面板天然累加，叠加后必满足）；【绝不 reset】——
    //    叠加不清已用，若在此清零会把用户本周期已用流量抄没（与 activate 同构）。
    if (order.renewType === 'EXPIRY' || order.renewType === 'TRAFFIC') {
      const DAY_MS = 24 * 3600 * 1000;
      const slack = 10 * 1024 * 1024; // 10MB 容差吸收对账瞬间的并发用量
      const usedOf = () => Number(obj.up || 0) + Number(obj.down || 0);
      const isTraffic = order.renewType === 'TRAFFIC';
      const wantsExpiry =
        order.renewType === 'EXPIRY' && Number(plan.duration) > 0 && inbound.expiryTime;
      // 已到期开新周期：激活时为 EXPIRED 节点重生 —— 需面板清零已用+复活+额度回归周期基础
      const resetCycle = wantsExpiry && order.renewalResetTraffic === true;
      // 到期维度：面板到期时间（ms，驼峰键，见 xray/client_traffic.go）应 ≥ 本地续后到期。
      // 【同 legacy #F4 守卫】面板该维度为无限（0）时 3xui 的 BulkAdjust 直接跳过且返 success，
      // 面板永不按到期停用 → 该维度视为已满足（本地 cron 仍是到期/流量停用的唯一权威）。
      const expOk = () =>
        !wantsExpiry ||
        Number(obj.expiryTime || 0) === 0 ||
        Number(obj.expiryTime || 0) >= new Date(inbound.expiryTime).getTime();
      // 流量维度：TRAFFIC 叠加 / 开新周期都要求面板配额 ≥ 本地额度-容差。本地额度是权威。
      // 【对抗复核 #726 确认】绝不能 + usedOf()：开新周期崩溃于「adjust 落地前」时重置尚未
      // 执行、面板配额仍是旧额度；把旧周期 up+down 计入达标会填平缺口使 trfOk 恒真 → 只走
      // 幂等 reset 就 COMPLETED，配额差量被永久跳过（用户付钱却在旧额度处被面板切断）。
      // 【同 legacy #F4 守卫】面板配额无限（total=0）同理视为已满足。
      // 已生效判定必须与 #763 修复公式同构：仅以面板配额 obj.total 对比本地权威额度。
      const trfOk = () => {
        if (!isTraffic && !resetCycle) return true;
        const pt = Number(obj.total || 0);
        if (pt === 0) return true;
        return pt >= Number(inbound.trafficLimit) - slack;
      };
      // 重置维度（仅开新周期）：已用清零 + enable=true；expOk/trfOk 达标但 reset 缺失 =
      // 崩溃恰在 adjust 之后、reset 之前 → 需补一次幂等 reset 才能交付「已到期复活」的承诺
      const resetOk = () => !resetCycle || (usedOf() <= slack && obj.enable !== false);
      // 流量续费叠加：面板配额可能未加到本地额度 → 差量修复（加法幂等）。注意本地额度已在
      // 激活时 +plan.traffic；面板 quota 由 addBytes=plan.traffic 同步累加，差量天然收敛。
      const trfNeed = () => (isTraffic || resetCycle ? Number(inbound.trafficLimit) - slack : null);

      if (expOk() && trfOk() && resetOk()) {
        // 已生效即完结（开新周期的 quota 够、到期够，但 reset 未落地 → 先补一次幂等 reset）：
        //   - enable=false（流量耗尽/过期被面板停用，崩溃恰在 reset 之前）：清零已用 + 复活
        //   - usedOf() > slack（崩溃在 adjust 之后、reset 之前，客户端仍为启用态）：
        //     up/down 还挂着旧用量，说明 reset 未执行 → 补一次清零
        // 注意 reset 幂等且崩溃窗口内用量极小，重复执行最多损失 <1 分钟的并发流量
        if (resetCycle && !resetOk()) {
          const r = await this.serverService.resetClientTraffic(inbound.serverId, inbound.email);
          if (!r?.success) {
            this.logger.warn(
              `Renewal order ${order.orderNo} cycle reset repair failed: ${r?.msg} (will retry next minute)`,
            );
            throw new BadRequestException('节点尚未恢复，系统将自动重试');
          }
          const t2 = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
          obj = t2?.obj || {};
          if (!resetOk()) {
            this.logger.warn(
              `Renewal order ${order.orderNo}: cycle reset repair not reflected on panel, keeping PROCESSING`,
            );
            throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
          }
        }
        const done = await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
        });
        this.logger.log(`Renewal order ${order.orderNo} verified applied on panel, completed`);
        return { inbound, order: done };
      }

      // 尚未生效（崩溃发生在 bulkAdjust/reset 之前）→ 补齐缺失的幂等操作后再复核：
      // - 补天数：差值 = 本地续后到期 - 面板当前到期（崩溃前面板必为续前状态；按差值计算
      //   天然幂等，重复对账不会重复加量。面板到期维度为无限(0)时跳过：adjust 会被面板
      //   静默跳过，补差永不收敛 —— 但面板永不按到期停用，权益已被满足，见同 legacy #F4）
      // - 补配额：仅 TRAFFIC / 开新周期时要求；need = limit − slack（不加已用 —— reset 紧随
      //   其后清空已用，见 #763；TRAFFIC 无 reset，但面板 total 是「累计上限」而非「剩余」，
      //   叠加语义下已用必然 ≤ 面板累计上限，不参与 target。面板配额为无限(0)时同理跳过）
      // - 开新周期：adjust 后补一次 reset（清零已用 + 复活）
      let repairDays = 0;
      if (wantsExpiry) {
        const panelExpiry = Number(obj.expiryTime || 0);
        if (panelExpiry === 0) {
          this.logger.warn(
            `Renewal order ${order.orderNo}: panel client expiry is unlimited (0); treating expiry dimension as satisfied (panel never cuts off on expiry)`,
          );
        } else {
          const diff = new Date(inbound.expiryTime).getTime() - panelExpiry;
          if (diff > 0) repairDays = Math.ceil(diff / DAY_MS);
        }
      }
      let repairBytes = 0;
      const need = trfNeed();
      if (need !== null) {
        const panelTotal = Number(obj.total || 0);
        if (panelTotal === 0) {
          this.logger.warn(
            `Renewal order ${order.orderNo}: panel client traffic is unlimited (0); treating traffic dimension as satisfied (panel never cuts off on quota)`,
          );
        } else {
          const delta = need - panelTotal;
          if (delta > 0) repairBytes = Math.ceil(delta);
        }
      }
      // 【对抗复核确认：修复失败绝不回滚本地】
      // 旧实现这里调用 rollbackRenewalLocal（恢复到期/额度 + 清 renewalAppliedAt），
      // 下一分钟 autoActivate cron 把订单当「全新续费」从头整量重跑 bulkAdjust ——
      // 若方才失败的 adjust 实际已持久化（3xui 先落库、后校验/返回，返回失败 ≠ 未生效），
      // 面板就在「已加过一次」的基础上又被加一次全额 → 到期 = 原 + 2×时长，
      // 恰好是 settle 机制声称要杜绝的「重复加量」（对账复核双视角确认）。
      // 正确姿势：本地已提交 + renewalAppliedAt 已设 → 保持订单 PROCESSING，让 cron
      // 下一轮继续按「面板当前值 与 本地目标 的差值」补齐（diff 幂等：补过的不会再补、
      // 没补的补上），无论面板处于「未加 / 加了一部分 / 加满」哪种状态都能收敛，
      // 绝不会重复整量。
      if (repairDays > 0 || repairBytes > 0) {
        const res = await this.serverService.adjustClientQuota(
          inbound.serverId,
          inbound.email,
          repairDays,
          repairBytes,
        );
        if (!res?.success) {
          this.logger.warn(
            `Renewal order ${order.orderNo} repair adjust failed: ${res?.msg}, keeping PROCESSING for diff retry`,
          );
          throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
        }
        const t3 = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
        obj = t3?.obj || {};
      }
      if (resetCycle) {
        // reset 幂等：清零已用 + enable=true（开新周期复活）；配额已足时可能无 bulkAdjust，
        // 这里是「已到期复活」承诺的唯一恢复路径
        const r = await this.serverService.resetClientTraffic(inbound.serverId, inbound.email);
        if (!r?.success) {
          this.logger.warn(
            `Renewal order ${order.orderNo} repair reset failed: ${r?.msg}, keeping PROCESSING for diff retry`,
          );
          throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
        }
        const t4 = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
        obj = t4?.obj || {};
      }

      if (expOk() && trfOk() && resetOk()) {
        const done = await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
        });
        this.logger.log(`Renewal order ${order.orderNo} repaired on panel and completed`);
        return { inbound, order: done };
      }

      // 修复后仍不达标（面板持续异常）：本地已提交、renewalAppliedAt 已设 —— 同样
      // 不回滚（理由同上：回滚会让 cron 整量重跑，面板若已部分持久化就重复加量）。
      // 保持 PROCESSING，下一轮 cron 按差值继续补，面板恢复后自然收敛。
      this.logger.warn(
        `Renewal order ${order.orderNo} not applied on panel, keeping PROCESSING for diff retry`,
      );
      throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
    }

    // ---- 旧版叠加续费（renewType=null）：保留历史核对逻辑 ----
    const extendedExpiry = plan.duration > 0 && inbound.expiryTime;
    const addedBytes = plan.traffic > 0 && inbound.trafficLimit && Number(inbound.trafficLimit) > 0;
    // 新周期块的 DAY_MS/slack 不在本作用域（在 if 块内声明），legacy 尾部的差量修复自备常量
    const DAY_MS_LEGACY = 24 * 3600 * 1000;
    const slackLegacy = 10 * 1024 * 1024;

    let applied = false;
    if (extendedExpiry) {
      // 续期：面板到期时间（ms）应 ≥ 本地续后到期（本地已增量，二者同源同公式）。
      // 面板流量记录的 JSON 键是驼峰 expiryTime（internal/xray/client_traffic.go:14），
      // 不是 expiry_time —— 读错键会恒为 0，导致纯时长续费被误判「未生效」而无限回滚重试。
      const localExpiryMs = new Date(inbound.expiryTime).getTime();
      applied = Number(obj.expiryTime || 0) >= localExpiryMs;
    }
    if (!applied && addedBytes) {
      // 【对抗复核 F3：判定不能把「累计已用 used」算进去】下面（936-943）判定面板是否已应用
      // 续费流量：期望目标是「面板累计上限 total ≥ 本地续后额度」，因为面板在累计用量 ≥ total
      // 时停用用户（client_paging.go depleted），用户实际可用 = total。若把 used（up+down）
      // 加进判定（total + used ≥ limit），一张只补到 total = limit - used 的面板会被误判为
      // 「已生效」而成交——实际少了 used 字节的可用于量就永久写销（订单 COMPLETED 后不再重试）。
      // 与新版路径 #726（trfOk 刻意排除 usedOf）保持一致：用 total 单独达标判定。
      // 仅续流量（或续期未生效说明整体未应用）：面板累计上限应 ≥ 本地续后额度 - 容差
      // 容差 10MB 吸收对账瞬间的并发用量（否则已生效会被误判为未生效 → 重复加量）。
      const localLimit = Number(inbound.trafficLimit);
      const slack = 10 * 1024 * 1024;
      applied = Number(obj.total || 0) >= localLimit - slack;
    }

    if (applied) {
      const done = await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
      });
      this.logger.log(`Renewal order ${order.orderNo} verified applied on panel, completed`);
      return { inbound, order: done };
    }

    // 面板没有这次加量 → 按差量补齐（与新版 settle 同策略）：逐分钟用「面板当前值」补
    // 「本地目标」的缺口。diff 幂等 —— 上面的 adjust 若已部分持久化（3xui 先落库后返回，
    // 返回失败 ≠ 未生效），这里只补缺失部分，绝不按整额重加（否则面板到期 = 原 + 2×时长）。
    // 决不回滚本地快照（回滚会清掉 renewalAppliedAt → cron 整量重跑 → 同样的重复加量）。
    //
    // 【对抗复核 F4：面板把该维度当「无限」时会恒跳过 adjust → 永不收敛的等额空转】
    // 本 3xui fork 的 BulkAdjust 对 rec.ExpiryTime==0（无限效期）或 rec.TotalGB==0（无限流量）
    // 的客户端直接跳过且仍返回 success（client_bulk.go:322-369）。若面板行该维度已是无限
    // （0），本地却期望有限值，补差会每秒都算出 repair>0、每秒 adjust 都被面板跳过、t4 重读
    // 依旧 0 → after 永假 → 订单卡 PROCESSING 永恒的等额空转。但「面板无限」意味着面板永远
    // 不会按该维度掐掉用户（不限效期/不限流量都不触发 cutoff），续费的权益实际已被满足。
    // 因此在补差前先识别：面板目标维度已是无限（0）而本地期望有限 → 该维度视为已满足，
    // 不再补差（也避免空转）；仅当面板该维度是有限但不足时才补。
    let repairDays = 0;
    if (extendedExpiry) {
      const localExpiryMs = new Date(inbound.expiryTime).getTime();
      const panelExpiry = Number(obj.expiryTime || 0);
      if (panelExpiry === 0) {
        this.logger.warn(
          `Renewal order ${order.orderNo}: panel client expiry is unlimited (0); treating expiry dimension as satisfied (panel never cuts off on expiry)`,
        );
      } else if (localExpiryMs > panelExpiry) {
        repairDays = Math.ceil((localExpiryMs - panelExpiry) / DAY_MS_LEGACY);
      }
    }
    let repairBytes = 0;
    if (addedBytes) {
      // 目标：面板累计上限补到本地续后额度（used 不计入，见 F3 注释——补到 total = limit 才是
      // 用户真正可用 = 额度；多加 used 会把面板顶到 limit - used，可用量少一块且成交后再不重试）。
      const need = Number(inbound.trafficLimit) - slackLegacy;
      const panelTotal = Number(obj.total || 0);
      if (panelTotal === 0) {
        this.logger.warn(
          `Renewal order ${order.orderNo}: panel client traffic is unlimited (0); treating traffic dimension as satisfied (panel never cuts off on quota)`,
        );
      } else if (need > panelTotal) {
        repairBytes = Math.ceil(need - panelTotal);
      }
    }
    if (repairDays > 0 || repairBytes > 0) {
      const res = await this.serverService.adjustClientQuota(
        inbound.serverId,
        inbound.email,
        repairDays,
        repairBytes,
      );
      if (!res?.success) {
        this.logger.warn(
          `Renewal order ${order.orderNo} repair adjust failed: ${res?.msg}, keeping PROCESSING for diff retry`,
        );
        throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
      }
      const t4 = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
      obj = t4?.obj || {};
    }
    // 复核（obj 已刷新）：与上面的 applied 判定同公式；并对「面板该维度无限」等价为已满足
    // （面板无限效期/无限流量时永不触发 cutoff，用户权益实际已达成 —— 见 F4 注释）。
    let after =
      extendedExpiry &&
      (Number(obj.expiryTime || 0) === 0 ||
        Number(obj.expiryTime || 0) >= new Date(inbound.expiryTime).getTime());
    if (!after && addedBytes) {
      after =
        Number(obj.total || 0) === 0 ||
        Number(obj.total || 0) >= Number(inbound.trafficLimit) - slackLegacy;
    }
    if (after) {
      const done = await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
      });
      this.logger.log(`Renewal order ${order.orderNo} repaired on panel and completed`);
      return { inbound, order: done };
    }
    // 仍不达标：保持 PROCESSING + renewalAppliedAt，下一轮 cron 按差值继续补
    this.logger.warn(
      `Renewal order ${order.orderNo} not applied on panel, keeping PROCESSING for diff retry`,
    );
    throw new BadRequestException('续费尚未在面板生效，系统将自动重试');
  }

  // 【对账回滚已彻底移除（对抗复核确认）】旧实现靠 rollbackRenewalLocal 恢复本地快照 +
  // 清 renewalAppliedAt → cron 下一轮整量重跑。但面板失败 ≠ 未生效（3xui 先落库后返回），
  // 恢复本地后重跑会再整量加一次 → 面板重复加量（到期 = 原 + 2×时长）。settle 现在一律
  // 保持 PROCESSING + renewalAppliedAt，逐分钟按面板差值补齐（diff 幂等），面板恢复后
  // 收敛；本地无需回滚，也不存在半同步状态需要清理。

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
          this.logger.log(`Auto-activated order ${order.orderNo} (${order.status} → ${result.order?.status})`);
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
   * 清理「已发起支付但一直未付款/未完成」的 PENDING 订单（每 2 分钟扫一次）：
   * - 后台可配置超时分钟数（orderExpireMinutes，默认 15 = 15 分钟）；订单未支付
   *   或支付未成功（未收到回调确认）超过该时间即置 EXPIRED 关闭。
   * - BALANCE 单也要清理：余额支付失败（如余额不足）会留下 PENDING BALANCE 单，
   *   前端不会再自动重试，不清理会一直占着优惠券名额。
   * - 置 EXPIRED 并释放占用的优惠券名额 —— 否则每次「扫码不付就关页」都会白占
   *   一个券名额（usedCount + 每人限用次数），限量券可能被非付款用户耗尽。
   * - 说明：EXPIRED 为终态，若极端情况下日后真有延迟回调到达，
   *   handlePaymentSuccess 会按终态拒绝（防"取消后收款"的既有安全约束），需管理员核对。
   * - 注意：支付渠道二维码有效期（微信约 2h、支付宝约 30m）长于默认 15 分钟，
   *   超时之后到达的回调会被 EXPIRED 终态拒收，可走后台「人工确认收款」入账。
   */
  @Cron('*/2 * * * *')
  async expireStaleGatewayOrders() {
    const expireMs = await this.getOrderExpireMs();
    const cutoff = new Date(Date.now() - expireMs);
    const stale = await this.prisma.order.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
        // 【minor#932 + 对抗复核】payMethod=null 的 PENDING 单也纳入过期清理：
        // 一直未发起支付（含余额支付失败没重试）的单不清理会永久占着优惠券名额，
        // 而且很久前的单日后仍可能被新发起支付并按当时承诺生效 —— 一并置 EXPIRED 杜绝
        OR: [
          { payMethod: { in: ['WECHAT', 'ALIPAY', 'BALANCE'] } },
          { payMethod: null },
        ],
      },
      select: { id: true, couponId: true },
      take: 200,
    });
    for (const order of stale) {
      // 【复核⑧】CAS 收敛：findMany 读到的 PENDING 与写回 EXPIRED 之间，用户可能恰好
      // 支付成功（回调置 PAID/COMPLETED）→ 绝对 update 会把已收款单拍成 EXPIRED，回调
      // 随即被终态拒收（钱卡死）。updateMany(status=PENDING→EXPIRED) 原子抢占，count=0
      // 说明已被支付/取消，本次不动状态；仅真正置 EXPIRED 才释放其占用的优惠券名额。
      const claimed = await this.prisma.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      if (claimed.count > 0 && order.couponId) await this.couponService.releaseCoupon(order.couponId);
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
          virtualProduct: { select: { id: true, name: true, nameEn: true, deliveryType: true } },
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

  /**
   * 我的商品：用户已购的虚拟商品订单（支付成功即视为已购）。
   * PAID=刚支付完仍在激活中；COMPLETED=AUTO 已自动发码 / MANUAL 已完结整单（deliveryInfo
   * 留空=等待管理员发货）。已退款/已取消/未支付的不算已购。
   */
  async getUserProducts(userId: number) {
    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        virtualProductId: { not: null },
        status: { in: ['PAID', 'COMPLETED'] },
      },
      include: {
        virtualProduct: {
          select: { id: true, name: true, nameEn: true, deliveryType: true, price: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return orders;
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
          virtualProduct: { select: { id: true, name: true, nameEn: true, deliveryType: true } },
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
      include: {
        plan: true,
        virtualProduct: { select: { id: true, name: true, nameEn: true, deliveryType: true } },
        user: { select: { email: true, username: true } },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }

  // ==========================================
  // Admin Operations
  // ==========================================

  async adminActivate(id: number) {
    // Mark as paid then activate
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');

    if (order.status === 'PENDING') {
      await this.prisma.order.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date() },
      });
    }

    return this.activateOrder(id);
  }

  /**
   * 管理员发货（仅 MANUAL 虚拟商品单）：
   * 约束 virtualProductId 非空 + deliveryType=MANUAL + 订单 COMPLETED + deliveryInfo 为空。
   * CAS（deliveryInfo IS NULL）防止并发双击重复发货；SOLD 的 AUTO 码单不允许走人工发货。
   */
  async deliverVirtualOrder(orderId: number, content: string) {
    const text = String(content || '').trim();
    if (!text) {
      throw new BadRequestException('交付内容不能为空');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { virtualProduct: { select: { id: true, deliveryType: true } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (!order.virtualProductId) {
      throw new BadRequestException('该订单不是虚拟商品订单，无需发货');
    }
    if (order.virtualProduct?.deliveryType !== 'MANUAL') {
      throw new BadRequestException('自动发货商品付款后已自动发放，无需人工发货');
    }
    if (order.status !== 'COMPLETED') {
      throw new BadRequestException('订单尚未完成（未支付/处理中），暂不能发货');
    }

    // CAS：已发货（deliveryInfo 非空）的单不可再发；失败说明已被并发发货抢走
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, virtualProductId: { not: null }, deliveryInfo: null },
      data: { deliveryInfo: text, deliveredAt: new Date() },
    });
    if (claimed.count === 0) {
      const cur = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { deliveryInfo: true },
      });
      if (cur?.deliveryInfo) {
        throw new ConflictException('该订单已发货，请勿重复操作');
      }
      throw new ConflictException('订单状态已变更，无法发货，请刷新后重试');
    }

    this.logger.log(`Virtual order ${order.orderNo} delivered by admin`);
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  async cancel(id: number, reason = '') {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');
    if (!['PENDING', 'FAILED'].includes(order.status)) {
      throw new ConflictException('订单无法取消');
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
    if (!order) throw new NotFoundException('订单不存在');
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
