import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class TicketService {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // User
  // ==========================================

  async createTicket(userId: number, data: { subject: string; message: string; priority?: string }) {
    if (!data.subject || !data.message) {
      throw new BadRequestException('Subject and message are required');
    }

    const ticket = await this.prisma.ticket.create({
      data: {
        userId,
        subject: data.subject,
        priority: (data.priority as any) || 'NORMAL',
        status: 'OPEN',
        messages: {
          create: {
            sender: 'user',
            content: data.message,
          },
        },
      },
      include: { messages: true },
    });

    return ticket;
  }

  async reply(ticketId: number, userId: number, data: { message: string }) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, userId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'CLOSED') throw new BadRequestException('Ticket is closed');

    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId,
        sender: 'user',
        content: data.message,
      },
    });

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'PENDING' },
    });

    return message;
  }

  async getMyTickets(userId: number, page = 1, limit = 20) {
    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticket.count({ where: { userId } }),
    ]);
    return { tickets, total, page, limit };
  }

  // ==========================================
  // Admin
  // ==========================================

  async findAll(page = 1, limit = 20, status?: string, search?: string) {
    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { subject: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, username: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return { tickets, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async adminReply(ticketId: number, data: { message: string }) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId,
        sender: 'admin',
        content: data.message,
      },
    });

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'REPLIED' },
    });

    return message;
  }

  async close(ticketId: number) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'CLOSED' },
    });
  }

  async reopen(ticketId: number) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'OPEN' },
    });
  }

  async getStats() {
    const [open, pending, replied, closed] = await Promise.all([
      this.prisma.ticket.count({ where: { status: 'OPEN' } }),
      this.prisma.ticket.count({ where: { status: 'PENDING' } }),
      this.prisma.ticket.count({ where: { status: 'REPLIED' } }),
      this.prisma.ticket.count({ where: { status: 'CLOSED' } }),
    ]);
    return { open, pending, replied, closed, total: open + pending + replied + closed };
  }
}
