import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class PlanService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeArchived = false) {
    const where: any = includeArchived
      ? {}
      : { status: { not: 'ARCHIVED' } };

    return this.prisma.plan.findMany({
      where,
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findActive() {
    return this.prisma.plan.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { price: 'asc' }],
    });
  }

  async findById(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async create(data: any) {
    return this.prisma.plan.create({ data });
  }

  async update(id: number, data: any) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return this.prisma.plan.update({ where: { id }, data });
  }

  async remove(id: number) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');

    const hasOrders = await this.prisma.order.count({
      where: { planId: id, status: { in: ['PAID', 'COMPLETED'] } },
    });
    if (hasOrders > 0) {
      throw new BadRequestException('Cannot delete plan with existing orders');
    }

    await this.prisma.plan.delete({ where: { id } });
    return { message: 'Plan deleted' };
  }

  async getStats() {
    const [totalPlans, activePlans, totalRevenue] = await Promise.all([
      this.prisma.plan.count(),
      this.prisma.plan.count({ where: { status: 'ACTIVE' } }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalPlans,
      activePlans,
      totalRevenue: totalRevenue._sum.amount || 0,
    };
  }
}
