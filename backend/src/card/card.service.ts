import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CardService {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // Generate Cards (Admin)
  // ==========================================

  async generateCards(params: {
    amount: number;
    count: number;
    prefix?: string;
    batch?: string;
  }) {
    const { amount, count, prefix = '' } = params;
    if (count <= 0 || count > 1000) {
      throw new BadRequestException('Count must be between 1 and 1000');
    }
    if (amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    const batchId = params.batch || `B${Date.now().toString(36).toUpperCase()}`;
    const codes: string[] = [];
    const batchData: any[] = [];

    // Generate unique cards
    while (codes.length < count) {
      const code = this.generateCardCode(prefix);
      if (codes.includes(code)) continue;
      codes.push(code);
      batchData.push({ code, amount, status: 'UNUSED', batchId });
    }

    // Insert in bulk
    await this.prisma.card.createMany({ data: batchData });

    return {
      batchId,
      count,
      amount,
      codes,
    };
  }

  private generateCardCode(prefix: string): string {
    const random = uuidv4().replace(/-/g, '').toUpperCase().slice(0, 16);
    // Format: XXXX-XXXX-XXXX-XXXX
    const formatted = random.match(/.{1,4}/g)?.join('-') || random;
    return prefix ? `${prefix}-${formatted}` : formatted;
  }

  // ==========================================
  // Queries
  // ==========================================

  async findAll(params: {
    page?: number;
    limit?: number;
    status?: string;
    batchId?: string;
    search?: string;
  }) {
    const { page = 1, limit = 20, status, batchId, search } = params;
    const where: any = {};
    if (status) where.status = status;
    if (batchId) where.batchId = batchId;
    if (search) where.code = { contains: search, mode: 'insensitive' };

    const [cards, total] = await Promise.all([
      this.prisma.card.findMany({
        where,
        include: { user: { select: { email: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.card.count({ where }),
    ]);

    return { cards, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getStats() {
    const [total, unused, used, redeemedValue] = await Promise.all([
      this.prisma.card.count(),
      this.prisma.card.count({ where: { status: 'UNUSED' } }),
      this.prisma.card.count({ where: { status: 'USED' } }),
      this.prisma.card.aggregate({
        where: { status: 'USED' },
        _sum: { amount: true },
      }),
    ]);

    return {
      total,
      unused,
      used,
      cancelled: total - unused - used,
      redeemedValue: redeemedValue._sum.amount || 0,
    };
  }

  // ==========================================
  // Management
  // ==========================================

  async cancelCard(id: number) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('Card not found');
    if (card.status === 'USED') throw new BadRequestException('Cannot cancel a used card');

    return this.prisma.card.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  async cancelBatch(batchId: string) {
    const result = await this.prisma.card.updateMany({
      where: { batchId, status: 'UNUSED' },
      data: { status: 'CANCELLED' },
    });
    return { cancelled: result.count };
  }
}
