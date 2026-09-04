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
      relaySocksHost?: string;
      relaySocksPort?: number;
      relaySocksUser?: string;
      relaySocksPass?: string;
    },
  ) {
    const result = await this.orderService.createOrder({
      userId,
      planId: body.planId,
      payMethod: body.payMethod,
      serverId: body.serverId,
      protocol: body.protocol,
      relay: body.relay,
      relaySocksHost: body.relaySocksHost,
      relaySocksPort: body.relaySocksPort,
      relaySocksUser: body.relaySocksUser,
      relaySocksPass: body.relaySocksPass,
    });
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

  // After payment (balance/gateway) is confirmed, activate the node
  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate order and create node' })
  async activate(@Param('id', ParseIntPipe) id: number) {
    const result = await this.orderService.activateOrder(id);
    return { success: true, data: result };
  }

  @Get('mine')
  @ApiOperation({ summary: 'Get my orders' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.orderService.getUserOrders(userId, page || 1, limit || 20);
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
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.orderService.findAll(
      page || 1,
      limit || 20,
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
