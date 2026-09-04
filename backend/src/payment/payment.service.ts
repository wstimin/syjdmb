import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { OrderService } from '../order/order.service';
import { SystemService } from '../system/system.service';
import { createHash, createPrivateKey, sign as rsaSign } from 'crypto';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private orderService: OrderService,
    private systemService: SystemService,
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
        return this.createWechatPayment(order);
      case 'alipay':
        return this.createAlipayPayment(order);
      case 'card':
        return { needCardCode: true, orderId: order.id, amount: order.amount };
      case 'balance':
        return this.payWithBalance(order);
      default:
        throw new BadRequestException(`Unsupported payment method: ${method}`);
    }
  }

  // ==========================================
  // Card Key Redemption (卡密兑换)
  // ==========================================

  async redeemCard(userId: number, code: string): Promise<any> {
    const card = await this.prisma.card.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    if (!card) throw new BadRequestException('Invalid card key');
    if (card.status === 'USED') throw new BadRequestException('Card key already used');
    if (card.status === 'CANCELLED') throw new BadRequestException('Card key cancelled');

    // Redeem in transaction
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      const newBalance = Number(user.balance) + Number(card.amount);

      // Update card
      await tx.card.update({
        where: { id: card.id },
        data: { status: 'USED', usedBy: userId, usedAt: new Date() },
      });

      // Update user balance
      await tx.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      });

      // Record transaction
      await tx.transaction.create({
        data: {
          userId,
          type: 'CARD_REDEEM',
          amount: card.amount,
          balance: newBalance,
          description: `Card redemption: ${code}`,
          relatedId: code,
        },
      });

      return {
        amount: card.amount,
        balance: newBalance,
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
      status: order.status, // PENDING / PAID / COMPLETED / PROCESSING / CANCELLED
      paid: order.status === 'COMPLETED' || order.status === 'PAID',
      amount: order.amount,
    };
  }

  // ==========================================
  // WeChat Pay (Native QR Code) - 真实下单
  // ==========================================

  private async createWechatPayment(order: any) {
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
      body: `NodeShop-${order.planName || order.orderNo}`.slice(0, 128),
      out_trade_no: order.orderNo,
      total_fee: String(Math.round(Number(order.amount) * 100)), // 分
      spbill_create_ip: this.getClientIp(),
      notify_url: config.notifyUrl || process.env.WECHAT_NOTIFY_URL || `${this.getAppUrl()}/api/payments/callback/wechat`,
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

    await this.prisma.order.update({
      where: { id: order.id },
      data: { payMethod: 'WECHAT' },
    });

    return {
      method: 'wechat',
      orderNo: order.orderNo,
      amount: order.amount,
      paymentId: params.out_trade_no,
      codeUrl,
      qrContent: codeUrl,
      expiresIn: 1800,
    };
  }

  // ==========================================
  // Alipay - 真实下单
  // ==========================================

  private async createAlipayPayment(order: any) {
    const config = await this.getAlipayConfig();
    if (!config.enabled || !config.appId || !config.privateKey) {
      throw new BadRequestException('支付宝未配置完整（需 appId/应用私钥），请到管理后台-系统设置-支付配置填写');
    }

    // 支付宝当面付/扫码 (alipay.trade.precreate)
    const bizContent = JSON.stringify({
      out_trade_no: order.orderNo,
      total_amount: Number(order.amount).toFixed(2),
      subject: `NodeShop-${order.orderNo}`,
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
      notify_url: config.notifyUrl || process.env.ALIPAY_NOTIFY_URL || `${this.getAppUrl()}/api/payments/callback/alipay`,
      biz_content: bizContent,
    };

    // RSA2 签名并追加签名参数
    params.sign = this.alipaySign(params, config.privateKey);

    // 拼接真实网关请求 URL
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const payUrl = `${config.gateway}?${query}`;

    await this.prisma.order.update({
      where: { id: order.id },
      data: { payMethod: 'ALIPAY' },
    });

    return {
      method: 'alipay',
      orderNo: order.orderNo,
      amount: order.amount,
      paymentId: order.orderNo,
      payUrl, // 真实支付跳转/二维码内容
      qrContent: payUrl,
    };
  }

  // ==========================================
  // Payment Callback / Verification
  // ==========================================

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

    const order = await this.prisma.order.findUnique({
      where: { orderNo },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.status === 'COMPLETED') {
      return { success: true, message: 'Already completed' };
    }

    // Verify amount matches
    if (Number(order.amount) > amount) {
      this.logger.warn(`Payment amount mismatch for ${orderNo}`);
      throw new BadRequestException('Payment amount mismatch');
    }

    // Mark as paid
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        payMethod: payMethod as any,
        tradeNo,
      },
    });

    // Record transaction
    await this.prisma.transaction.create({
      data: {
        userId: order.userId,
        type: 'PURCHASE',
        amount: order.amount,
        balance: 0,
        description: `Order ${orderNo}`,
        relatedId: orderNo,
      },
    });

    // Activate the node (create inbound in XUI)
    try {
      const activation = await this.orderService.activateOrder(order.id);
      return { success: true, data: activation };
    } catch (e) {
      this.logger.error(`Failed to activate order ${orderNo}: ${e.message}`);
      // Order is paid but activation failed - mark as processing for manual review
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'PROCESSING' },
      });
      return { success: false, message: `Payment received but activation failed: ${e.message}`, orderId: order.id };
    }
  }

  private payWithBalance(order: any) {
    return this.orderService.payWithBalance(order.userId, order.id);
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

  // --- Misc helpers ---

  private getClientIp(): string {
    return '127.0.0.1';
  }

  private getAppUrl(): string {
    return this.configService.get('APP_URL') || 'http://localhost:3001';
  }
}
