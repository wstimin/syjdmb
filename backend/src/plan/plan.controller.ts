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
import { PlanService } from './plan.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Plans')
@Controller('plans')
export class PlanController {
  constructor(private planService: PlanService) {}

  // Public: get active plans
  @Get()
  @ApiOperation({ summary: 'Get active plans (public)' })
  async findActive() {
    const result = await this.planService.findActive();
    return { success: true, data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get plan details' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const result = await this.planService.findById(id);
    return { success: true, data: result };
  }

  // Admin endpoints
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all plans' })
  async findAll() {
    const result = await this.planService.findAll(true);
    return { success: true, data: result };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create plan' })
  async create(@Body() body: any) {
    const result = await this.planService.create(body);
    return { success: true, data: result };
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update plan' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.planService.update(id, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete plan' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.planService.remove(id);
    return { success: true, message: 'Plan deleted' };
  }

  @Get('admin/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Plan statistics' })
  async getStats() {
    const result = await this.planService.getStats();
    return { success: true, data: result };
  }
}
