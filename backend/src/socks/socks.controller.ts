import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SocksService } from './socks.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('SOCKS Proxies')
@Controller('socks')
export class SocksController {
  constructor(private socksService: SocksService) {}

  // ---- User ----
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add user-supplied SOCKS proxy (台账记录)' })
  async create(
    @CurrentUser('id') userId: number,
    @Body() body: {
      host: string;
      port: number;
      username?: string;
      password?: string;
      remark?: string;
    },
  ) {
    const result = await this.socksService.addSocks({
      userId,
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
      remark: body.remark,
    });
    return { success: true, data: result };
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my SOCKS proxies' })
  async getMine(@CurrentUser('id') userId: number) {
    const result = await this.socksService.getMyProxies(userId);
    return { success: true, data: result };
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update my SOCKS proxy' })
  async update(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    const result = await this.socksService.update(id, userId, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete my SOCKS proxy' })
  async delete(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const result = await this.socksService.delete(id, userId);
    return { success: true, data: result };
  }

  // ---- Admin ----
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all SOCKS proxies' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    const result = await this.socksService.findAll(page || 1, limit || 20, search);
    return { success: true, data: result };
  }

  @Post(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Change proxy status' })
  async changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'ACTIVE' | 'INACTIVE' },
  ) {
    const result = await this.socksService.changeStatus(id, body.status);
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] SOCKS statistics' })
  async getStats() {
    const result = await this.socksService.getStats();
    return { success: true, data: result };
  }
}
