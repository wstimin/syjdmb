import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InboundService } from './inbound.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Inbounds')
@Controller('inbounds')
export class InboundController {
  constructor(private inboundService: InboundService) {}

  // User: get own nodes
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my nodes' })
  async getMyInbounds(@CurrentUser('id') userId: number) {
    const result = await this.inboundService.getUserInbounds(userId);
    return { success: true, data: result };
  }

  @Get('mine/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my node by ID' })
  async getMyInbound(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.inboundService.findById(id, userId);
    return { success: true, data: result };
  }

  // 用户给自己的【已有节点】后期挂载/卸载 SOCKS 中转（写入该节点出站 + 路由）
  @Post('mine/:id/relay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mount SOCKS relay onto my node (later attach)' })
  async attachRelay(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { socksId: number },
  ) {
    const result = await this.inboundService.attachRelay(userId, id, body.socksId);
    return { success: true, data: result };
  }

  @Delete('mine/:id/relay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unmount SOCKS relay from my node' })
  async detachRelay(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.inboundService.detachRelay(userId, id);
    return { success: true, data: result };
  }

  // 用户实时流量
  @Get('mine/:id/traffic')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my node realtime traffic' })
  async getMyTraffic(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.inboundService.getMyTraffic(userId, id);
    return { success: true, data: result };
  }

  // Admin
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all inbounds' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    const result = await this.inboundService.findAll(page || 1, limit || 20, search);
    return { success: true, data: result };
  }

  @Post(':id/suspend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Suspend inbound' })
  async suspend(@Param('id', ParseIntPipe) id: number) {
    const result = await this.inboundService.suspend(id);
    return { success: true, data: result };
  }

  @Post(':id/resume')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Resume inbound' })
  async resume(@Param('id', ParseIntPipe) id: number) {
    const result = await this.inboundService.resume(id);
    return { success: true, data: result };
  }

  @Post(':id/relay')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Manually bind a SOCKS proxy to an inbound (中转)' })
  async adminAttachRelay(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { socksId: number },
  ) {
    const result = await this.inboundService.adminAttachRelay(id, body.socksId);
    return { success: true, data: result };
  }

  @Delete(':id/relay')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Unmount SOCKS relay from an inbound' })
  async adminDetachRelay(@Param('id', ParseIntPipe) id: number) {
    const result = await this.inboundService.adminDetachRelay(id);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete inbound (彻底删除)' })
  async delete(@Param('id', ParseIntPipe) id: number) {
    const result = await this.inboundService.delete(id);
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Inbound statistics' })
  async getStats() {
    const result = await this.inboundService.getStats();
    return { success: true, data: result };
  }
}
