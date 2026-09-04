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
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private prisma: PrismaService,
    private serverService: ServerService,
  ) {}

  // ==========================================
  // Creation - автоматическое создание узла при покупке
  // ==========================================

  async createInbound(params: {
    userId: number;
    plan: any;
    serverId: number;
    protocol: string;
  }) {
    const { userId, plan, serverId, protocol } = params;

    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
    });
    if (!server) throw new NotFoundException('Server not found');

    // Generate unique user email for XUI
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const email = `${user.id}-${uuidv4().slice(0, 8)}@node`;

    const uuid = uuidv4();

    // Calculate expiry time
    let expiryTime = 0;
    if (plan.duration > 0) {
      expiryTime = Date.now() + plan.duration * 24 * 3600 * 1000;
    }

    // Traffic limit in GB (convert bytes to GB for XUI)
    const totalGB = plan.traffic > 0 ? Number(plan.traffic) / 1024 / 1024 / 1024 : 0;

    // Build client object
    const client = {
      id: uuid,
      email,
      limitIp: plan.deviceLimit || 0,
      totalGB: Number(totalGB.toFixed(2)),
      expiryTime,
      enable: true,
      tgId: '',
      subId: email.replace(/@node$/, ''),
      reset: 0,
    };

    // Build protocol-specific settings
    let settings: string;
    switch (protocol.toLowerCase()) {
      case 'vmess': {
        settings = JSON.stringify({
          clients: [client],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'vless': {
        settings = JSON.stringify({
          clients: [{ ...client, flow: '' }],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'trojan': {
        settings = JSON.stringify({
          clients: [{ ...client, password: uuid }],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'shadowsocks': {
        settings = JSON.stringify({
          clients: [{ ...client, method: 'aes-256-gcm', password: uuid }],
          decryption: 'none',
        });
        break;
      }
      default:
        throw new BadRequestException(`Unsupported protocol: ${protocol}`);
    }

    // Build stream settings (WebSocket + TLS)
    const streamSettings = JSON.stringify({
      network: 'ws',
      security: 'tls',
      externalProxy: [],
      tlsSettings: {
        certificates: [
          {
            certificateFile: '/etc/letsencrypt/live/example.com/fullchain.pem',
            keyFile: '/etc/letsencrypt/live/example.com/privkey.pem',
          },
        ],
        minVersion: '1.2',
        alpn: ['http/1.1'],
        sni: '',
      },
      tcpSettings: { header: { type: 'none' } },
      wsSettings: {
        path: `/${uuid.slice(0, 8)}-${Date.now().toString(36)}`,
        headers: {},
      },
    });

    // Port allocation
    const port = await this.getAvailablePort(serverId);

    const inboundData = {
      up: 0,
      down: 0,
      total: parseInt(plan.traffic.toString()) || 0,
      remark: `user-${user.id}-${protocol}`,
      enable: true,
      expiryTime,
      listen: '',
      port,
      protocol: protocol.toLowerCase().toUpperCase(),
      settings,
      streamSettings,
      tag: `inbound-${port}`,
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        metadataOnly: false,
        routeOnly: false,
      },
    };

    try {
      // Call XUI API to add inbound
      const response = await this.serverService.addInbound(serverId, inboundData);

      const xuiInboundId = this.extractInboundId(response);

      // Save to database
      const inbound = await this.prisma.inbound.create({
        data: {
          userId,
          serverId,
          inboundId: xuiInboundId,
          protocol: protocol.toLowerCase(),
          port,
          email,
          settings,
          streamSettings,
          trafficLimit: plan.traffic,
          expiryTime: plan.duration > 0 ? new Date(expiryTime) : null,
          speedLimit: plan.speedLimit,
          remark: `Order ${inboundData.remark}`,
        },
      });

      this.logger.log(`Inbound created: ${email} port=${port} on server ${server.name}`);
      return inbound;
    } catch (error) {
      this.logger.error(`Failed to create inbound: ${error.message}`);
      throw new BadRequestException(`Failed to create inbound: ${error.message}`);
    }
  }

  private async getAvailablePort(serverId: number): Promise<number> {
    // Get existing inbounds from XUI
    try {
      const response = await this.serverService.getInbounds(serverId);
      const inbounds = response?.obj || [];
      const usedPorts = new Set(inbounds.map((i: any) => i.port));

      // Find first available port in range 10000-65535
      for (let port = 10000 + Math.floor(Math.random() * 20000); port <= 60000; port++) {
        if (!usedPorts.has(port)) return port;
      }
    } catch (e) {
      this.logger.warn(`Could not fetch inbounds: ${e.message}`);
    }
    return 10000 + Math.floor(Math.random() * 50000);
  }

  private extractInboundId(response: any): number {
    // Handle different response formats
    if (response?.obj && typeof response.obj === 'number') return response.obj;
    if (response?.obj?.id) return response.obj.id;
    if (response?.id) return response.id;
    // Default: query the newest inbound
    return 0;
  }

  // ==========================================
  // Link Generation
  // ==========================================

  generateConnectionLink(inbound: any, server: any): { url: string; qrData: string; settings: any } {
    const decodedSettings = JSON.parse(inbound.settings || '{}');
    const streamSettings = JSON.parse(inbound.streamSettings || '{}');
    const wsPath = streamSettings?.wsSettings?.path || '/';
    const client = decodedSettings?.clients?.[0];

    const host = server.host;
    const port = inbound.port;
    const uuid = client?.id || client?.password || '';

    let url = '';
    let qrData = '';

    switch (inbound.protocol) {
      case 'vmess': {
        const vmessConfig = {
          v: '2',
          ps: `${server.name}-${inbound.remark || ''}`,
          add: host,
          port: String(port),
          id: uuid,
          aid: '0',
          scy: 'auto',
          net: 'ws',
          type: 'none',
          host: '',
          path: wsPath,
          tls: 'tls',
          sni: '',
        };
        url = `vmess://${Buffer.from(JSON.stringify(vmessConfig)).toString('base64')}`;
        break;
      }
      case 'vless': {
        const params = new URLSearchParams({
          type: 'ws',
          security: 'tls',
          path: wsPath,
          host: '',
          'encryption': 'none',
        });
        url = `vless://${uuid}@${host}:${port}?${params.toString()}#${server.name}-vless`;
        break;
      }
      case 'trojan': {
        const params = new URLSearchParams({
          type: 'ws',
          security: 'tls',
          path: wsPath,
          host: '',
        });
        url = `trojan://${uuid}@${host}:${port}?${params.toString()}#${server.name}-trojan`;
        break;
      }
      case 'shadowsocks': {
        const method = client?.method || 'aes-256-gcm';
        const password = client?.password || uuid;
        const ssData = `${method}:${password}@${host}:${port}`;
        // Append fragment with path for SIP002 with ws
        url = `ss://${Buffer.from(ssData).toString('base64')}#${server.name}-ss`;
        break;
      }
      default:
        throw new BadRequestException(`Unsupported protocol for link: ${inbound.protocol}`);
    }

    qrData = url;

    return {
      url,
      qrData,
      settings: decodedSettings,
    };
  }

  // ==========================================
  // Retrieval
  // ==========================================

  async getUserInbounds(userId: number) {
    const inbounds = await this.prisma.inbound.findMany({
      where: { userId, status: { not: 'DELETED' } },
      include: { server: true },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with connection links
    return inbounds.map((inbound) => {
      try {
        const link = this.generateConnectionLink(inbound, inbound.server);
        // Fetch traffic from XUI
        return {
          ...inbound,
          connectionUrl: link.url,
          qrData: link.qrData,
          trafficUsed: Number(inbound.totalTraffic),
        };
      } catch (e) {
        return inbound;
      }
    });
  }

  async findById(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const inbound = await this.prisma.inbound.findFirst({
      where,
      include: { server: true },
    });
    if (!inbound) throw new NotFoundException('Inbound not found');

    const link = this.generateConnectionLink(inbound, inbound.server);

    return {
      ...inbound,
      connectionUrl: link.url,
      qrData: link.qrData,
    };
  }

  async updateTraffic() {
    // Fetch traffic for all active inbounds
    const inbounds = await this.prisma.inbound.findMany({
      where: { status: 'ACTIVE' },
      include: { server: true },
    });

    for (const inbound of inbounds) {
      try {
        const traffic = await this.serverService.getClientTraffic(
          inbound.serverId,
          inbound.email,
        );
        const up = traffic?.obj?.up || 0;
        const down = traffic?.obj?.down || 0;
        const total = up + down;

        // Check if traffic limit exceeded
        const limit = Number(inbound.trafficLimit);
        if (limit > 0 && total >= limit) {
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: {
              totalTraffic: BigInt(total),
              status: 'EXPIRED',
            },
          });
        } else {
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: { totalTraffic: BigInt(total) },
          });
        }
      } catch (e) {
        this.logger.debug(`Failed to update traffic for ${inbound.email}: ${e.message}`);
      }
    }
  }

  // ==========================================
  // Admin Management
  // ==========================================

  async findAll(page = 1, limit = 20, search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { remark: { contains: search } },
      ];
    }

    const [inbounds, total] = await Promise.all([
      this.prisma.inbound.findMany({
        where,
        include: {
          user: { select: { email: true, username: true } },
          server: { select: { name: true, host: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.inbound.count({ where }),
    ]);

    return { inbounds, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async suspend(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    // Suspend in XUI — 3-x-ui v3.6.0 中客户端以 email 为唯一标识
    try {
      await this.serverService.updateClient(
        inbound.serverId,
        inbound.email,
        { enable: false },
      );
    } catch (e) {
      this.logger.warn(`Failed to suspend in XUI: ${e.message}`);
    }

    return this.prisma.inbound.update({
      where: { id },
      data: { status: 'SUSPENDED' },
    });
  }

  async resume(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    // Resume in XUI — 3-x-ui v3.6.0 中客户端以 email 为唯一标识
    try {
      await this.serverService.updateClient(
        inbound.serverId,
        inbound.email,
        { enable: true },
      );
    } catch (e) {
      this.logger.warn(`Failed to resume in XUI: ${e.message}`);
    }

    return this.prisma.inbound.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
  }

  async delete(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    try {
      await this.serverService.deleteInbound(inbound.serverId, inbound.inboundId);
    } catch (e) {
      this.logger.warn(`Failed to delete in XUI: ${e.message}`);
    }

    return this.prisma.inbound.update({
      where: { id },
      data: { status: 'DELETED' },
    });
  }

  async getStats() {
    const [total, active, totalTraffic] = await Promise.all([
      this.prisma.inbound.count(),
      this.prisma.inbound.count({ where: { status: 'ACTIVE' } }),
      this.prisma.inbound.aggregate({
        _sum: { totalTraffic: true },
      }),
    ]);

    return {
      total,
      active,
      suspended: total - active,
      totalTraffic: Number(totalTraffic._sum.totalTraffic || 0),
    };
  }
}
