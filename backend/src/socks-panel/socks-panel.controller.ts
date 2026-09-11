import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SocksPanelService } from './socks-panel.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('SOCKS Panel')
@Controller('socks-panel')
export class SocksPanelController {
  constructor(private socksPanelService: SocksPanelService) {}

  // ---- User ----
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My delivered SOCKS nodes（「我的商品」页与虚拟商品合并展示）' })
  async mine(@CurrentUser('id') userId: number) {
    return { success: true, data: await this.socksPanelService.getMySocksNodes(userId) };
  }

  // 一键导入到 SOCKS 出站池（薄桥：把已购节点的 host/port/账号密码写入用户 SocksProxy 台账）
  @Post(':id/import-outbound')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Import a purchased SOCKS node into the user SOCKS outbound pool' })
  async importOutbound(@Param('id', ParseIntPipe) id: number, @CurrentUser('id') userId: number) {
    return { success: true, data: await this.socksPanelService.importAsOutbound(id, userId) };
  }

  // 用户修改自己的 SOCKS 节点（备注 / 用户名 / 密码）
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update own SOCKS node (remark / credentials)' })
  async updateUserNode(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('id') userId: number,
    @Body() body: { remark?: string; username?: string; password?: string },
  ) {
    return { success: true, data: await this.socksPanelService.userUpdateNode(id, userId, body) };
  }

  // ---- Admin ----
  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin list SOCKS panel nodes' })
  async adminList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.socksPanelService.adminList(
      Number(page) || 1,
      Number(limit) || 20,
      search,
    );
    return { success: true, data: result };
  }

  @Post('admin/:id/disable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable (suspend) a SOCKS node' })
  async disable(@Param('id', ParseIntPipe) id: number) {
    const result = await this.socksPanelService.adminDisable(id);
    return { success: true, data: result };
  }

  @Post('admin/:id/resume')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resume a suspended SOCKS node' })
  async resume(@Param('id', ParseIntPipe) id: number) {
    const result = await this.socksPanelService.adminResume(id);
    return { success: true, data: result };
  }

  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Permanently delete a SOCKS node' })
  async delete(@Param('id', ParseIntPipe) id: number) {
    const result = await this.socksPanelService.adminDelete(id);
    return { success: true, data: result };
  }

  @Post('admin/reconcile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Reconcile SOCKS product sold counts（对账修复历史遗留的已售数虚高）' })
  async reconcile() {
    const result = await this.socksPanelService.reconcileSocksQuota();
    return { success: true, data: result };
  }
}