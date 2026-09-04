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
import { AnnouncementService } from './announcement.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Announcements')
@Controller('announcements')
export class AnnouncementController {
  constructor(private announcementService: AnnouncementService) {}

  // Public
  @Get('active')
  @ApiOperation({ summary: 'Get active announcements' })
  async getActive(@Query('lang') lang?: string) {
    const result = await this.announcementService.findAllActive(lang || 'zh');
    return { success: true, data: result };
  }

  // Admin
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List announcements' })
  async findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    const result = await this.announcementService.findAll(page || 1, limit || 20);
    return { success: true, data: result };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create announcement' })
  async create(@Body() body: any) {
    const result = await this.announcementService.create(body);
    return { success: true, data: result };
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update announcement' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.announcementService.update(id, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete announcement' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    const result = await this.announcementService.remove(id);
    return { success: true, data: result };
  }
}
