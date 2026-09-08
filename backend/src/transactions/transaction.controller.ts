import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionService } from './transaction.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Transactions')
@Controller('transactions')
export class TransactionController {
  constructor(private transactionService: TransactionService) {}

  // 用户自己的余额流水（余额明细）
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My balance transactions' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // 分页参数防御：非法值（0/负数/非数字）钳制到合法范围，避免 skip 为负/NaN 造成 500
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.transactionService.getMine(userId, p, l);
    return { success: true, data: result };
  }

  // ==========================================
  // Admin
  // ==========================================

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all balance transactions' })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.transactionService.findAll(p, l, type, search);
    return { success: true, data: result };
  }

  // 流水统计（收入/支出/余额变动）
  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Transaction statistics' })
  async getStats() {
    const result = await this.transactionService.getStats();
    return { success: true, data: result };
  }
}