import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TicketService } from './ticket.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Tickets')
@Controller('tickets')
export class TicketController {
  constructor(private ticketService: TicketService) {}

  // ---- User ----
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a support ticket' })
  async create(
    @CurrentUser('id') userId: number,
    @Body() body: { subject: string; message: string; priority?: string },
  ) {
    const result = await this.ticketService.createTicket(userId, body);
    return { success: true, data: result };
  }

  @Post(':id/reply')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reply to my ticket' })
  async reply(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { message: string },
  ) {
    const result = await this.ticketService.reply(id, userId, body);
    return { success: true, data: result };
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my tickets' })
  async getMine(
    @CurrentUser('id') userId: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.ticketService.getMyTickets(userId, page || 1, limit || 20);
    return { success: true, data: result };
  }

  // ---- Admin ----
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] List all tickets' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.ticketService.findAll(page || 1, limit || 20, status, search);
    return { success: true, data: result };
  }

  @Post(':id/admin-reply')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Reply to a ticket' })
  async adminReply(@Param('id', ParseIntPipe) id: number, @Body() body: { message: string }) {
    const result = await this.ticketService.adminReply(id, body);
    return { success: true, data: result };
  }

  @Post(':id/close')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Close a ticket' })
  async close(@Param('id', ParseIntPipe) id: number) {
    const result = await this.ticketService.close(id);
    return { success: true, data: result };
  }

  @Post(':id/reopen')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Reopen a ticket' })
  async reopen(@Param('id', ParseIntPipe) id: number) {
    const result = await this.ticketService.reopen(id);
    return { success: true, data: result };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Ticket statistics' })
  async getStats() {
    const result = await this.ticketService.getStats();
    return { success: true, data: result };
  }
}
