import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

interface XuiPanel {
  name: string;
  url: string;
  username: string;
  password: string;
}

@Injectable()
export class ServerService {
  private readonly logger = new Logger(ServerService.name);
  private panels: XuiPanel[];

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.panels = JSON.parse(this.configService.get('XUI_PANELS') || '[]');
  }

  // ==========================================
  // Panel Configuration Management
  // ==========================================

  async createPanel(data: {
    name: string;
    host: string;
    port: number;
    username: string;
    password: string;
    remark?: string;
    country?: string;
    flag?: string;
    weight?: number;
    maxUsers?: number;
  }) {
    const server = await this.prisma.server.create({
      data: {
        name: data.name,
        host: data.host,
        port: data.port,
        username: data.username,
        password: data.password,
        remark: data.remark,
        country: data.country || 'US',
        flag: data.flag,
        weight: data.weight || 1,
        maxUsers: data.maxUsers || 100,
      },
    });

    // Test connection
    try {
      await this.login(server.id);
      this.logger.log(`Server ${server.name} connected successfully`);
    } catch (e) {
      this.logger.warn(`Server ${server.name} connection failed: ${e.message}`);
    }

    return server;
  }

  async findAll() {
    const servers = await this.prisma.server.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { inbounds: true } },
      },
    });

    // Check cache for session status
    for (const server of servers) {
      const sessionKey = `xui:session:${server.id}`;
      server.sessionId = (await this.redis.get(sessionKey)) ? 'active' : null;
    }

    return servers;
  }

  async findById(id: number) {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: {
        inbounds: {
          select: { id: true, userId: true, protocol: true, status: true },
        },
      },
    });
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async update(id: number, data: any) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');

    return this.prisma.server.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');

    // Check if server has active inbounds
    const activeInbounds = await this.prisma.inbound.count({
      where: { serverId: id, status: 'ACTIVE' },
    });
    if (activeInbounds > 0) {
      throw new BadRequestException('Cannot delete server with active inbounds');
    }

    await this.prisma.server.delete({ where: { id } });
    return { message: 'Server deleted' };
  }

  // ==========================================
  // XUI Panel API Integration
  // ==========================================

  async login(serverId: number): Promise<string> {
    // Check cache first
    const sessionKey = `xui:session:${serverId}`;
    const cachedSession = await this.redis.get(sessionKey);
    if (cachedSession) return cachedSession;

    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    const loginUrl = `${server.protocol}://${server.host}:${server.port}/login`;
    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: server.username,
        password: server.password,
      }),
    });

    if (!response.ok) {
      throw new BadRequestException(`XUI login failed: ${response.statusText}`);
    }

    // Extract session cookie
    const cookies = response.headers.getSetCookie?.() || [];
    const sessionCookie = cookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('session=') || c.startsWith('3x-ui='));

    if (!sessionCookie) {
      // Try JSON response login (newer versions)
      const data = await response.json();
      if (data.success) {
        // For newer XUI versions that use token-based auth
        const token = data.msg || data.token;
        if (token) {
          await this.redis.set(sessionKey, token, 3600);
          return token;
        }
      }
      throw new BadRequestException('Failed to get XUI session');
    }

    const session = sessionCookie.split('=')[1];
    await this.redis.set(sessionKey, session, 3600);
    return session;
  }

  async xuiRequest(
    serverId: number,
    method: 'GET' | 'POST',
    path: string,
    body?: any,
  ): Promise<any> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    const session = await this.login(serverId);
    const baseUrl = `${server.protocol}://${server.host}:${server.port}`;
    const apiUrl = `${baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: `session=${session}`,
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(apiUrl, options);

    if (response.status === 401 || response.status === 403) {
      // Session expired, re-login
      await this.redis.del(`xui:session:${serverId}`);
      const newSession = await this.login(serverId);
      headers.Cookie = `session=${newSession}`;
      const retryResponse = await fetch(apiUrl, { ...options, headers });
      return retryResponse.json();
    }

    return response.json();
  }

  // ==========================================
  // Inbound Management via XUI API
  // ==========================================

  async getInbounds(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/panel/api/inbounds/list');
  }

  async getInbound(serverId: number, inboundId: number) {
    return this.xuiRequest(
      serverId,
      'GET',
      `/panel/api/inbounds/get/${inboundId}`,
    );
  }

  async addInbound(serverId: number, inboundData: any) {
    return this.xuiRequest(
      serverId,
      'POST',
      '/panel/api/inbounds/add',
      inboundData,
    );
  }

  async updateInbound(serverId: number, inboundId: number, inboundData: any) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/panel/api/inbounds/update/${inboundId}`,
      inboundData,
    );
  }

  async deleteInbound(serverId: number, inboundId: number) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/panel/api/inbounds/del/${inboundId}`,
    );
  }

  async addClient(
    serverId: number,
    inboundId: number,
    clientData: any,
  ) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/panel/api/inbounds/addClient`,
      { id: inboundId, ...clientData },
    );
  }

  async updateClient(
    serverId: number,
    inboundId: number,
    clientData: any,
  ) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/panel/api/inbounds/updateClient`,
      { id: inboundId, ...clientData },
    );
  }

  async getClientTraffic(serverId: number, email: string) {
    return this.xuiRequest(
      serverId,
      'GET',
      `/panel/api/inbounds/getClientTraffic?email=${email}`,
    );
  }

  async getServerStats(serverId: number) {
    return this.xuiRequest(
      serverId,
      'GET',
      '/panel/api/server/getShared',
    );
  }

  // ==========================================
  // Server Selection (Load Balancing)
  // ==========================================

  async selectServer(protocol: string, preferredServerId?: number): Promise<number> {
    if (preferredServerId) {
      const server = await this.prisma.server.findUnique({
        where: { id: preferredServerId, status: 'ACTIVE' },
      });
      if (server) return server.id;
    }

    // Weighted random selection from active servers
    const servers = await this.prisma.server.findMany({
      where: { status: 'ACTIVE' },
    });

    if (servers.length === 0) {
      throw new BadRequestException('No active servers available');
    }

    const totalWeight = servers.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;

    for (const server of servers) {
      random -= server.weight;
      if (random <= 0) return server.id;
    }

    return servers[0].id;
  }
}
