import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Users')
@Controller('users')
export class UserController {
  constructor(private userService: UserService) {}

  // ---- User endpoints ----
  @Put('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update own profile' })
  async updateProfile(
    @CurrentUser('id') userId: number,
    @Body() body: { username?: string; avatar?: string; language?: string },
  ) {
    const result = await this.userService.updateProfile(userId, body);
    return { success: true, data: result };
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password' })
  async changePassword(
    @CurrentUser('id') userId: number,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    await this.userService.changePassword(userId, body.oldPassword, body.newPassword);
    return { success: true, message: 'Password changed' };
  }

  // ---- Admin endpoints ----
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all users' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    const result = await this.userService.findAll(page || 1, limit || 20, search);
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] User statistics' })
  async getStats() {
    const result = await this.userService.getStats();
    return { success: true, data: result };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Get user by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const result = await this.userService.findById(id);
    return { success: true, data: result };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update user' })
  async updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    const result = await this.userService.adminUpdateUser(id, body);
    return { success: true, data: result };
  }

  @Post(':id/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Adjust user balance' })
  async adjustBalance(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { amount: number; description: string },
  ) {
    const result = await this.userService.adjustBalance(id, body.amount, body.description);
    return { success: true, data: result };
  }
}
