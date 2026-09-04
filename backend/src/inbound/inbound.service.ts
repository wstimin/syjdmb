import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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
    relay?: boolean;   // 购买时勾选中转：在该源节点上挂 SOCKS 出站+路由，节点全程走中转
    relaySocksHost?: string; // 用户填写的 SOCKS 节点地址（出口 IP）
    relaySocksPort?: number;
    relaySocksUser?: string;
    relaySocksPass?: string;
  }) {
    const {
      userId,
      plan,
      serverId,
      protocol,
      relay = false,
      relaySocksHost,
      relaySocksPort,
      relaySocksUser,
      relaySocksPass,
    } = params;

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

    // Client object（3.6.0 客户端是一等公民，通过 /panel/api/clients/add 创建，
    // 不再内嵌到入站的 settings.clients[] 中）
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

    // Build protocol-specific settings（clients 置空，客户端另建）
    let settings: string;
    switch (protocol.toLowerCase()) {
      case 'vmess': {
        settings = JSON.stringify({
          clients: [],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'vless': {
        settings = JSON.stringify({
          clients: [],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'trojan': {
        settings = JSON.stringify({
          clients: [],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'shadowsocks': {
        settings = JSON.stringify({
          clients: [],
          method: 'aes-256-gcm',
          password: uuid,
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
      // 1) 建入站（settings.clients 为空，不再内嵌客户端）
      const response = await this.serverService.addInbound(serverId, inboundData);
      const xuiInboundId = this.extractInboundId(response);

      if (!xuiInboundId) {
        throw new BadRequestException('Failed to obtain XUI inbound id');
      }

      // 2) 建客户端并关联到该入站（3.6.0 文档：POST /panel/api/clients/add）
      //    服务端按协议自动生成 UUID/密码；我们显式传 UUID 以生成一致的连接串
      const clientRes = await this.serverService.addClient(
        serverId,
        {
          email: client.email,
          totalGB: client.totalGB,
          expiryTime: client.expiryTime,
          limitIp: client.limitIp,
          enable: true,
          id: client.id,
          subId: client.subId,
        },
        [xuiInboundId],
      );
      if (!clientRes?.success) {
        // 建客户端失败则回滚入站，避免留下空入站
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        throw new BadRequestException(`Failed to add XUI client: ${clientRes?.msg}`);
      }

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
          relayEnabled: relay,
          relayTag: relay ? `inbound-${port}` : null,
          relaySocksOutboundTag: relay ? `socks-${port}` : null,
          relaySocksHost: relay ? relaySocksHost : null,
          relaySocksPort: relay ? relaySocksPort : null,
          relaySocksUser: relay ? relaySocksUser : null,
          relaySocksPass: relay ? relaySocksPass : null,
          remark: `Order ${inboundData.remark}`,
        },
      });

      // 购买时勾选中转：在该源节点上挂 SOCKS 出站（指向用户填的 SOCKS 节点，出口 = 该 SOCKS IP）
      // + 一条只命中该节点端口的路由规则。不新增节点；节点全程走 SOCKS。
      if (relay) {
        await this.mountRelayOnNode(serverId, port, {
          host: relaySocksHost,
          port: relaySocksPort,
          user: relaySocksUser,
          pass: relaySocksPass,
        });
      }

      this.logger.log(`Inbound created: ${email} port=${port} on server ${server.name}`);
      return inbound;
    } catch (error) {
      this.logger.error(`Failed to create inbound: ${error.message}`);
      throw new BadRequestException(`Failed to create inbound: ${error.message}`);
    }
  }

  /**
   * 在【源节点】上挂 SOCKS 中转（购买时勾选中转的路径）。
   * 为该节点创建专属出站 socks-<端口>，指向用户填写的 SOCKS 节点（出口 = 该 SOCKS IP），
   * 再加一条只命中该入站端口的路由规则，让该节点流量全程走这个 SOCKS。
   * 仅在配置确有变更时重启 Xray（重启会让该服务器全部节点闪断数秒）。
   */
  private async mountRelayOnNode(
    serverId: number,
    port: number,
    socks: { host?: string; port?: number; user?: string; pass?: string },
  ) {
    if (!socks.host || !socks.port) {
      throw new BadRequestException(
        '开启中转需要填写 SOCKS 节点的地址和端口',
      );
    }

    const relayTag = `inbound-${port}`;
    const outboundTag = `socks-${port}`;

    const outbound = await this.serverService.ensureUserSocksOutbound(
      serverId,
      { host: socks.host, port: socks.port, user: socks.user, pass: socks.pass },
      outboundTag,
    );
    const ruleChanged = await this.serverService.ensureRelayRouting(
      serverId,
      relayTag,
      outboundTag,
    );
    if (outbound.changed || ruleChanged) {
      await this.serverService.restartXrayService(serverId);
    }
    this.logger.log(
      `Relay mounted on source node ${relayTag} -> ${outboundTag} (${socks.host}:${socks.port}) on server ${serverId}`,
    );
  }

  /**
   * 移除【源节点】上的 SOCKS 中转：删该节点的路由规则，再删该节点专属出站。
   * 配置确有变更时重启 Xray。
   */
  private async unmountRelayFromNode(serverId: number, inbound: any) {
    const relayTag = inbound.relayTag;
    const outboundTag = inbound.relaySocksOutboundTag;
    const ruleRemoved = relayTag
      ? await this.serverService.removeRelayRouting(serverId, relayTag)
      : false;
    const outboundRemoved = outboundTag
      ? await this.serverService.removeUserSocksOutbound(serverId, outboundTag)
      : false;
    if (ruleRemoved || outboundRemoved) {
      await this.serverService.restartXrayService(serverId);
    }
    this.logger.log(`Relay unmounted from ${relayTag} (server ${serverId})`);
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

  /**
   * 定时任务：每分钟扫描所有活跃节点
   *  - 到期判定：expiryTime 已过 → 停用（面板端 + 本地）
   *  - 流量判定：累计流量 >= 套餐限额 → 停用
   * 判定通过后调用面板接口真正关闭客户端，否则用户仍可连接
   *  (由 @nestjs/schedule 的 @Cron 触发，见下方 checkExpiryAndTraffic)
   */
  async updateTraffic() {
    const inbounds = await this.prisma.inbound.findMany({
      where: { status: { in: ['ACTIVE', 'EXPIRED', 'SUSPENDED'] } },
      include: { server: true },
    });

    const now = Date.now();

    for (const inbound of inbounds) {
      try {
        // —— 到期判定 ——
        const expiresAt = inbound.expiryTime ? new Date(inbound.expiryTime).getTime() : null;
        const expired = expiresAt !== null && expiresAt <= now;

        // —— 流量判定 ——
        const traffic = await this.serverService.getClientTraffic(
          inbound.serverId,
          inbound.email,
        );
        const up = traffic?.obj?.up || 0;
        const down = traffic?.obj?.down || 0;
        const total = up + down;
        const limit = Number(inbound.trafficLimit);
        const limitExceeded = limit > 0 && total >= limit;

        // —— 判定：到期或超流量 → 停用 ——
        if (expired || (limitExceeded && inbound.status !== 'EXPIRED')) {
          // 面板端停用客户端（enable: false）
          //  仅当客户端当前是启用状态才调用，避免重复调用
          const clientEnabled = traffic?.obj?.enable !== false;
          if (inbound.status === 'ACTIVE' && clientEnabled) {
            const res = await this.serverService.updateClient(
              inbound.serverId,
              inbound.email,
              { enable: false },
            );
            if (!res?.success) {
              this.logger.warn(
                `Failed to disable client ${inbound.email} on server ${inbound.serverId}: ${res?.msg}`,
              );
            } else {
              this.logger.log(
                `Node ${inbound.email} disabled (${expired ? 'expired' : 'traffic limit'})`,
              );
            }
          }

          // 本地状态更新
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: {
              totalTraffic: BigInt(total),
              status: expired ? 'EXPIRED' : 'EXPIRED',
            },
          });
        } else {
          // 未到期超限，仅更新流量计数
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: { totalTraffic: BigInt(total) },
          });
        }
      } catch (e) {
        this.logger.debug(
          `Failed to update traffic for ${inbound.email}: ${e.message}`,
        );
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

  /**
   * 定时检查节点到期 / 流量超额
   * 每分钟执行一次（* * * * *）
   * 到期或超流量的节点会自动在 XUI 面板端停用客户端并标记本地状态
   */
  @Cron('* * * * *')
  async checkExpiryAndTraffic() {
    try {
      await this.updateTraffic();
    } catch (e) {
      this.logger.error(`Scheduled expiry/traffic check failed: ${e.message}`);
    }
  }

  async delete(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    // 该节点是中转节点 → 先移除它的路由规则及其专属出站
    if (inbound.relayEnabled) {
      try {
        await this.unmountRelayFromNode(inbound.serverId, inbound);
      } catch (e) {
        this.logger.warn(`Failed to unmount relay: ${e.message}`);
      }
    }

    try {
      // 3.6.0：先删客户端（从所有关联入站移除 + 删流量记录）
      await this.serverService.deleteClient(inbound.serverId, inbound.email);
    } catch (e) {
      this.logger.warn(`Failed to delete XUI client ${inbound.email}: ${e.message}`);
    }

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
