import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  Req,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private paymentService: PaymentService) {}

  // Create a payment for an order
  @Post('orders/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create payment for order' })
  async createPayment(
    @CurrentUser('id') userId: number,
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: { method: string },
  ) {
    const result = await this.paymentService.createPayment(orderId, userId, body.method);
    return { success: true, data: result };
  }

  // Card key redemption
  @Post('card/redeem')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Redeem card key (卡密兑换)' })
  async redeemCard(
    @CurrentUser('id') userId: number,
    @Body() body: { code: string },
  ) {
    const result = await this.paymentService.redeemCard(userId, body.code);
    return { success: true, data: result };
  }

  // ==========================================
  // 网关回调：必须验签，验签失败直接拒绝（网关会稍后重试，不会丢失订单）
  // ==========================================

  @Post('callback/wechat')
  @HttpCode(200)
  @ApiOperation({ summary: 'WeChat Pay callback (signed)' })
  async wechatCallback(@Req() req: any, @Res() res: any) {
    try {
      // 微信通知是 XML，main.ts 已配置 text/xml 解析器 → req.body 是原始 XML 字符串
      const rawXml = typeof req.body === 'string' ? req.body : '';
      const params = await this.paymentService.parseWechatCallback(rawXml);
      // 按订单号前缀分流：RC 开头走余额直充入账，其余走商品单激活
      await this.paymentService.settleGatewayCallback({
        orderNo: params.out_trade_no,
        tradeNo: params.transaction_id,
        amount: Number(params.total_fee) / 100,
        payMethod: 'WECHAT',
      });
      res.set('Content-Type', 'application/xml');
      res.send(`<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>`);
    } catch (e: any) {
      this.logger.warn(`微信回调处理失败: ${e.message}`);
      // 返回 FAIL 而不是 500：微信会按规范重试。
      // 注意：不把服务端错误信息回显给调用方（防信息泄露），统一固定文案。
      res.set('Content-Type', 'application/xml');
      res.send(`<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[HANDLE_FAILED]]></return_msg></xml>`);
    }
  }

  @Post('callback/alipay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Alipay callback (signed)' })
  async alipayCallback(@Req() req: any, @Res() res: any) {
    try {
      const params = await this.paymentService.parseAlipayCallback(req.body || {});
      await this.paymentService.settleGatewayCallback({
        orderNo: params.out_trade_no,
        tradeNo: params.trade_no,
        amount: Number(params.total_amount),
        payMethod: 'ALIPAY',
      });
      res.send('success');
    } catch (e: any) {
      this.logger.warn(`支付宝回调处理失败: ${e.message}`);
      // 返回非 success：支付宝会按规范重试
      res.send('fail');
    }
  }

  // Payment order status (polled by the frontend after a real gateway payment)
  @Get('status/:orderNo')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment/order status for polling' })
  async paymentStatus(
    @CurrentUser('id') userId: number,
    @Param('orderNo') orderNo: string,
  ) {
    const result = await this.paymentService.getOrderStatus(orderNo, userId);
    return { success: true, data: result };
  }

  // 线下/人工收款确认 —— 仅管理员可用。
  // （此前只有登录校验，任何登录用户都能伪造"已付款"，已修复为管理员专属。）
  // 同样按订单号前缀分流：RC 开头 → 充值单人工确认入账；SO 开头 → 商品单人工确认激活
  @Post('verify')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Verify an offline payment' })
  async verifyPayment(
    @Body() body: { orderNo: string; tradeNo: string; amount: number; payMethod: string },
  ) {
    const result = await this.paymentService.settleGatewayCallback({
      orderNo: body.orderNo,
      tradeNo: body.tradeNo,
      amount: body.amount,
      payMethod: body.payMethod,
    });
    return { success: true, data: result };
  }
}