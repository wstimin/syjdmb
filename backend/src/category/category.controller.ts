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
import { CategoryService } from './category.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Categories')
@Controller('categories')
export class CategoryController {
  constructor(private categoryService: CategoryService) {}

  // Public: 分类列表（商城筛选按钮用；?scope=PLAN|VIRTUAL 可选）
  @Get()
  @ApiOperation({ summary: 'List categories (public), optional ?scope=PLAN|VIRTUAL' })
  async findAll(@Query('scope') scope?: string) {
    const result = await this.categoryService.findAll(scope);
    return { success: true, data: result };
  }

  // Admin
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create category' })
  async create(@Body() body: any) {
    const result = await this.categoryService.create(body);
    return { success: true, data: result };
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update category' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.categoryService.update(id, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete category（绑定商品自动回未分类）' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    const result = await this.categoryService.remove(id);
    return { success: true, data: result };
  }
}