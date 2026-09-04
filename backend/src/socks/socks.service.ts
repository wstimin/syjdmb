import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ServerService } from '../server/server.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class SocksService {
  private readonly logger = new Logger(SocksService.name);

  constructor(
    private prisma: PrismaService,
    private serverService: ServerService,
  ) {}

  // ==========================================
  // User: Add SOCKS proxy info
  // ==========================================

  /**
   * User submits their own SOCKS proxy, or requests one be created on a server.
   * If host+port supplied → store as user-supplied proxy.
   * If serverId supplied → auto-create SOCKS inbound on that server via XUI.
   */
  async addSocks(params: {
    userId: number;
    serverId?: number;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    remark?: string;
  }) {
    // Auto-create mode on a server
    if (params.serverId && !params.host) {
      const proxy = await this.createOnServer({
        userId: params.userId,
        serverId: params.serverId,
        username: params.username,
        password: params.password,
        remark: params.remark,
      });
      return proxy;
    }

    // User-supplied proxy
    if (!params.host || !params.port) {
      throw new BadRequestException('Either provide host/port or serverId');
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

  // Auto-create SOCKS inbound on a managed server
  private async createOnServer(params: {
    userId: number;
    serverId: number;
    username?: string;
    password?: string;
    remark?: string;
  }): Promise<any> {
    const server = await this.prisma.server.findUnique({
      where: { id: params.serverId },
    });
    if (!server) throw new NotFoundException('Server not found');

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
    });
    if (!user) throw new NotFoundException('User not found');

    // Build SOCKS inbound for XUI
    const port = 10800 + Math.floor(Math.random() * 5000);
    const socUser = params.username || `socks-${user.id}`;
    const socPass = params.password || uuidv4().slice(0, 16);

    const inboundData = {
      up: 0,
      down: 0,
      total: 0,
      remark: `socks-${user.id}-${socUser}`,
      enable: true,
      expiryTime: 0,
      listen: '',
      port,
      protocol: 'SOCKS',
      settings: JSON.stringify({
        auth: 'password',
        accounts: [
          {
            user: socUser,
            pass: socPass,
          },
        ],
        udp: true,
        ip: '',
        userLevel: 0,
      }),
      streamSettings: JSON.stringify({
        network: 'tcp',
        security: 'none',
        tcpSettings: { header: { type: 'none' } },
      }),
      tag: `socks-${port}`,
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        metadataOnly: false,
        routeOnly: false,
      },
    };

    let inboundId: number;
    try {
      const response = await this.serverService.addInbound(params.serverId, inboundData);
      inboundId = response?.obj || response?.id || 0;
    } catch (e) {
      this.logger.error(`Failed to create SOCKS inbound: ${e.message}`);
      throw new BadRequestException(`Failed to create SOCKS on server: ${e.message}`);
    }

    return this.prisma.socksProxy.create({
      data: {
        userId: params.userId,
        serverId: params.serverId,
        inboundId,
        host: server.host,
        port,
        username: socUser,
        password: socPass,
        protocol: 'socks',
        remark: params.remark || `SOCKS on ${server.name}`,
        status: 'ACTIVE',
      },
    });
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

    // Try to remove from XUI if it was auto-created
    if (proxy.serverId && proxy.inboundId) {
      try {
        await this.serverService.deleteInbound(proxy.serverId, proxy.inboundId);
      } catch (e) {
        this.logger.warn(`Failed to delete SOCKS inbound in XUI: ${e.message}`);
      }
    }

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
