import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CouponService } from './coupon.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Coupons')
@Controller('coupons')
export class CouponController {
  constructor(private couponService: CouponService) {}

  // 用户侧：输入优惠券码实时校验（不占名额），返回优惠金额与实付金额
  @Post('validate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate a coupon against a plan price' })
  async validate(@Body() body: { code: string; price: number }) {
    const result = await this.couponService.validate(body.code, { price: body.price });
    return { success: true, data: result };
  }

  // ==========================================
  // Admin CRUD
  // ==========================================

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create a coupon' })
  async create(@Body() body: any) {
    const result = await this.couponService.createCoupon(body);
    return { success: true, data: result };
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List coupons' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.couponService.findAll(page, limit, status, search);
    return { success: true, data: result };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update a coupon (limits/status/window)' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.couponService.update(id, body);
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Coupon statistics' })
  async getStats() {
    const result = await this.couponService.getStats();
    return { success: true, data: result };
  }
}