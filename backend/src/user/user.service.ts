import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async findAll(page = 1, limit = 20, search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          uuid: true,
          email: true,
          username: true,
          role: true,
          status: true,
          balance: true,
          language: true,
          referralCode: true,
          createdAt: true,
          _count: { select: { orders: true, inbounds: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        uuid: true,
        email: true,
        username: true,
        role: true,
        status: true,
        balance: true,
        balanceFrozen: true,
        avatar: true,
        language: true,
        referralCode: true,
        createdAt: true,
        _count: {
          select: {
            orders: { where: { status: 'COMPLETED' } },
            inbounds: true,
            referrals: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: number, data: { username?: string; avatar?: string; language?: string }) {
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        uuid: true,
        email: true,
        username: true,
        avatar: true,
        language: true,
      },
    });
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) throw new BadRequestException('Old password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });
    return { message: 'Password updated' };
  }

  async adminUpdateUser(userId: number, data: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (data.password) {
      data.password = await bcrypt.hash(data.password, 12);
    }

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        uuid: true,
        email: true,
        username: true,
        role: true,
        status: true,
        balance: true,
      },
    });
  }

  async adjustBalance(userId: number, amount: number, description: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const newBalance = Number(user.balance) + amount;
    if (newBalance < 0) throw new BadRequestException('Insufficient balance');

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      }),
      this.prisma.transaction.create({
        data: {
          userId,
          type: amount > 0 ? 'ADMIN_ADJUST' : 'PURCHASE',
          amount,
          balance: newBalance,
          description,
        },
      }),
    ]);

    return { balance: newBalance };
  }

  async getStats() {
    const [totalUsers, activeUsers, newToday, newThisMonth] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
        },
      }),
    ]);

    return { totalUsers, activeUsers, newToday, newThisMonth };
  }
}
