import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ServerService } from './server.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Servers')
@Controller('servers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@ApiBearerAuth()
export class ServerController {
  constructor(private serverService: ServerService) {}

  @Get()
  @ApiOperation({ summary: 'List all servers' })
  async findAll() {
    const result = await this.serverService.findAll();
    return { success: true, data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get server details' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const result = await this.serverService.findById(id);
    return { success: true, data: result };
  }

  @Post()
  @ApiOperation({ summary: 'Add new server' })
  async create(@Body() body: any) {
    const result = await this.serverService.createPanel(body);
    return { success: true, data: result };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update server' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.serverService.update(id, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete server' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.serverService.remove(id);
    return { success: true, message: 'Server deleted' };
  }

  @Get(':id/inbounds')
  @ApiOperation({ summary: 'Get inbounds from XUI panel' })
  async getInbounds(@Param('id', ParseIntPipe) id: number) {
    const result = await this.serverService.getInbounds(id);
    return { success: true, data: result };
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Get server stats from XUI' })
  async getStats(@Param('id', ParseIntPipe) id: number) {
    const result = await this.serverService.getServerStats(id);
    return { success: true, data: result };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test server connection' })
  async testConnection(@Param('id', ParseIntPipe) id: number) {
    try {
      const session = await this.serverService.login(id);
      return { success: true, message: 'Connection successful', sessionId: session.substring(0, 20) + '...' };
    } catch (e) {
      return { success: false, message: `Connection failed: ${e.message}` };
    }
  }
}
