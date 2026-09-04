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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
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

  // Payment gateway callback
  @Post('callback/wechat')
  @HttpCode(200)
  @ApiOperation({ summary: 'WeChat Pay callback' })
  async wechatCallback(@Req() req: any, @Res() res: any) {
    // Parse and verify WeChat notification
    const body = req.body;
    // In production, verify the WeChat signature here
    const result = await this.paymentService.handlePaymentSuccess({
      orderNo: body.out_trade_no || body.orderNo,
      tradeNo: body.transaction_id || body.tradeNo,
      amount: body.total_fee ? Number(body.total_fee) / 100 : body.amount,
      payMethod: 'WECHAT',
    });
    // Return proper XML for WeChat
    res.set('Content-Type', 'application/xml');
    res.send(`<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>`);
  }

  @Post('callback/alipay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Alipay callback' })
  async alipayCallback(@Req() req: any, @Res() res: any) {
    const body = req.body;
    // In production, verify the Alipay signature here
    const result = await this.paymentService.handlePaymentSuccess({
      orderNo: body.out_trade_no || body.orderNo,
      tradeNo: body.trade_no || body.tradeNo,
      amount: body.total_amount || body.amount,
      payMethod: 'ALIPAY',
    });
    res.send('success');
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

  // Manual/admin payment verification
  @Post('verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify an offline payment' })
  async verifyPayment(
    @Body() body: { orderNo: string; tradeNo: string; amount: number; payMethod: string },
  ) {
    const result = await this.paymentService.handlePaymentSuccess({
      orderNo: body.orderNo,
      tradeNo: body.tradeNo,
      amount: body.amount,
      payMethod: body.payMethod,
    });
    return { success: true, data: result };
  }
}
