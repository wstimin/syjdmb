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
import { RefundsService } from './refunds.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Refunds')
@Controller('refunds')
export class RefundsController {
  constructor(private refundsService: RefundsService) {}

  // 用户申请退款（校验 + 创建原子；防刷锁内限制 PENDING 数量）
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Apply for a refund (用户申请退款)' })
  async create(
    @CurrentUser('id') userId: number,
    @Body() body: { orderId?: number; reason?: string },
  ) {
    const result = await this.refundsService.create(userId, body.orderId, body.reason);
    return { success: true, data: result };
  }

  // 我的退款申请（含审批意见，用户能看到拒绝原因）
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My refund requests' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.refundsService.getMine(userId, p, l);
    return { success: true, data: result };
  }

  // 用户自行撤销 PENDING 申请（申请错了/改主意了，不用等管理员拒绝）
  @Post(':id/cancel-self')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdraw my own pending refund request' })
  async cancelSelf(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.refundsService.cancelSelf(userId, id);
    return { success: true, data: result };
  }

  // ==========================================
  // Admin
  // ==========================================

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List refund requests' })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.refundsService.findAll(p, l, status, search);
    return { success: true, data: result };
  }

  // 审批通过：单事务认领 + 入账 + 流水 + 券回收，提交后停节点
  @Post(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Approve a refund (退款入余额)' })
  async approve(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.refundsService.approve(id, adminId);
    return { success: true, data: result };
  }

  // 审批拒绝：必须填备注
  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Reject a refund (需填写审批意见)' })
  async reject(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note?: string },
  ) {
    const result = await this.refundsService.reject(id, adminId, body.note);
    return { success: true, data: result };
  }
}