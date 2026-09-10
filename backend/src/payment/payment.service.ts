import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { OrderService } from '../order/order.service';
import { SystemService } from '../system/system.service';
import { CouponService } from '../coupon/coupon.service';
import { createHash, createPrivateKey, createPublicKey, sign as rsaSign, verify as rsaVerify } from 'crypto';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private orderService: OrderService,
    private systemService: SystemService,
    private couponService: CouponService,
  ) {}

  // ==========================================
  // Payment Configuration (from DB via System settings)
  // ==========================================

  async getWechatConfig() {
    const s = await this.systemService.getSettings('payment');
    return {
      enabled: s.wechatEnabled === true || s.wechatEnabled === 'true',
      appId: s.wechatAppId || '',
      mchId: s.wechatMchId || '',
      apiKey: s.wechatApiKey || '',
      apiV3Key: s.wechatApiV3Key || '',
      certPath: s.wechatCertPath || '',
      notifyUrl: s.wechatNotifyUrl || '',
    };
  }

  async getAlipayConfig() {
    const s = await this.systemService.getSettings('payment');
    return {
      enabled: s.alipayEnabled === true || s.alipayEnabled === 'true',
      appId: s.alipayAppId || '',
      privateKey: s.alipayPrivateKey || '',
      publicKey: s.alipayPublicKey || '',
      gateway: s.alipayGateway || 'https://openapi.alipay.com/gateway.do',
      notifyUrl: s.alipayNotifyUrl || '',
    };
  }

  // ==========================================
  // Unified Payment Gateway
  // ==========================================

  /**
   * Create payment for an order.
   * Method: wechat | alipay | card | balance
   */
  async createPayment(orderId: number, userId: number, method: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new BadRequestException('Not your order');
    if (order.status !== 'PENDING') throw new BadRequestException('Order already processed');

    switch (method) {
      case 'wechat':
        // 实付金额 = 优惠后金额（payAmount，优惠券已在此下单时算好）；amount 恒为原价
        return this.createWechatPayment({
          id: order.id,
          orderNo: order.orderNo,
          amount: Number(order.payAmount ?? order.amount),
          type: 'order',
        });
      case 'alipay':
        return this.createAlipayPayment({
          id: order.id,
          orderNo: order.orderNo,
          amount: Number(order.payAmount ?? order.amount),
          type: 'order',
        });
      case 'card':
        return { needCardCode: true, orderId: order.id, amount: order.payAmount ?? order.amount };
      case 'balance':
        return this.payWithBalance(order);
      default:
        throw new BadRequestException(`Unsupported payment method: ${method}`);
    }
  }

  /**
   * 统一网关下单（商品单 / 余额直充共用）：
   * ref.type = 'order' → 商品订单；'recharge' → 余额直充单。
   * 生成的支付二维码/链接与实体校验逻辑完全相同，仅 payMethod 落库位置不同。
   */
  async createGatewayRefPayment(
    ref: { id: number; orderNo: string; amount: number; subject?: string; type: 'order' | 'recharge' },
    method: string,
  ) {
    switch (method) {
      case 'wechat':
        return this.createWechatPayment(ref);
      case 'alipay':
        return this.createAlipayPayment(ref);
      default:
        throw new BadRequestException(`Unsupported payment method: ${method}`);
    }
  }

  // ==========================================
  // Card Key Redemption (卡密兑换)
  // ==========================================

  async redeemCard(userId: number, code: string): Promise<any> {
    // 卡密对外格式：[前缀-]XXXX-XXXX-XXXX-XXXX（大写、序列固定 16 位，前缀为管理员生成时可自定义）。
    // 用户录入时可能去掉连字符、写小写或带空格 → 统一规范化（去所有非字母数字再转大写）。
    const normalizedInput = String(code || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!normalizedInput) throw new BadRequestException('卡密无效');
    // 【对抗复核确认】不整体拒绝超长输入：管理端生成卡时对前缀长度无上限（card.service
    // 原样保存前缀，旧实现靠 JS 全量匹配可兑超长前缀卡）—— 硬性 `>64 判无效` 等于冻结
    // 这些历史卡（旧逻辑能兑、新逻辑直接拒绝）。代价只体现在枚举工作量，因此把
    // 「可疑超长」直接跳过索引枚举、交给下方回退 2 的 SQL 归一化等值（一次全表扫描，
    // 与旧实现同量级），两种长度都能兑。

    // 索引化查询（不再全表加载 JS 正则比对）。序列固定 16 位，但前缀边界未知：
    // 输入去连字符后「前缀在哪结束、序列从哪开始」无从分辨 → 枚举候选边界，拼回
    // 「前缀-XXXX-XXXX-XXXX-XXXX」逐档做唯一索引精确查。库中只有一个真前缀边界，
    // 只有它能精确命中，其余边界全是 findUnique miss（无害）。老卡无前缀时 pre=0 命中。
    // 【复核⑤⑥⑦修订】候选顺序与边界规则：
    //  - enumMaxPre = min(len-16, 32)：前缀 ≤32 字符走索引枚举（代价 ≤33 次 findUnique
    //    miss）；更长前缀直接交给 SQL 归一化等值兜底，不受上限影响
    //  - 每个边界先试「前缀-序列」再试裸序列；裸序列候选只在 pre=0 保留 —— pre>0 时
    //    裸 16 位序列若在库中另有「真正无前缀」的同号卡，会兑错卡
    const len = normalizedInput.length;
    const maxPre = len - 16;
    const enumMaxPre = Math.min(maxPre, 32);
    let card = null;
    for (let pre = 0; pre <= enumMaxPre && !card; pre++) {
      const serial = normalizedInput.slice(pre);
      if (serial.length !== 16) continue; // 序列必须正好 16 位
      const dasher = (s: string) => s.replace(/(\w{4})(?=\w)/g, '$1-');
      const prefix = normalizedInput.slice(0, pre);
      // preferred：带前缀完整还原（大写前缀 + 连字符序列）
      if (prefix) {
        card = await this.prisma.card.findUnique({ where: { code: `${prefix}-${dasher(serial)}` } });
        if (card) break;
      }
      // pre=0 的裸序列（无前缀老卡）
      if (pre === 0) {
        card = await this.prisma.card.findUnique({ where: { code: dasher(serial) } });
        if (card) break;
      }
    }
    // 回退 1：早期可能落库未带连字符的紧凑格式
    if (!card) card = await this.prisma.card.findUnique({ where: { code: normalizedInput } });
    // 回退 2（对抗复核确认重写）：旧实现是 JS 大小写不敏感的「去格式后全码等值」匹配，
    // 索引化枚举对它丢了兼容 —— 存储码带连字符（如 "vip-1234-5678-9012-3456"）时，
    // 去连字符的输入永远不是它的子串，contains-insensitive 永不命中；而系统生成的
    // 小写/混合大小写前缀卡（card.service generateCardCode 原样写前缀，无规范化）同样
    // 兑不了。改成 SQL 侧归一化等值：去非字母数字 + 转大写后逐字符相等才算命中 ——
    // 语义与旧实现完全一致，且仍是严格全码等值（裸码不会因为「包含在更长的码里」被误兑）。
    if (!card) {
      const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "Card"
        WHERE UPPER(REGEXP_REPLACE("code", '[^a-zA-Z0-9]', '', 'g')) = ${normalizedInput}
        LIMIT 1`;
      if (rows.length) card = await this.prisma.card.findUnique({ where: { id: rows[0].id } });
    }
    if (!card) throw new BadRequestException('卡密无效');
    if (card.status === 'USED') throw new BadRequestException('卡密已被使用');
    if (card.status === 'CANCELLED') throw new BadRequestException('卡密已作废');

    // 事务内原子占卡：用 updateMany(status=UNUSED) 抢占，count=0 说明已被并发请求兑走，
    // 杜绝「同一张卡并发双兑、余额充两次」的 TOCTOU 漏洞。
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      const claimed = await tx.card.updateMany({
        where: { id: card.id, status: 'UNUSED' },
        data: { status: 'USED', usedBy: userId, usedAt: new Date() },
      });
      if (claimed.count === 0) {
        // 并发抢兑/该卡已被使用（或被标记黑名单）：updateMany 的 CAS 保证只会有一笔成功
        throw new BadRequestException('卡密已被使用或无效');
      }

      // 原子加余额（递增），绝不用「读→算→写绝对数」：并发与充值/另一张卡到账时
      // 会互相覆盖，丢失一次入账
      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: Number(card.amount) } },
      });

      // Record transaction（交易后余额 = 递增后的真实值）
      await tx.transaction.create({
        data: {
          userId,
          type: 'CARD_REDEEM',
          amount: card.amount,
          balance: updated.balance,
          description: `Card redemption: ${code}`,
          relatedId: code,
        },
      });

      return {
        amount: card.amount,
        balance: updated.balance,
        message: `Successfully redeemed ${card.amount}`,
      };
    });
  }

  // ==========================================
  // Order/Payment status (for frontend polling)
  // ==========================================

  async getOrderStatus(orderNo: string, userId: number): Promise<any> {
    const order = await this.prisma.order.findUnique({ where: { orderNo } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new BadRequestException('Not your order');

    return {
      orderNo: order.orderNo,
      orderId: order.id,
      status: order.status, // PENDING / PAID / COMPLETED / PROCESSING / CANCELLED / EXPIRED
      paid: order.status === 'COMPLETED' || order.status === 'PAID' || order.status === 'PROCESSING',
      amount: order.payAmount ?? order.amount, // 实付（优惠后）
      originalAmount: order.amount, // 原价
      createdAt: order.createdAt,
    };
  }

  // ==========================================
  // WeChat Pay (Native QR Code) - 真实下单
  // ==========================================

  /** 未支付超时分钟数（后台 orderExpireMinutes 配置，默认 15） */
  private async getOrderExpireMs(): Promise<number> {
    const minutes =
      Number(await this.systemService.getSetting('orderExpireMinutes').catch(() => null)) || 15;
    return minutes * 60 * 1000;
  }

  /** 网关单超时护栏（配套 expireStaleGatewayOrders / expireStaleRecharges）：
   *  订单/充值单 PENDING 超过配置分钟数由定时任务置 EXPIRED；任务还没跑到的窗口内，
   *  这里直接拦截，避免前端轮询/重试给「僵尸单」无限生成新支付二维码。
   *  顺手把状态收敛成 EXPIRED（幂等），下一拍定时任务不会再找到它。 */
  private async assertOrderWithinPaymentWindow(ref: { id: number; type: 'order' | 'recharge' }) {
    const expireMs = await this.getOrderExpireMs();
    if (ref.type === 'recharge') {
      const recharge = await this.prisma.recharge.findUnique({
        where: { id: ref.id },
        select: { createdAt: true, status: true },
      });
      if (!recharge) throw new NotFoundException('充值单不存在');
      if (recharge.status !== 'PENDING') throw new BadRequestException('充值订单已处理，请刷新页面后再试');
      if (Date.now() - recharge.createdAt.getTime() > expireMs) {
        // CAS 收敛：与商品单一致，避免「读时 PENDING → 恰好支付成功 → 绝对写回 EXPIRED」拍死已收款的单
        await this.prisma.recharge.updateMany({
          where: { id: ref.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        throw new BadRequestException(
          `充值订单已超过 ${Math.round(expireMs / 60000)} 分钟未支付，已自动取消，请重新发起`,
        );
      }
      return;
    }
    const order = await this.prisma.order.findUnique({
      where: { id: ref.id },
      select: { createdAt: true, status: true, couponId: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING') throw new BadRequestException('订单已处理，请刷新页面后再试');
    if (Date.now() - order.createdAt.getTime() > expireMs) {
      // 【复核⑧⑨】CAS 收敛：用 updateMany(status=PENDING→EXPIRED) 原子抢占，绝不用
      // 读后的绝对 update —— 否则「读时 PENDING → 用户恰好此刻支付成功（PAID）→ 写回
      // EXPIRED」会把已收款的单拍死，回调再来就被终态拒收（钱卡死等人工对账）。
      // count=0 说明订单已被支付/取消，本次不动状态，付款回调查到 PAID 照常完结。
      const claimed = await this.prisma.order.updateMany({
        where: { id: ref.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      // 仅当本次真的置 EXPIRED 才释放占用的优惠券名额（与 expireStaleGatewayOrders 一致；
      // releaseCoupon 幂等：usedCount>0 才递减）
      if (claimed.count > 0 && order.couponId) {
        await this.couponService.releaseCoupon(order.couponId);
      }
      throw new BadRequestException(
        `订单已超过 ${Math.round(expireMs / 60000)} 分钟未支付，已自动取消，请重新下单`,
      );
    }
  }

  private async createWechatPayment(ref: {
    id: number;
    orderNo: string;
    amount: number;
    subject?: string;
    type: 'order' | 'recharge';
  }) {
    await this.assertOrderWithinPaymentWindow(ref);
    const config = await this.getWechatConfig();
    if (!config.enabled || !config.appId || !config.mchId || !config.apiKey) {
      throw new BadRequestException('微信支付未配置完整（需 appId/商户号/apiKey），请到管理后台-系统设置-支付配置填写');
    }

    // 微信 Native 下单 (v2 API: /pay/unifiedorder)
    // 请求参数（真实签名）
    const params: Record<string, string> = {
      appid: config.appId,
      mch_id: config.mchId,
      nonce_str: this.buildNonce(32),
      body: `NodeShop-${ref.subject || ref.orderNo}`.slice(0, 128),
      out_trade_no: ref.orderNo,
      total_fee: String(Math.round(Number(ref.amount) * 100)), // 分
      spbill_create_ip: this.getClientIp(),
      notify_url: config.notifyUrl || process.env.WECHAT_NOTIFY_URL || `${await this.getAppUrl()}/api/payments/callback/wechat`,
      trade_type: 'NATIVE',
    };

    // MD5 签名
    params.sign = this.wechatSign(params, config.apiKey);

    // 组装 XML 并发起真实请求
    const xml = this.buildWechatXml(params);
    const apiRes = await fetch('https://api.mch.weixin.qq.com/pay/unifiedorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
    });
    const xmlText = await apiRes.text();
    const result = await this.parseXml(xmlText);

    if (result.return_code !== 'SUCCESS' || result.result_code !== 'SUCCESS') {
      this.logger.error(`微信下单失败: ${result.return_msg || result.err_code_des}`);
      throw new BadRequestException(`微信下单失败: ${result.return_msg || result.err_code_des || '未知错误'}`);
    }

    const codeUrl = result.code_url; // 真实支付二维码内容

    // 支付方式落库：商品单写到 Order，直充单写到 Recharge
    if (ref.type === 'recharge') {
      await this.prisma.recharge.update({
        where: { id: ref.id },
        data: { payMethod: 'WECHAT' },
      });
    } else {
      await this.prisma.order.update({
        where: { id: ref.id },
        data: { payMethod: 'WECHAT' },
      });
    }

    return {
      method: 'wechat',
      orderNo: ref.orderNo,
      amount: ref.amount,
      paymentId: params.out_trade_no,
      codeUrl,
      qrContent: codeUrl,
      expiresIn: 1800,
    };
  }

  // ==========================================
  // Alipay - 真实下单
  // ==========================================

  private async createAlipayPayment(ref: {
    id: number;
    orderNo: string;
    amount: number;
    subject?: string;
    type: 'order' | 'recharge';
  }) {
    await this.assertOrderWithinPaymentWindow(ref);
    const config = await this.getAlipayConfig();
    if (!config.enabled || !config.appId || !config.privateKey) {
      throw new BadRequestException('支付宝未配置完整（需 appId/应用私钥），请到管理后台-系统设置-支付配置填写');
    }

    // 支付宝当面付/扫码 (alipay.trade.precreate)
    const bizContent = JSON.stringify({
      out_trade_no: ref.orderNo,
      total_amount: Number(ref.amount).toFixed(2),
      subject: ref.subject ? `NodeShop-${ref.subject}` : `NodeShop-${ref.orderNo}`,
      timeout_express: '30m',
    });

    const params: Record<string, string> = {
      app_id: config.appId,
      method: 'alipay.trade.precreate',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: this.formatAlipayTime(),
      version: '1.0',
      notify_url: config.notifyUrl || process.env.ALIPAY_NOTIFY_URL || `${await this.getAppUrl()}/api/payments/callback/alipay`,
      biz_content: bizContent,
    };

    // RSA2 签名并追加签名参数
    params.sign = this.alipaySign(params, config.privateKey);

    // 发起真实网关请求：alipay.trade.precreate 是服务端到服务端的 API，
    // 必须 POST x-www-form-urlencoded 到网关，响应体里才带可扫码的 qr_code。
    // （把网关 API URL 直接当二维码内容返回是错的——支付宝里扫它只会看到 JSON，钱永远付不出去。）
    const formBody = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    let respJson: any;
    try {
      const apiRes = await fetch(config.gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: formBody,
      });
      respJson = await apiRes.json();
    } catch (e) {
      this.logger.error(`支付宝下单网关请求失败: ${(e as Error).message}`);
      throw new BadRequestException('支付宝下单失败：网关请求异常，请稍后重试');
    }
    const resp = respJson?.alipay_trade_precreate_response;
    if (!resp || !resp.code) {
      throw new BadRequestException('支付宝下单失败：网关返回异常');
    }
    if (resp.code !== '10000') {
      this.logger.error(
        `支付宝下单失败: code=${resp.code} msg=${resp.msg || ''} sub_msg=${resp.sub_msg || ''}`,
      );
      throw new BadRequestException(
        `支付宝下单失败：${resp.sub_msg || resp.msg || '未知错误'}`,
      );
    }
    // 可选校验网关响应签名（公钥配置齐全时 fail-closed，防网关响应被篡改）
    if (config.publicKey && respJson.sign) {
      const content = Object.keys(resp)
        .filter((k) => resp[k] !== '' && resp[k] !== undefined)
        .sort()
        .map((k) => `${k}=${resp[k]}`)
        .join('&');
      if (!this.alipayVerifySignature(content, respJson.sign, config.publicKey)) {
        this.logger.warn(`支付宝网关响应验签失败: ${ref.orderNo}`);
        throw new BadRequestException('支付宝下单失败：网关响应签名校验未通过');
      }
    }
    const qrCode = String(resp.qr_code || '');
    if (!qrCode) {
      throw new BadRequestException('支付宝下单失败：未返回支付二维码');
    }

    // 支付方式落库：只有网关下单成功才标记；网关失败不落库，保持可取消/可换支付方式
    if (ref.type === 'recharge') {
      await this.prisma.recharge.update({
        where: { id: ref.id },
        data: { payMethod: 'ALIPAY' },
      });
    } else {
      await this.prisma.order.update({
        where: { id: ref.id },
        data: { payMethod: 'ALIPAY' },
      });
    }

    return {
      method: 'alipay',
      orderNo: ref.orderNo,
      amount: ref.amount,
      paymentId: ref.orderNo,
      codeUrl: qrCode,
      qrContent: qrCode, // 真实扫码内容（https://qr.alipay.com/...）
      expiresIn: 1800,
    };
  }

  // ==========================================
  // Payment Callback / Verification
  // ==========================================

  /**
   * 微信支付通知验签：解析 XML → 校验 return_code/result_code → 校验 MD5 签名。
   * 验签失败抛 BadRequestException（返回 FAIL，微信稍后重试）。
   */
  async parseWechatCallback(rawXml: string): Promise<Record<string, string>> {
    const config = await this.getWechatConfig();
    if (!config.enabled || !config.apiKey) {
      throw new BadRequestException('微信支付未配置（缺 apiKey），无法验证回调签名');
    }
    // 解析 XML（parseXml 是异步的，必须 await——漏掉会把 Promise 当对象用，
    // 回调验签永远失败、微信无限重试、订单永远到不了账）
    const params = await this.parseXml(String(rawXml || ''));
    if (!params || !params.out_trade_no) {
      throw new BadRequestException('微信回调参数缺失（无 out_trade_no）');
    }
    if (params.return_code !== 'SUCCESS' || params.result_code !== 'SUCCESS') {
      throw new BadRequestException(`微信回调状态异常: return_code=${params.return_code}, result_code=${params.result_code}`);
    }
    if (!this.wechatVerifySign(params, config.apiKey)) {
      // 防伪造：任何验签失败都必须拒绝，绝不写入支付成功
      this.logger.warn(`微信回调验签失败: ${params.out_trade_no}`);
      throw new BadRequestException('微信回调签名校验失败');
    }
    return params;
  }

  /**
   * 支付宝异步通知验签：RSA2 校验 sign + trade_status 必须是 TRADE_SUCCESS/TRADE_FINISHED。
   * 验签失败抛 BadRequestException（返回 fail，支付宝稍后重试）。
   */
  async parseAlipayCallback(body: Record<string, any>): Promise<Record<string, string>> {
    const config = await this.getAlipayConfig();
    if (!config.enabled || !config.publicKey) {
      throw new BadRequestException('支付宝未配置（缺应用公钥），无法验证回调签名');
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (typeof v === 'string') params[k] = v;
    }
    const sign = params.sign;
    if (!sign || !params.out_trade_no) {
      throw new BadRequestException('支付宝回调参数缺失（无 out_trade_no/sign）');
    }
    // 支付宝验签规则：排除 sign/sign_type，其余参数按 key 升序拼 a=b&c=d
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    // 应用公钥：兼容 PEM 与裸 base64 两种格式
    let pem = config.publicKey.trim();
    if (!pem.includes('-----BEGIN')) {
      pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
    }
    try {
      const publicKey = createPublicKey(pem);
      const ok = rsaVerify('RSA-SHA256', Buffer.from(content, 'utf8'), publicKey, Buffer.from(sign, 'base64'));
      if (!ok) {
        this.logger.warn(`支付宝回调验签失败: ${params.out_trade_no}`);
        throw new BadRequestException('支付宝回调签名校验失败');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`支付宝回调签名校验失败: ${(e as Error).message}`);
    }
    const tradeStatus = params.trade_status;
    // 失败关闭：交易状态必须精确等于成功/已完成，缺失或任何其他值一律拒绝
    if (!tradeStatus || !['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(tradeStatus)) {
      throw new BadRequestException(`支付宝回调交易状态未完成: ${tradeStatus || 'missing'}`);
    }
    // 回调必须属于本商户配置的 app_id（防跨应用串号）
    if (params.app_id && config.appId && params.app_id !== config.appId) {
      throw new BadRequestException(`支付宝回调 app_id 不匹配: ${params.app_id}`);
    }
    return params;
  }

  /**
   * Verify payment and activate order.
   * This is the single entry point called by gateway callbacks or manual admin verification.
   */
  async handlePaymentSuccess(params: {
    orderNo: string;
    tradeNo: string;
    amount: number;
    payMethod: string;
  }) {
    const { orderNo, tradeNo, amount, payMethod } = params;

    // 基础入参校验（不信任外部传入）
    if (!orderNo || typeof orderNo !== 'string') {
      throw new BadRequestException('Missing orderNo');
    }
    if (!tradeNo || typeof tradeNo !== 'string') {
      throw new BadRequestException('Missing tradeNo');
    }
    const normalizedMethod = String(payMethod || '').toUpperCase();
    if (!['WECHAT', 'ALIPAY', 'OFFLINE', 'BALANCE'].includes(normalizedMethod)) {
      throw new BadRequestException(`Unsupported payMethod: ${payMethod}`);
    }
    // PayMethod 枚举不包含 OFFLINE（人工确认不是真实支付渠道）。
    // 先归一：OFFLINE → null 落库（该列可空），避免 Prisma 运行时枚举校验直接拒写。
    const storedMethod = normalizedMethod === 'OFFLINE' ? null : (normalizedMethod as any);
    if (!(Number(amount) > 0)) {
      throw new BadRequestException('Invalid payment amount');
    }

    const order = await this.prisma.order.findUnique({
      where: { orderNo },
    });
    if (!order) throw new NotFoundException('Order not found');

    // 终态处理：已完成直接返回；已取消/已失败/已退款/已过期一律拒绝恢复
    // （防"取消后又收款""退款后又收款"类绕过）
    if (order.status === 'COMPLETED') {
      return { success: true, message: 'Already completed' };
    }
    if (['CANCELLED', 'FAILED', 'REFUNDED', 'EXPIRED'].includes(order.status)) {
      this.logger.warn(`Payment callback for terminal order ${orderNo} (${order.status}) rejected`);
      throw new BadRequestException(`Order is ${order.status.toLowerCase()}`);
    }

    // Verify amount matches（允许用户多付，不允许少付）。实付以 payAmount（优惠后）为准
    const chargeAmount = Number(order.payAmount ?? order.amount);
    if (chargeAmount > amount) {
      this.logger.warn(`Payment amount mismatch for ${orderNo}: expected ${chargeAmount} got ${amount}`);
      throw new BadRequestException('Payment amount mismatch');
    }

    // 认领 + 流水同一事务：确保「订单已收款(PAID)」与「PURCHASE 流水落库」原子，
    // 杜绝崩溃在两者之间 → 钱已收但流水缺失，统计与用户账单永久少计。
    const claimed = await this.prisma.$transaction(async (tx) => {
      // 原子收款标记：只有仍为 PENDING 的订单能抢占成功。
      // 并发双回调 / 回调与余额支付竞争 → 只有一方 count=1，另方可直接拿到幂等结果，
      // 不会重复写 PURCHASE 流水、不会重复走激活。
      const res = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          payMethod: storedMethod,
          tradeNo,
        },
      });
      if (res.count === 0) {
        const cur = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (cur && ['PAID', 'PROCESSING', 'COMPLETED'].includes(cur.status)) {
          return { alreadyPaid: true };
        }
        throw new ConflictException('Order state changed, please retry');
      }

      // 网关支付不改动余额，但流水 balance 字段对外语义是「交易后余额」：
      // 快照该用户真实余额，避免前端把流水里的 0 当成用户余额清零。
      const userBal = await tx.user.findUnique({
        where: { id: order.userId },
        select: { balance: true },
      });
      if (!userBal) throw new NotFoundException('User not found');

      // Record transaction（金额记实付：优惠券后金额）
      await tx.transaction.create({
        data: {
          userId: order.userId,
          type: 'PURCHASE',
          amount: chargeAmount,
          balance: userBal.balance,
          description: `Order ${orderNo}`,
          relatedId: orderNo,
        },
      });
      return { alreadyPaid: false };
    });

    if (claimed.alreadyPaid) {
      return { success: true, message: 'Already paid' };
    }

    // Activate the node (create inbound in XUI)
    try {
      const activation = await this.orderService.activateOrder(order.id);
      return { success: true, data: activation };
    } catch (e) {
      this.logger.error(`Failed to activate order ${orderNo}: ${e.message}`);
      // Order is paid but activation failed. 只有仍处中间态才标记 PROCESSING 等 cron 重试；
      // 终态（如续费校验失败置的 FAILED）保持原样，避免把失败订单被"复活"成处理中。
      try {
        const cur = await this.prisma.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (cur && ['PENDING', 'PAID'].includes(cur.status)) {
          await this.prisma.order.update({
            where: { id: order.id },
            data: { status: 'PROCESSING' },
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to update order status after activation error: ${(err as Error).message}`);
      }
      return { success: false, message: `Payment received but activation failed: ${e.message}`, orderId: order.id };
    }
  }

  private payWithBalance(order: any) {
    return this.orderService.payWithBalance(order.userId, order.id);
  }

  // ==========================================
  // 余额直充结算（余额充值单专享）
  // ==========================================

  /**
   * 网关回调统一切口：按订单号前缀分流。
   * - RC 开头 → 余额直充单（handleRechargeSuccess：充值入账）
   * - 其他（SO 等）→ 商品单（handlePaymentSuccess：激活节点）
   */
  async settleGatewayCallback(params: {
    orderNo: string;
    tradeNo: string;
    amount: number;
    payMethod: string;
  }) {
    if (String(params.orderNo || '').startsWith('RC')) {
      return this.handleRechargeSuccess(params);
    }
    return this.handlePaymentSuccess(params);
  }

  /**
   * 直充单收款确认：原子认领（只有 PENDING 能抢到，防并发双回调重复入账）+ 校验金额 + 入账余额。
   * 复用与商品单相同的安全约束：终态不可复活、允许多付不允许少付。
   */
  async handleRechargeSuccess(options: {
    orderNo: string;
    tradeNo: string;
    amount: number;
    payMethod: string;
  }) {
    const { orderNo, tradeNo, amount, payMethod } = options;

    if (!orderNo || typeof orderNo !== 'string') {
      throw new BadRequestException('Missing orderNo');
    }
    if (!tradeNo || typeof tradeNo !== 'string') {
      throw new BadRequestException('Missing tradeNo');
    }
    const normalizedMethod = String(payMethod || '').toUpperCase();
    if (!['WECHAT', 'ALIPAY', 'OFFLINE'].includes(normalizedMethod)) {
      throw new BadRequestException(`Unsupported payMethod: ${payMethod}`);
    }
    // 同上：OFLLINE 归一为 null 落库，避免写入 PayMethod 枚举外值被 Prisma 拒绝
    const storedMethod = normalizedMethod === 'OFFLINE' ? null : (normalizedMethod as any);
    if (!(Number(amount) > 0)) {
      throw new BadRequestException('Invalid payment amount');
    }

    const recharge = await this.prisma.recharge.findUnique({ where: { orderNo } });
    if (!recharge) throw new NotFoundException('Recharge order not found');

    // 终态：已入账直接幂等返回；已取消/已过期拒绝复活（防「取消后又收款」绕过）
    if (recharge.status === 'PAID') {
      return { success: true, message: 'Already paid' };
    }
    if (['CANCELLED', 'EXPIRED'].includes(recharge.status)) {
      this.logger.warn(`Recharge callback for terminal order ${orderNo} (${recharge.status}) rejected`);
      throw new BadRequestException(`Recharge order is ${recharge.status.toLowerCase()}`);
    }

    // 金额校验：允许多付，不允许少付
    if (Number(recharge.amount) > amount) {
      this.logger.warn(`Recharge amount mismatch for ${orderNo}: expected ${recharge.amount} got ${amount}`);
      throw new BadRequestException('Recharge payment amount mismatch');
    }

    // 认领 + 入账必须在同一事务：否则「先标记 PAID、后加余额」之间崩溃会让充值单
    // 停留在 PAID 而余额永远不入账（网关重试拿到"Already paid"幂等返回，直接跳过入账）。
    const credited = await this.prisma.$transaction(async (tx) => {
      // 原子占单：仅 PENDING 能抢成功；并发双回调只有一方写入，另一方幂等返回
      const claimed = await tx.recharge.updateMany({
        where: { id: recharge.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date(), payMethod: storedMethod, tradeNo },
      });
      if (claimed.count === 0) {
        const cur = await tx.recharge.findUnique({
          where: { id: recharge.id },
          select: { status: true },
        });
        if (cur && cur.status === 'PAID') return { alreadyPaid: true };
        throw new ConflictException('Recharge state changed, please retry');
      }

      // 原子递增余额，绝不用「读→算→写绝对数」：并发充值 / 余额支付会互相覆盖，丢失一次入账
      const updated = await tx.user.update({
        where: { id: recharge.userId },
        data: { balance: { increment: Number(recharge.amount) } },
      });

      // 入账流水（与余额变更同事务。）
      await tx.transaction.create({
        data: {
          userId: recharge.userId,
          type: 'RECHARGE',
          amount: recharge.amount,
          balance: updated.balance,
          description: `Recharge order ${orderNo}`,
          relatedId: orderNo,
        },
      });
      return { alreadyPaid: false, newBalance: updated.balance };
    });

    if (credited.alreadyPaid) {
      return { success: true, message: 'Already paid' };
    }
    this.logger.log(`Recharge ${orderNo} credited ${recharge.amount} to user ${recharge.userId}`);
    return { success: true, data: { orderNo, amount: recharge.amount, balance: credited.newBalance } };
  }

  // ==========================================
  // Helpers
  // ==========================================

  // --- WeChat signing & XML helpers ---

  private buildNonce(length = 32): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  private wechatSign(params: Record<string, string>, apiKey: string): string {
    // 微信 MD5 签名规则：参数名 ASCII 升序，URL键值对拼接 + &key=商户密钥
    const keys = Object.keys(params).sort();
    const str = keys
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signStr = `${str}&key=${apiKey}`;
    return createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
  }

  private wechatVerifySign(params: Record<string, string>, apiKey: string): boolean {
    // 回调验签：排除 sign 字段本身与空值参数，其余与下单同规则
    const received = String(params.sign || '');
    if (!received) return false;
    const { sign, ...rest } = params;
    const str = Object.keys(rest)
      .sort()
      .filter((k) => rest[k] !== '' && rest[k] !== undefined && rest[k] !== null)
      .map((k) => `${k}=${rest[k]}`)
      .join('&');
    const expected = createHash('md5').update(`${str}&key=${apiKey}`, 'utf8').digest('hex').toUpperCase();
    return expected === received;
  }

  private buildWechatXml(params: Record<string, string>): string {
    const body = Object.entries(params)
      .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
      .join('');
    return `<xml>${body}</xml>`;
  }

  private async parseXml(xml: string): Promise<Record<string, string>> {
    // 极简 XML 解析（WeChat 返回 <key><![CDATA[val]]></key> 或 <key>val</key>）
    const result: Record<string, string> = {};
    const regex = /<(\w+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      result[match[1]] = match[2];
    }
    return result;
  }

  // --- Alipay signing helpers ---

  private formatAlipayTime(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  private alipaySign(params: Record<string, string>, privateKey: string): string {
    // 支付宝 RSA2 签名：排除 sign 字段后按 key 升序拼接成 a=b&c=d，再 RSA-SHA256 签名
    const keys = Object.keys(params).sort();
    const content = keys
      .filter((k) => params[k] !== '' && params[k] !== undefined)
      .map((k) => `${k}=${params[k]}`)
      .join('&');

    // Normalize: support both PEM and raw base64 key formats
    let pem = privateKey.trim();
    if (!pem.includes('-----BEGIN')) {
      // Raw base64 — wrap in PEM header
      pem = `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`;
    }

    const keyObject = createPrivateKey(pem);
    const signature = rsaSign('RSA-SHA256', Buffer.from(content, 'utf8'), keyObject);
    return signature.toString('base64');
  }

  /** 校验支付宝网关/回调返回的 RSA2 签名（内容串 + sign；公钥兼容 PEM 与裸 base64） */
  private alipayVerifySignature(content: string, sign: string, publicKey: string): boolean {
    let pem = publicKey.trim();
    if (!pem.includes('-----BEGIN')) {
      pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
    }
    try {
      const pub = createPublicKey(pem);
      return rsaVerify(
        'RSA-SHA256',
        Buffer.from(content, 'utf8'),
        pub,
        Buffer.from(String(sign || ''), 'base64'),
      );
    } catch {
      return false;
    }
  }

  // --- Misc helpers ---

  private getClientIp(): string {
    return '127.0.0.1';
  }

  private async getAppUrl(): Promise<string> {
    // 优先读后台「站点地址」设置；未配置时 fallback 到环境变量
    const dbUrl = await this.systemService.getSetting('siteUrl');
    return (typeof dbUrl === 'string' && dbUrl) || this.configService.get('APP_URL') || 'http://localhost:3001';
  }
}
