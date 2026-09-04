import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

// 3-x-ui 面板 API 响应格式（文档统一格式）
export interface XuiResponse<T = any> {
  success: boolean;
  msg?: string;
  obj?: T;
}

@Injectable()
export class ServerService {
  private readonly logger = new Logger(ServerService.name);

  // TLS 自签证书支持：面板通常用自签 HTTPS，容器内通过此 Agent 跳过验证
  private httpsAgent: any = null;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.initHttpsAgent();
  }

  private initHttpsAgent() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require('https');
      this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    } catch {
      this.logger.warn('Node.js https module not available, HTTPS panels may fail');
    }
  }

  // ==========================================
  // 面板连接地址构建
  // ==========================================

  /**
   * 构建面板 Base URL
   * 3-x-ui 默认端口 54321，HTTP/HTTPS 取决于面板配置
   */
  private panelBaseUrl(server: { protocol: string; host: string; port: number }): string {
    return `${server.protocol}://${server.host}:${server.port}`;
  }

  // ==========================================
  // 服务器管理（数据库操作）
  // ==========================================

  async createPanel(data: {
    name: string;
    host: string;
    port: number;
    protocol?: string;
    apiPath?: string;
    username: string;
    password: string;
    apiToken?: string;
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
        protocol: data.protocol || 'http',
        apiPath: data.apiPath || '/panel/api',
        username: data.username,
        password: data.password,
        apiToken: data.apiToken || null,
        remark: data.remark,
        country: data.country || 'US',
        flag: data.flag,
        weight: data.weight || 1,
        maxUsers: data.maxUsers || 100,
      },
    });

    // 创建时测试连接
    try {
      await this.login(server.id);
      this.logger.log(`Server ${server.name} connected successfully`);
    } catch (e: any) {
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

    // 检查 session 缓存状态
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

    // 如果连接信息变了，清除旧 session 缓存
    if (data.host || data.port || data.username || data.password || data.protocol) {
      await this.redis.del(`xui:session:${id}`);
    }

    return this.prisma.server.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');

    // 检查是否有活跃节点
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
  // 3-x-ui 面板认证
  //    两种模式（文档原文）：
  //    1. Cookie 认证：POST /login 获取 session cookie
  //    2. Bearer Token：Settings → Security → API Token
  //    所有 /panel/api/* 端点同时支持两种模式
  //    有 apiToken 时优先用 Token（更稳定，不过期）
  // ==========================================

  async login(serverId: number): Promise<string> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    // 有 API Token 时直接返回，不需要登录
    // 文档原文："Bearer-token callers can skip this"
    if (server.apiToken) return server.apiToken;

    // 无 Token，走 Cookie 登录
    const sessionKey = `xui:session:${serverId}`;
    const cachedSession = await this.redis.get(sessionKey);
    if (cachedSession) return cachedSession;

    const loginUrl = `${this.panelBaseUrl(server)}/login`;
    this.logger.debug(`Logging in to XUI panel: ${loginUrl}`);

    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: server.username,
        password: server.password,
      }),
      // @ts-ignore - Node 18+ 支持 agent 选项，用于自签证书
      agent: this.httpsAgent,
    });

    // 解析响应 JSON
    let body: XuiResponse;
    try {
      body = await response.json() as XuiResponse;
    } catch {
      throw new BadRequestException(`XUI login failed: invalid response from ${loginUrl}`);
    }

    if (!body.success) {
      throw new BadRequestException(`XUI login failed: ${body.msg || 'unknown error'}`);
    }

    // 从 Set-Cookie 头提取 session cookie
    const cookies = response.headers.getSetCookie?.() || [];
    const sessionCookie = cookies
      .map((c: string) => c.split(';')[0])
      .find((c: string) => c.startsWith('session=') || c.startsWith('3x-ui='));

    if (!sessionCookie) {
      throw new BadRequestException('XUI login succeeded but no session cookie received');
    }

    // 缓存 session（1小时 TTL）
    await this.redis.set(sessionKey, sessionCookie, 3600);
    this.logger.log(`XUI login successful for server ${server.name}`);
    return sessionCookie;
  }

  // ==========================================
  // 通用面板 API 请求
  //    自动处理：Token/Cookie 认证、401/403 重试、响应格式校验
  // ==========================================

  async xuiRequest(
    serverId: number,
    method: 'GET' | 'POST',
    path: string,
    body?: any,
  ): Promise<XuiResponse> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    // apiPath 默认 /panel/api，反向代理自定义路径时从数据库读取
    const apiBase = server.apiPath || '/panel/api';
    const apiUrl = `${this.panelBaseUrl(server)}${apiBase}${path}`;
    const authValue = await this.login(serverId);

    // 有 apiToken 时用 Bearer，否则用 Cookie
    // 文档原文："Authorization: Bearer <token>" — 所有 /panel/api/* 端点都支持
    const useBearer = !!server.apiToken;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(useBearer
        ? { 'Authorization': `Bearer ${authValue}` }
        : { 'Cookie': authValue }
      ),
    };

    const options: RequestInit = {
      method,
      headers,
      // @ts-ignore
      agent: this.httpsAgent,
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    let response = await fetch(apiUrl, options);

    // 401/403 → 仅在 Cookie 模式下重新登录（Token 无效不会因重试变好）
    if ((response.status === 401 || response.status === 403) && !useBearer) {
      this.logger.debug(`Session expired for server ${server.name}, re-login...`);
      await this.redis.del(`xui:session:${serverId}`);
      const newSession = await this.login(serverId);
      headers.Cookie = newSession;
      response = await fetch(apiUrl, { ...options, headers });
    }

    // 解析 JSON 响应
    let data: XuiResponse;
    try {
      data = await response.json() as XuiResponse;
    } catch {
      throw new BadRequestException(
        `XUI API request failed: invalid JSON response from ${path}`,
      );
    }

    // 检查面板返回的业务错误
    if (!data.success) {
      this.logger.warn(`XUI API error [${path}]: ${data.msg}`);
    }

    return data;
  }

  // ==========================================
  // Inbound 管理
  //    文档路径: /panel/api/inbounds/*
  // ==========================================

  /**
   * 获取所有入站
   * GET /panel/api/inbounds/list
   * 返回: { success, obj: [{ id, remark, port, protocol, settings, clientStats, ... }] }
   */
  async getInbounds(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/inbounds/list');
  }

  /**
   * 获取单个入站详情
   * GET /panel/api/inbounds/get/{id}
   */
  async getInbound(serverId: number, inboundId: number) {
    return this.xuiRequest(
      serverId,
      'GET',
      `/inbounds/get/${inboundId}`,
    );
  }

  /**
   * 添加入站
   * POST /panel/api/inbounds/add
   * Body: { enable, remark, listen, port, protocol, settings: { clients: [...] }, streamSettings, sniffing }
   * 注意：3.6.0 中入站仍可内嵌 clients，但推荐用 /panel/api/clients/add 创建
   */
  async addInbound(serverId: number, inboundData: {
    enable?: boolean;
    remark: string;
    listen?: string;
    port: number;
    protocol: string;
    settings?: any;
    streamSettings?: any;
    sniffing?: any;
    expiryTime?: number;
    total?: number;
  }) {
    return this.xuiRequest(
      serverId,
      'POST',
      '/inbounds/add',
      inboundData,
    );
  }

  /**
   * 更新入站
   * POST /panel/api/inbounds/update/{id}
   */
  async updateInbound(serverId: number, inboundId: number, inboundData: any) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/inbounds/update/${inboundId}`,
      inboundData,
    );
  }

  /**
   * 删除入站
   * POST /panel/api/inbounds/del/{id}
   */
  async deleteInbound(serverId: number, inboundId: number) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/inbounds/del/${inboundId}`,
    );
  }

  // ==========================================
  // Client 管理（一等公民 API）
  //    文档路径: /panel/api/clients/*
  //    3-x-ui v3.6.0 中 Client 是独立实体，
  //    通过 inboundIds 关联到多个入站。
  //    客户端以 email 为唯一标识。
  // ==========================================

  /**
   * 添加客户端并关联到入站
   * POST /panel/api/clients/add
   * Body: {
   *   client: { email, totalGB, expiryTime, tgId, limitIp, enable },
   *   inboundIds: [3, 5]
   * }
   * 服务端自动生成 UUID/密码（可传 id 覆盖）
   */
  async addClient(
    serverId: number,
    clientData: {
      email: string;
      totalGB?: number;
      expiryTime?: number;
      tgId?: number;
      limitIp?: number;
      enable?: boolean;
      id?: string;       // VLESS/VMess UUID，不传则自动生成
      subId?: string;    // 订阅ID，不传则自动生成
    },
    inboundIds: number[],
  ) {
    return this.xuiRequest(
      serverId,
      'POST',
      '/clients/add',
      {
        client: {
          email: clientData.email,
          totalGB: clientData.totalGB ?? 0,
          expiryTime: clientData.expiryTime ?? 0,
          tgId: clientData.tgId ?? 0,
          limitIp: clientData.limitIp ?? 0,
          enable: clientData.enable ?? true,
          ...(clientData.id && { id: clientData.id }),
          ...(clientData.subId && { subId: clientData.subId }),
        },
        inboundIds,
      },
    );
  }

  /**
   * 更新客户端
   * POST /panel/api/clients/update/{email}
   * Body: { email, totalGB, expiryTime, enable, ... }
   * 注意：是全量替换，需要传完整的字段集
   */
  async updateClient(
    serverId: number,
    email: string,
    clientData: {
      email?: string;
      totalGB?: number;
      expiryTime?: number;
      tgId?: number;
      limitIp?: number;
      enable?: boolean;
    },
  ) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/clients/update/${encodeURIComponent(email)}`,
      clientData,
    );
  }

  /**
   * 删除客户端
   * POST /panel/api/clients/del/{email}
   * 从所有关联的入站移除并删除客户端记录
   * Query: keepTraffic=1 可保留流量记录
   */
  async deleteClient(serverId: number, email: string, keepTraffic = false) {
    const qs = keepTraffic ? '?keepTraffic=1' : '';
    return this.xuiRequest(
      serverId,
      'POST',
      `/clients/del/${encodeURIComponent(email)}${qs}`,
    );
  }

  /**
   * 获取客户端连接链接
   * GET /panel/api/clients/links/{email}
   * 返回所有关联入站的协议 URL（vless://, vmess://, trojan://, ss:// 等）
   * 返回: { success, obj: ["vless://uuid@host:443?...", "vmess://eyJ..."] }
   */
  async getClientLinks(serverId: number, email: string) {
    return this.xuiRequest(
      serverId,
      'GET',
      `/clients/links/${encodeURIComponent(email)}`,
    );
  }

  /**
   * 获取客户端流量统计
   * GET /panel/api/clients/traffic/{email}
   * 返回: { success, obj: { email, up, down, total, enable, expiryTime, ... } }
   */
  async getClientTraffic(serverId: number, email: string) {
    return this.xuiRequest(
      serverId,
      'GET',
      `/clients/traffic/${encodeURIComponent(email)}`,
    );
  }

  /**
   * 将客户端附加到额外入站
   * POST /panel/api/clients/{email}/attach
   * Body: { inboundIds: [7, 9] }
   */
  async attachClient(serverId: number, email: string, inboundIds: number[]) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/clients/${encodeURIComponent(email)}/attach`,
      { inboundIds },
    );
  }

  /**
   * 将客户端从入站分离
   * POST /panel/api/clients/{email}/detach
   * Body: { inboundIds: [5] }
   */
  async detachClient(serverId: number, email: string, inboundIds: number[]) {
    return this.xuiRequest(
      serverId,
      'POST',
      `/clients/${encodeURIComponent(email)}/detach`,
      { inboundIds },
    );
  }

  /**
   * 获取所有客户端列表
   * GET /panel/api/clients/list
   * 返回: { success, obj: [{ id, email, subId, totalGB, expiryTime, inboundIds, traffic, ... }] }
   */
  async listClients(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/clients/list');
  }

  /**
   * 批量创建客户端
   * POST /panel/api/clients/bulkCreate
   * Body: [{ client: {...}, inboundIds: [...] }, ...]
   */
  async bulkCreateClients(
    serverId: number,
    clients: Array<{
      client: { email: string; totalGB?: number; expiryTime?: number; enable?: boolean; [key: string]: any };
      inboundIds: number[];
    }>,
  ) {
    return this.xuiRequest(
      serverId,
      'POST',
      '/clients/bulkCreate',
      clients,
    );
  }

  // ==========================================
  // 服务器状态
  // ==========================================

  /**
   * 获取面板服务器状态
   * GET /panel/api/server/status
   * 返回: { success, obj: { cpu, mem, swap, disk, netIO, xray: { state, version }, tcpCount, load, ... } }
   */
  async getServerStats(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/server/status');
  }

  // ==========================================
  // 服务器选择（负载均衡）
  // ==========================================

  async selectServer(protocol: string, preferredServerId?: number): Promise<number> {
    if (preferredServerId) {
      const server = await this.prisma.server.findUnique({
        where: { id: preferredServerId, status: 'ACTIVE' },
      });
      if (server) return server.id;
    }

    // 加权随机选择活跃服务器
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
