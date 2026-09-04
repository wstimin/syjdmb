import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class SocksService {
  private readonly logger = new Logger(SocksService.name);

  constructor(private prisma: PrismaService) {}

  // ==========================================
  // User: Add user-supplied SOCKS proxy (台账)
  // ==========================================
  //
  // 注意：SOCKS「中转」已改为【购买时勾选】，在源节点上挂 SOCKS 出站+路由
  // （见 inbound.service.createInbound + server.service.ensureSocks*）。
  // 这里只保留「用户自填 SOCKS 服务器」作为账本记录，不再创建任何节点。

  async addSocks(params: {
    userId: number;
    host: string;
    port: number;
    username?: string;
    password?: string;
    remark?: string;
  }) {
    if (!params.host || !params.port) {
      throw new BadRequestException('Host and port are required');
    }

    const proxy = await this.prisma.socksProxy.create({
      data: {
        userId: params.userId,
        host: params.host,
        port: params.port,
        username: params.username || null,
        password: params.password || null,
        remark: params.remark || 'User SOCKS proxy',
        status: 'ACTIVE',
      },
    });

    return proxy;
  }

  // ==========================================
  // Queries
  // ==========================================

  async getMyProxies(userId: number) {
    const proxies = await this.prisma.socksProxy.findMany({
      where: { userId, status: { not: 'DELETED' } },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Build connection strings
    return proxies.map((p) => {
      let connection = `socks5://${p.host}:${p.port}`;
      if (p.username) {
        const auth = `${p.username}:${p.password || ''}@`;
        connection = `socks5://${auth}${p.host}:${p.port}`;
      }
      return { ...p, connectionString: connection };
    });
  }

  async findById(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const proxy = await this.prisma.socksProxy.findFirst({ where });
    if (!proxy) throw new NotFoundException('SOCKS proxy not found');
    return proxy;
  }

  async findAll(page = 1, limit = 20, search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { host: { contains: search } },
        { remark: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [proxies, total] = await Promise.all([
      this.prisma.socksProxy.findMany({
        where,
        include: {
          user: { select: { email: true, username: true } },
          server: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.socksProxy.count({ where }),
    ]);

    return { proxies, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // Management
  // ==========================================

  async update(id: number, userId: number, data: any) {
    const proxy = await this.prisma.socksProxy.findFirst({ where: { id, userId } });
    if (!proxy) throw new NotFoundException('SOCKS proxy not found');

    return this.prisma.socksProxy.update({
      where: { id },
      data: {
        host: data.host ?? proxy.host,
        port: data.port ?? proxy.port,
        username: data.username !== undefined ? data.username : proxy.username,
        password: data.password !== undefined ? data.password : proxy.password,
        remark: data.remark !== undefined ? data.remark : proxy.remark,
      },
    });
  }

  async delete(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const proxy = await this.prisma.socksProxy.findFirst({ where });
    if (!proxy) throw new NotFoundException('SOCKS proxy not found');

    return this.prisma.socksProxy.update({
      where: { id },
      data: { status: 'DELETED' },
    });
  }

  async changeStatus(id: number, status: 'ACTIVE' | 'INACTIVE') {
    const proxy = await this.prisma.socksProxy.findUnique({ where: { id } });
    if (!proxy) throw new NotFoundException('SOCKS proxy not found');
    return this.prisma.socksProxy.update({ where: { id }, data: { status } });
  }

  async getStats() {
    const [total, active] = await Promise.all([
      this.prisma.socksProxy.count(),
      this.prisma.socksProxy.count({ where: { status: 'ACTIVE' } }),
    ]);
    return { total, active, inactive: total - active };
  }
}
