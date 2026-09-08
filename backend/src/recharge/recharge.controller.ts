import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RechargeService } from './recharge.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Recharges')
@Controller('recharges')
export class RechargeController {
  constructor(private rechargeService: RechargeService) {}

  // 创建余额直充单（1~50000 元），返回 RC 订单号
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a recharge (余额充值)' })
  async create(@CurrentUser('id') userId: number, @Body() body: { amount: number }) {
    const result = await this.rechargeService.create(userId, body.amount);
    return { success: true, data: result };
  }

  // 为直充单拉起网关支付（微信/支付宝），返回二维码内容
  @Post(':orderNo/payment')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create gateway payment for a recharge' })
  async createPayment(
    @CurrentUser('id') userId: number,
    @Param('orderNo') orderNo: string,
    @Body() body: { method: string },
  ) {
    const result = await this.rechargeService.createPayment(userId, orderNo, body.method);
    return { success: true, data: result };
  }

  // 前端轮询充值状态（RC 单不入 Order，走独立状态接口）
  @Get('status/:orderNo')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recharge status for polling' })
  async getStatus(
    @CurrentUser('id') userId: number,
    @Param('orderNo') orderNo: string,
  ) {
    const result = await this.rechargeService.getStatus(userId, orderNo);
    return { success: true, data: result };
  }

  // 我的充值记录
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My recharge history' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.rechargeService.getMine(userId, p, l);
    return { success: true, data: result };
  }

  // 取消直充单
  @Post(':orderNo/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a recharge (only before payment is initiated)' })
  async cancel(
    @CurrentUser('id') userId: number,
    @Param('orderNo') orderNo: string,
  ) {
    const result = await this.rechargeService.cancel(userId, orderNo);
    return { success: true, data: result };
  }

  // ==========================================
  // Admin
  // ==========================================

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List recharge orders' })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.rechargeService.findAll(p, l, status, search);
    return { success: true, data: result };
  }
}