import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrderService } from './order.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class OrderController {
  constructor(private orderService: OrderService) {}

  // ---- User ----
  @Post()
  @ApiOperation({ summary: 'Create order to purchase a plan' })
  async create(
    @CurrentUser('id') userId: number,
    @Body() body: {
      planId: number;
      payMethod?: string;
      serverId?: number;
      protocol?: string;
      relay?: boolean;
      relaySocksId?: number;
      relaySocksHost?: string;
      relaySocksPort?: number;
      relaySocksUser?: string;
      relaySocksPass?: string;
      renewalOfInboundId?: number; // 续费单：对已有节点续期/续流量
      renewType?: 'EXPIRY' | 'TRAFFIC'; // 续费类型：EXPIRY=到期续费（未到期顺延/已到期宽限期内按原到期日开新周期）；TRAFFIC=流量续费（额度叠加）；不传=旧版叠加行为
      couponCode?: string;         // 优惠券码（实付按券后金额，amount 恒为原价）
    },
  ) {
    const result = await this.orderService.createOrder({
      userId,
      planId: body.planId,
      payMethod: body.payMethod,
      serverId: body.serverId,
      protocol: body.protocol,
      relay: body.relay,
      relaySocksId: body.relaySocksId,
      relaySocksHost: body.relaySocksHost,
      relaySocksPort: body.relaySocksPort,
      relaySocksUser: body.relaySocksUser,
      relaySocksPass: body.relaySocksPass,
      renewalOfInboundId: body.renewalOfInboundId,
      renewType: body.renewType,
      couponCode: body.couponCode,
    });
    return { success: true, data: result };
  }

  @Post(':id/cancel-self')
  @ApiOperation({ summary: 'Cancel my unpaid order' })
  async cancelSelf(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.orderService.cancelSelf(id, userId);
    return { success: true, data: result };
  }

  @Post(':id/pay/balance')
  @ApiOperation({ summary: 'Pay order with balance' })
  async payWithBalance(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.orderService.payWithBalance(userId, id);
    return { success: true, data: result };
  }

  // After payment (balance/gateway) is confirmed, activate the node（仅允许激活自己的订单）
  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate my order and create node' })
  async activate(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.orderService.activateOrder(id, userId);
    return { success: true, data: result };
  }

  @Get('mine')
  @ApiOperation({ summary: 'Get my orders' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // 分页参数钳制：负值/0/非数字落入合法范围，避免 OFFSET 为负导致数据库报错
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.orderService.getUserOrders(userId, p, l);
    return { success: true, data: result };
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'Get my order by ID' })
  async getMineById(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.orderService.findById(id, userId);
    return { success: true, data: result };
  }

  // ---- Admin ----
  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: '[Admin] List all orders' })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit || '', 10) || 20));
    const result = await this.orderService.findAll(
      p,
      l,
      status,
      search,
    );
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: '[Admin] Order statistics' })
  async getStats() {
    const result = await this.orderService.getStats();
    return { success: true, data: result };
  }

  @Post(':id/admin-activate')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: '[Admin] Manually activate order' })
  async adminActivate(@Param('id', ParseIntPipe) id: number) {
    const result = await this.orderService.adminActivate(id);
    return { success: true, data: result };
  }

  @Post(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: '[Admin] Cancel order' })
  async cancel(@Param('id', ParseIntPipe) id: number) {
    const result = await this.orderService.cancel(id);
    return { success: true, data: result };
  }
}
