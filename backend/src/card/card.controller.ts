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
import { CardService } from './card.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Card Keys')
@Controller('cards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@ApiBearerAuth()
export class CardController {
  constructor(private cardService: CardService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generate card keys' })
  async generate(@Body() body: { amount: number; count: number; prefix?: string; batch?: string }) {
    const result = await this.cardService.generateCards(body);
    return { success: true, data: result };
  }

  @Get()
  @ApiOperation({ summary: 'List card keys' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('batchId') batchId?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.cardService.findAll({ page, limit, status, batchId, search });
    return { success: true, data: result };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Card statistics' })
  async getStats() {
    const result = await this.cardService.getStats();
    return { success: true, data: result };
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a card key' })
  async cancel(@Param('id', ParseIntPipe) id: number) {
    const result = await this.cardService.cancelCard(id);
    return { success: true, data: result };
  }

  @Post('batch/:batchId/cancel')
  @ApiOperation({ summary: 'Cancel a whole batch' })
  async cancelBatch(@Param('batchId') batchId: string) {
    const result = await this.cardService.cancelBatch(batchId);
    return { success: true, data: result };
  }
}
