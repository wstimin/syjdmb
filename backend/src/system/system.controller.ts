import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SystemService } from './system.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('System')
@Controller('system')
export class SystemController {
  constructor(private systemService: SystemService) {}

  @Get('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Get system settings' })
  async getSettings(@Query('group') group?: string) {
    const result = await this.systemService.getSettings(group);
    return { success: true, data: result };
  }

  @Post('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update system settings' })
  async setSettings(
    @Body() body: { key: string; value: any; type?: string; group?: string; remark?: string }[],
  ) {
    const result = await this.systemService.setSettings(body);
    return { success: true, data: result };
  }

  @Get('finance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Financial overview' })
  async getFinance() {
    const result = await this.systemService.getFinanceOverview();
    return { success: true, data: result };
  }
}
