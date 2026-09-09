import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { VirtualProductService } from './virtual-product.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Virtual Products')
@Controller('virtual-products')
export class VirtualProductController {
  constructor(private productService: VirtualProductService) {}

  // ---- Public：商城展示 ----
  @Get()
  @ApiOperation({ summary: 'Get active virtual products (public)' })
  async findActive() {
    const result = await this.productService.findActive();
    return { success: true, data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get virtual product detail (public)' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const result = await this.productService.findById(id);
    return { success: true, data: result };
  }

  // ---- Admin：商品 CRUD ----
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all virtual products' })
  async findAllAdmin() {
    const result = await this.productService.findAllAdmin();
    return { success: true, data: result };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create virtual product' })
  async create(@Body() body: any) {
    const result = await this.productService.create(body);
    return { success: true, data: result };
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update virtual product' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const result = await this.productService.update(id, body);
    return { success: true, data: result };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete virtual product' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.productService.remove(id);
    return { success: true, message: 'Virtual product deleted' };
  }

  // ---- Admin：交付码库（AUTO 商品） ----
  @Get(':id/keys')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List product keys' })
  async listKeys(
    @Param('id', ParseIntPipe) id: number,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = Math.max(1, parseInt(page || '', 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit || '', 10) || 50));
    const result = await this.productService.listKeys(id, status, p, l);
    return { success: true, data: result };
  }

  @Post(':id/keys')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Batch add product keys' })
  async addKeys(@Param('id', ParseIntPipe) id: number, @Body() body: { text?: string }) {
    const result = await this.productService.addKeys(id, body?.text || '');
    return { success: true, data: result };
  }

  @Delete('keys/:keyId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Delete an unused product key' })
  async removeKey(@Param('keyId', ParseIntPipe) keyId: number) {
    await this.productService.removeKey(keyId);
    return { success: true, message: 'Product key deleted' };
  }
}