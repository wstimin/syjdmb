import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

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
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  async updateProfile(userId: number, data: any) {
    // 严格白名单：登录后的用户只允许修改这三个字段。
    // 之前把整个请求体直接透传给 prisma.update，等于允许任何用户把自己改成 ADMIN/改余额（提权漏洞）。
    const allowed: Record<string, string> = {};
    if (typeof data.username === 'string' && data.username.trim()) {
      allowed.username = data.username.trim().slice(0, 30);
    }
    if (typeof data.avatar === 'string') {
      allowed.avatar = data.avatar.slice(0, 500);
    }
    if (typeof data.language === 'string') {
      allowed.language = data.language.slice(0, 10);
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: allowed,
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
    if (!user) throw new NotFoundException('用户不存在');

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) throw new BadRequestException('旧密码错误');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });
    return { message: 'Password updated' };
  }

  async adminUpdateUser(userId: number, data: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

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

  /**
   * 管理员手动创建用户（后台建号，绕过注册限流/邀请码）。
   * 邮箱小写归一；bcrypt(12) 加密；referralCode 短码；初始余额复用 adjustBalance 记 ADMIN_ADJUST 流水。
   */
  async createUser(dto: {
    email?: string;
    password?: string;
    username?: string;
    role?: string;
    status?: string;
    initialBalance?: number;
  }) {
    const email = String(dto.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('请填写正确的邮箱');
    }
    const password = String(dto.password || '');
    if (password.length < 6) {
      throw new BadRequestException('密码至少 6 位');
    }

    const role = dto.role ? String(dto.role).toUpperCase() : 'USER';
    if (!['USER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw new BadRequestException('角色必须是 USER / ADMIN / SUPER_ADMIN');
    }
    const status = dto.status ? String(dto.status).toUpperCase() : 'ACTIVE';
    if (!['ACTIVE', 'BANNED', 'SUSPENDED'].includes(status)) {
      throw new BadRequestException('状态必须是 ACTIVE / BANNED / SUSPENDED');
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('该邮箱已注册');

    const referralCode = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
    const username = dto.username && String(dto.username).trim() ? String(dto.username).trim() : email.split('@')[0];
    const user = await this.prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(password, 12),
        username,
        role: role as any,
        status: status as any,
        referralCode,
      },
    });

    // 初始余额：复用调账逻辑（余额 + ADMIN_ADJUST 流水）
    const initialBalance = Number(dto.initialBalance || 0);
    let balance = Number(user.balance);
    if (initialBalance > 0) {
      try {
        const adjusted = await this.adjustBalance(user.id, initialBalance, '管理员创建账号初始余额');
        balance = adjusted.balance;
      } catch (e) {
        this.logger.warn(`初始余额入账失败 userId=${user.id}: ${(e as Error).message}`);
      }
    }

    return { ...user, balance, password: undefined };
  }

  async adjustBalance(userId: number, amount: number, description: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const newBalance = Number(user.balance) + amount;
    if (newBalance < 0) throw new BadRequestException('余额不足');

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      }),
      this.prisma.transaction.create({
        data: {
          userId,
          // 正负都记 ADMIN_ADJUST（金额带符号）：扣费/退款不是「购买套餐」，
          // 用户端展示为「人工调整」，流水统计不把它当消费或收入
          type: 'ADMIN_ADJUST',
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
