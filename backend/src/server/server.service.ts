import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { Agent, setGlobalDispatcher } from 'undici';

// 3-x-ui 面板 API 响应格式（文档统一格式）
export interface XuiResponse<T = any> {
  success: boolean;
  msg?: string;
  obj?: T;
}

@Injectable()
export class ServerService {
  private readonly logger = new Logger(ServerService.name);

  // 面板请求超时：防止面板黑盒不可达时请求悬挂数分钟
  // （undici 默认 headers/bodyTimeout 300s，会越过 cron 锁窗口导致重入）
  private static readonly PANEL_TIMEOUT_MS = 15000;

  // 自签 TLS 面板专用 dispatcher：Node 全局 fetch(undici) 不认 https.Agent 的
  // agent 选项，必须用 undici 的 Agent(connect.rejectUnauthorized:false)。
  private dispatcher: Agent | null = null;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    this.initHttpsAgent();
  }

  private initHttpsAgent() {
    try {
      // 面板几乎都用自签 HTTPS。必须向 undici 注入跳过 CA 校验的全局 Agent，
      // 否则所有面板请求在 DEPTH_ZERO_SELF_SIGNED_CERT 上失败，节点永远建不出来。
      // 注意：undici 不是 Node 的内置可 require 模块，且构造阶段全局 dispatcher
      // 尚未初始化 —— 之前用 Symbol hack + require('undici') 兜底，两者都不可靠，
      // 导致 dispatcher 常为 null、面板 100% 连不上。现在显式依赖 npm undici 的
      // 公开 API（setGlobalDispatcher），Node 20 下稳定生效。
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      setGlobalDispatcher(agent);
      this.dispatcher = agent;
      this.logger.log('Panel dispatcher ready: rejectUnauthorized=false（兼容自签 HTTPS 面板）');
    } catch (e: any) {
      // Agent 构造几乎不会失败；若真失败则保持 this.dispatcher = null
      // （回到默认 TLS 校验），并大声报错，避免「看似成功却全挂」无从察觉
      this.logger.error(`Panel TLS dispatcher init failed: ${e.message}; 自签 HTTPS 面板将连不上`);
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

  /**
   * 规范「API 路径」：3-x-ui 的 API 一律挂在 <webBasePath>/panel/api 之下。
   * 后台表单里填了面板子路径（webBasePath，如 /shiyeotimin）时自动补上 /panel/api；
   * 填了完整路径（/shiyeotimin/panel/api）或默认 /panel/api 则原样采用。
   * —— 避免用户按面板 root 填就 404（/shiyeotimin/inbounds/list 而非 …/panel/api/…）
   */
  private normalizeApiPath(apiPath?: string): string {
    const raw = (apiPath || '/panel/api').trim().replace(/\/+$/, '');
    return raw.endsWith('/panel/api') ? raw : `${raw}/panel/api`;
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
    // 文档："Bearer-token callers can skip this"（CSRF 中间件对 Bearer 短路）
    if (server.apiToken) return server.apiToken;

    // 无 Token，走 Cookie 登录（3.6.0：会话 cookie 的 unsafe 请求必须带 X-CSRF-Token）
    const sessionKey = `xui:session:${serverId}`;
    const csrfKey = `xui:csrf:${serverId}`;
    const cachedSession = await this.redis.get(sessionKey);
    const cachedCsrf = await this.redis.get(csrfKey);
    if (cachedSession && cachedCsrf) return cachedSession;

    // 面板反代子路径：login/CSRF 端点挂在 webBasePath（apiPath 去掉 /panel/api 后缀）下
    const apiBase = this.normalizeApiPath(server.apiPath);
    const webBasePath =
      apiBase.length > '/panel/api'.length
        ? apiBase.slice(0, -'/panel/api'.length)
        : '';
    const base = this.panelBaseUrl(server);

    // 1) 先 GET /csrf-token：公开端点，返回 token 并下发初始会话 cookie
    let csrfToken = '';
    let sessionCookie = '';
    try {
      const csrfRes = await fetch(`${base}${webBasePath}/csrf-token`, {
        method: 'GET',
        // @ts-ignore - undici fetch 用 dispatcher（agent 不生效）
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(ServerService.PANEL_TIMEOUT_MS),
      });
      const csrfBody: any = await csrfRes.json().catch(() => null);
      csrfToken =
        (typeof csrfBody?.obj === 'string' ? csrfBody.obj : undefined) ||
        csrfBody?.obj?.token ||
        csrfBody?.token ||
        '';
      const csrfCookies = csrfRes.headers.getSetCookie?.() || [];
      sessionCookie = csrfCookies
        .map((c: string) => c.split(';')[0])
        .find((c: string) => c.startsWith('session=') || c.startsWith('3x-ui=')) || '';
    } catch (e: any) {
      this.logger.debug(`CSRF token fetch failed: ${e.message}`);
    }

    // 2) POST /login：带 CSRF 阶段的会话 cookie + X-CSRF-Token
    const loginUrl = `${base}${webBasePath}/login`;
    this.logger.debug(`Logging in to XUI panel: ${loginUrl}`);

    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: JSON.stringify({
        username: server.username,
        password: server.password,
      }),
      // @ts-ignore
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(ServerService.PANEL_TIMEOUT_MS),
    });

    // 解析响应 JSON
    let body: XuiResponse;
    try {
      body = await response.json() as XuiResponse;
    } catch {
      const raw = await response.text().catch(() => '');
      throw new BadRequestException(
        `XUI login failed: invalid response from ${loginUrl} — HTTP ${response.status}` +
          (raw ? `, body: ${JSON.stringify(raw.slice(0, 200))}` : ''),
      );
    }

    if (!body.success) {
      throw new BadRequestException(`XUI login failed: ${body.msg || 'unknown error'}`);
    }

    // 登录可能轮换会话 cookie；有新的用新的，否则沿用 CSRF 阶段拿到的
    const loginCookies = response.headers.getSetCookie?.() || [];
    const loginSession = loginCookies
      .map((c: string) => c.split(';')[0])
      .find((c: string) => c.startsWith('session=') || c.startsWith('3x-ui='));
    if (loginSession) sessionCookie = loginSession;

    if (!sessionCookie) {
      throw new BadRequestException('XUI login succeeded but no session cookie received');
    }

    // 缓存 session + CSRF token（1小时 TTL，与 session 同步）
    await this.redis.set(sessionKey, sessionCookie, 3600);
    await this.redis.set(csrfKey, csrfToken, 3600);
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
    timeoutMs = ServerService.PANEL_TIMEOUT_MS,
  ): Promise<XuiResponse> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    // apiPath 默认 /panel/api；填了面板子路径（webBasePath）也会自动补全 /panel/api
    const apiBase = this.normalizeApiPath(server.apiPath);
    const apiUrl = `${this.panelBaseUrl(server)}${apiBase}${path}`;
    const authValue = await this.login(serverId);

    // 有 apiToken 时用 Bearer，否则用 Cookie
    // 文档原文："Authorization: Bearer <token>" — 所有 /panel/api/* 端点都支持
    const useBearer = !!server.apiToken;
    // cookie 会话的 unsafe 请求必须带 X-CSRF-Token（Bearer 可跳过）
    const csrfToken = useBearer ? null : await this.redis.get(`xui:csrf:${serverId}`);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(useBearer
        ? { 'Authorization': `Bearer ${authValue}` }
        : { 'Cookie': authValue, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }
      ),
    };

    const options: RequestInit = {
      method,
      headers,
      // @ts-ignore - undici fetch 用 dispatcher（agent 不生效）
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    let response = await fetch(apiUrl, options);

    // 401/403 → 仅在 Cookie 模式下重新登录（同时重取 CSRF token）
    if ((response.status === 401 || response.status === 403) && !useBearer) {
      this.logger.debug(`Session expired for server ${server.name}, re-login...`);
      await this.redis.del(`xui:session:${serverId}`);
      await this.redis.del(`xui:csrf:${serverId}`);
      const newSession = await this.login(serverId);
      const newCsrf = await this.redis.get(`xui:csrf:${serverId}`);
      headers.Cookie = newSession;
      if (newCsrf) headers['X-CSRF-Token'] = newCsrf;
      response = await fetch(apiUrl, { ...options, headers });
    }

    // 解析 JSON 响应
    let data: XuiResponse;
    try {
      data = await response.json() as XuiResponse;
    } catch {
      // 返回的不是 JSON（404/5xx HTML 页、代理错误页等）——把状态码和原始返回体带进错误，
      // 管理端「测试」按钮直接显示，几秒钟就能判断是"打到了错误的地址/代理"还是"面板没起来"
      const rawBody = await response.text().catch(() => '');
      throw new BadRequestException(
        `XUI API request failed: invalid JSON from ${apiUrl} — HTTP ${response.status}` +
          (rawBody ? `, body: ${JSON.stringify(rawBody.slice(0, 200))}` : ''),
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
   * 真·连接探测：登录（或 Bearer）+ 真实 API 往返（/inbounds/list），
   * 一次性验证 网络/TLS/认证/API 四条链路。失败抛出带具体原因的错误，
   * 管理端「测试连接」按钮据此显示真实面板报错。
   */
  async testConnection(serverId: number) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');
    const authMode = server.apiToken ? 'apiToken (Bearer)' : 'cookie + csrf';
    const started = Date.now();
    const res = await this.xuiRequest(serverId, 'GET', '/inbounds/list');
    if (!res || res.success !== true) {
      throw new BadRequestException(`面板 API 响应异常: ${res?.msg || 'unknown'}`);
    }
    const list = Array.isArray(res.obj) ? res.obj : [];
    return {
      ok: true,
      auth: authMode,
      latencyMs: Date.now() - started,
      inbounds: list.length,
      msg: `连接成功（${authMode}），面板现有 ${list.length} 个入站`,
    };
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
      password?: string; // 客户端密码（trojan/ss；手动流程预填 16 位随机）
      auth?: string;     // Hysteria 认证（手动流程预填 16 位随机）
      flow?: string;     // VLESS 流控，如 xtls-rprx-vision
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
          ...(clientData.password && { password: clientData.password }),
          ...(clientData.auth && { auth: clientData.auth }),
          ...(clientData.flow && { flow: clientData.flow }),
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
   * 启用/停用客户端（3.6.0 面板原生端点，仅切换 enable，不动其它字段）
   * POST /panel/api/clients/bulkEnable | bulkDisable
   * Body: { emails: [...] }
   * 返回: { success, obj: { changed, skipped: [{email, reason}] } }
   * 注意：不要用 /clients/update/{email} 只传 { enable: false } —— 该端点是
   * 【全量替换不是 patch】，会把客户端行上的 totalGB/expiryTime/tgId 等字段清空，
   * 造成面板侧「不限流量 / 永不过期」的错乱。bulkEnable/bulkDisable 是面板为
   * 纯 enable 切换设计的原生操作，到期/超流量/管理员停用必须走这里。
   */
  async setClientEnabled(serverId: number, email: string, enable: boolean) {
    return this.xuiRequest(
      serverId,
      'POST',
      enable ? '/clients/bulkEnable' : '/clients/bulkDisable',
      { emails: [email] },
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
   * 批量调整客户端（bulkAdjust）：可设置 VLESS 的 XTLS flow（xtls-rprx-vision）
   * POST /panel/api/clients/bulkAdjust
   * Body: { emails, addDays, addBytes, flow }
   * 用于 Reality/VLESS 客户端设置 Vision 流控（clients/add 不保证接受 flow）
   */
  async setClientFlow(serverId: number, email: string, flow: string) {
    return this.xuiRequest(serverId, 'POST', '/clients/bulkAdjust', {
      emails: [email],
      addDays: 0,
      addBytes: 0,
      flow,
    });
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
  // Xray 全局配置管理（SOCKS 中转出站 + 路由）
  //    文档路径: /panel/api/xray/  (GET 读全量 config, /update 整体替换)
  //    注意：Xray 的 outbounds 和 routing.rules 是面板全局配置，
  //    因此这里只做「幂等注入 + 定向清理」，避免影响其他节点。
  // ==========================================

  /**
   * 读取当前 Xray 配置模板
   * POST /panel/api/xray/   （文档：POST，无 body）
   * 返回: { success, obj: { xraySetting: "{...raw config...}", inboundTags, ... } }
   * 模板含 outbounds / routing / inbounds 等，可作为读-改-写的基础。
   */
  async getXrayConfig(serverId: number) {
    const res = await this.xuiRequest(serverId, 'POST', '/xray/');
    const raw = res?.obj?.xraySetting;
    if (!raw) return {};
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return {};
    }
  }

  /**
   * 写回 Xray 配置模板
   * POST /panel/api/xray/update
   * 文档：config 作为 form field（application/x-www-form-urlencoded）提交，
   *      值为 Xray JSON config 模板字符串。
   */
  async updateXrayConfig(serverId: number, config: any) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('Server not found');

    const apiBase = this.normalizeApiPath(server.apiPath);
    const apiUrl = `${this.panelBaseUrl(server)}${apiBase}/xray/update`;
    const authValue = await this.login(serverId);
    const useBearer = !!server.apiToken;
    const csrfToken = useBearer ? null : await this.redis.get(`xui:csrf:${serverId}`);
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(useBearer
        ? { 'Authorization': `Bearer ${authValue}` }
        : {
            'Cookie': authValue,
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          }
      ),
    };

    const form = new URLSearchParams();
    const configStr = JSON.stringify(config);
    form.set('config', configStr);
    // 3.6.0 文档只说 update 是 form fields，没写明字段名；GET /xray/ 返回 obj.xraySetting，
    // 历史实现则用 config。两个名字都发同值，面板只绑定它认识的那个（多字段无害）。
    form.set('xraySetting', configStr);

    let response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      // @ts-ignore
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(ServerService.PANEL_TIMEOUT_MS),
      body: form.toString(),
    });

    if ((response.status === 401 || response.status === 403) && !useBearer) {
      await this.redis.del(`xui:session:${serverId}`);
      await this.redis.del(`xui:csrf:${serverId}`);
      const newSession = await this.login(serverId);
      const newCsrf = await this.redis.get(`xui:csrf:${serverId}`);
      headers.Cookie = newSession;
      if (newCsrf) headers['X-CSRF-Token'] = newCsrf;
      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        // @ts-ignore
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(ServerService.PANEL_TIMEOUT_MS),
        body: form.toString(),
      });
    }

    let data: XuiResponse;
    try {
      data = await response.json() as XuiResponse;
    } catch {
      const raw = await response.text().catch(() => '');
      throw new BadRequestException(
        `XUI API request failed: invalid JSON from ${apiUrl} — HTTP ${response.status}` +
          (raw ? `, body: ${JSON.stringify(raw.slice(0, 200))}` : ''),
      );
    }
    if (!data.success) {
      this.logger.warn(`XUI xray/update error: ${data.msg}`);
    }
    return data;
  }

  /**
   * 幂等确保【该节点专属】的 SOCKS 出站存在，指向用户自己填写的 SOCKS 节点。
   * 每个中转节点一个独立出站 tag（socks-<节点端口>），只服务这一个节点，
   * 不会影响同服务器上的其它节点。
   * 返回 { tag, changed }；changed=true 表示实际改动了模板（调用方据此决定是否重启 Xray）。
   */
  async ensureUserSocksOutbound(
    serverId: number,
    target: { host: string; port: number; user?: string; pass?: string },
    tag: string,
  ) {
    const config: any = await this.getXrayConfig(serverId);
    const outbounds: any[] = config?.outbounds || [];

    // 已存在同名出站 → 无需改动
    if (outbounds.some((o: any) => o.tag === tag)) {
      return { tag, changed: false };
    }

    const servers = target.user
      ? [{ address: target.host, port: target.port, users: [{ user: target.user, pass: target.pass }] }]
      : [{ address: target.host, port: target.port }];

    outbounds.push({
      tag,
      protocol: 'socks',
      settings: { servers },
      streamSettings: { network: 'tcp', security: 'none' },
    });
    config.outbounds = outbounds;
    await this.updateXrayConfig(serverId, config);
    this.logger.log(`SOCKS outbound '${tag}' ensured on server ${serverId} -> ${target.host}:${target.port}`);
    return { tag, changed: true };
  }

  /**
   * 幂等确保一条路由规则：把指定入站的流量导向该节点的专属 SOCKS 出站
   * 通过 inboundTag 精确匹配（inbound-<端口>），只影响该中转节点，不影响其他用户。
   * 返回 changed=true 表示实际加了规则（调用方据此决定是否重启）。
   */
  async ensureRelayRouting(serverId: number, relayTag: string, outboundTag: string): Promise<boolean> {
    const config: any = await this.getXrayConfig(serverId);
    const rules: any[] = config?.routing?.rules || [];

    if (rules.some((r: any) => Array.isArray(r.inboundTag) && r.inboundTag.includes(relayTag))) {
      return false;
    }
    if (!config.routing) config.routing = {};
    config.routing.rules = [
      ...rules,
      { type: 'field', inboundTag: [relayTag], outboundTag },
    ];
    await this.updateXrayConfig(serverId, config);
    this.logger.log(`Relay routing rule added for '${relayTag}' -> '${outboundTag}' on server ${serverId}`);
    return true;
  }

  /**
   * 移除指定入站的路由规则（删除/停用中转时调用）
   * 返回 changed=true 表示实际移除了规则（调用方据此决定是否重启）。
   */
  async removeRelayRouting(serverId: number, relayTag: string): Promise<boolean> {
    const config: any = await this.getXrayConfig(serverId);
    const rules: any[] = config?.routing?.rules || [];
    const filtered = rules.filter(
      (r: any) => !(Array.isArray(r.inboundTag) && r.inboundTag.includes(relayTag)),
    );
    if (filtered.length === rules.length) return false;
    if (!config.routing) config.routing = {};
    config.routing.rules = filtered;
    await this.updateXrayConfig(serverId, config);
    this.logger.log(`Relay routing rule removed for '${relayTag}' on server ${serverId}`);
    return true;
  }

  /**
   * 幂等移除该节点的专属 SOCKS 出站（仅当无任何 relay 规则仍引用时）
   * 返回 changed=true 表示实际移除了出站（调用方据此决定是否重启）。
   */
  async removeUserSocksOutbound(serverId: number, outboundTag: string): Promise<boolean> {
    const config: any = await this.getXrayConfig(serverId);
    const rules: any[] = config?.routing?.rules || [];

    // 仍有规则引用该出站 → 保留
    const stillUsed = rules.some(
      (r: any) => r.outboundTag === outboundTag,
    );
    if (stillUsed) return false;

    const outbounds: any[] = config?.outbounds || [];
    const before = outbounds.length;
    config.outbounds = outbounds.filter((o: any) => o.tag !== outboundTag);
    if ((config?.outbounds || []).length === before) return false;
    await this.updateXrayConfig(serverId, config);
    this.logger.log(`SOCKS outbound '${outboundTag}' removed on server ${serverId}`);
    return true;
  }

  /**
   * 重启 Xray，使模板中的 outbounds / routing 变更生效。
   * POST /panel/api/server/restartXrayService
   * 注意：会让该服务器上所有节点闪断数秒，只在模板确有变更时调用。
   */
  async restartXrayService(serverId: number) {
    const res = await this.xuiRequest(serverId, 'POST', '/server/restartXrayService');
    this.logger.log(`Xray restart requested on server ${serverId}: ${res?.success}`);
    return res;
  }

  /**
   * 回读运行中(当前已落盘)的 Xray 完整配置。
   * GET /panel/api/server/getConfigJson — Return the assembled Xray config
   * that's currently running on this host.（obj 为 JSON 字符串）
   * 用于建节点后证明入站真的进了运行态，而非只有面板库记录。
   */
  async getRunningConfigJson(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/server/getConfigJson');
  }

  /**
   * 抓取 Xray 运行期拒绝/错误信息（配置、目标被运行期拒收时会在这里吐出）。
   * GET /panel/api/xray/getXrayResult — 仅在调试用，失败不阻断主流程。
   */
  async getXrayResult(serverId: number) {
    return this.xuiRequest(serverId, 'GET', '/xray/getXrayResult');
  }

  /**
   * 生成新的 X25519 密钥对（Reality 用）
   * GET /panel/api/server/getNewX25519Cert（3.6.0 文档注册为 GET，用 POST 会 404）
   * 返回: { privateKey, publicKey }
   */
  async getNewX25519Key(serverId: number): Promise<{ privateKey: string; publicKey: string }> {
    const res = await this.xuiRequest(serverId, 'GET', '/server/getNewX25519Cert');
    if (!res.obj || !res.obj.privateKey) {
      throw new BadRequestException(`Failed to generate X25519 keypair: ${res.msg || 'unknown error'}`);
    }
    return {
      privateKey: res.obj.privateKey,
      publicKey: res.obj.publicKey || '',
    };
  }

  /**
   * 探测 Reality 目标（3.6.0 面板原生接口）
   * POST /panel/api/server/scanRealityTargets，body {} 空 → 面板用内置种子列表
   * live 探测（TLS1.3+h2+X25519+可信证书），返回按可行性与延迟排序的判定数组：
   * { feasible, host, target, latencyMs, tls13, h2, curveID, certStandardInfo... }
   * 探测耗时较长（面板逐个域名握手），把本次请求超时放宽到 30s。
   */
  async scanRealityTargets(serverId: number) {
    return this.xuiRequest(serverId, 'POST', '/server/scanRealityTargets', {}, 30000);
  }

  // Reality 目标缓存（key: serverId）——避免每笔订单都触发面板全量探测
  private realityTargetCache = new Map<number, { host: string; target: string; at: number }>();
  private static readonly REALITY_TARGET_CACHE_TTL_MS = 30 * 60 * 1000;

  /**
   * 选取延迟最低的可行 Reality 目标。
   * 3.6.0 文档 scanRealityTargets 返回 { host, port, target: "host:port" }：
   *   dest 必须用 target（host:port）——面板「目标」字段和 Xray reality 的 dest 都是
   *   "域名:端口" 格式，裸域名会被面板丢弃回退默认；serverNames/SNI 只放 host。
   * 面板返回已按可行性+延迟排序，这里再做一次防御性筛选（feasible、latency 有效），
   * 取最小值；结果缓存 30 分钟。无可探测目标时回退 www.microsoft.com:443。
   */
  async pickBestRealityTarget(serverId: number): Promise<{ host: string; target: string }> {
    const cached = this.realityTargetCache.get(serverId);
    if (cached && Date.now() - cached.at < ServerService.REALITY_TARGET_CACHE_TTL_MS) {
      return { host: cached.host, target: cached.target };
    }
    const res = await this.scanRealityTargets(serverId);
    const list = Array.isArray(res?.obj) ? res.obj : [];
    const viable = (list as any[])
      .filter((t: any) => t?.feasible !== false && typeof t?.host === 'string' && t.host.length > 0)
      .filter((t: any) => Number(t?.latencyMs ?? Infinity) > 0)
      .sort((a: any, b: any) => Number(a?.latencyMs ?? Infinity) - Number(b?.latencyMs ?? Infinity));
    const best = viable[0];
    const port = Number(best?.port) > 0 ? Number(best.port) : 443;
    // dest 必须是能真实拨号的 host:port。scanRealityTargets 返回的 target 字段可能携带
    // 「聊天粘贴残渣」（如 [www.cloudflare.com:443](https://www.cloudflare.com:443)）——
    // 直接信任它的话，Xray 冒充握手时根本连不上这个主机，节点建得再对也照样废。
    // 一律剥壳→抽域名→校验，不合格就回退，绝不让垃圾值进 dest/serverNames。
    const host =
      ServerService.sanitizeRealityHost(best?.host) ??
      ServerService.sanitizeRealityHost(best?.target) ??
      'www.microsoft.com';
    const target = `${host}:${port}`;
    this.realityTargetCache.set(serverId, { host, target, at: Date.now() });
    if (best) {
      this.logger.log(
        `Reality target for server ${serverId}: ${host} (${best?.latencyMs}ms, TLS1.3=${best?.tls13 === true}, h2=${best?.h2 === true})`,
      );
    } else {
      this.logger.warn(`scanRealityTargets 无可行目标 on server ${serverId}，回退 ${host}`);
    }
    return { host, target };
  }

  /**
   * 从候选 Reality 目标中提取可用的纯域名，剔除一切非主机名残留；不合法返回 null。
   * 典型输入是用户在面板里「从聊天粘贴」产生的 markdown 残渣：
   *   [www.cloudflare.com](https://www.cloudflare.com)            → www.cloudflare.com
   *   [www.cloudflare.com:443](https://www.cloudflare.com:443)     → www.cloudflare.com
   *   https://host:port/path  /  host:443                          → host
   */
  private static sanitizeRealityHost(raw?: any): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let s = raw.trim();
    const md = s.match(/^\[([^\]]+)\]\([^)]*\)/); // markdown 链接壳：取方括号内文本
    if (md) s = md[1];
    s = s.split(/\s+/)[0];
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // 剥 schema://
    s = s.split('/')[0].split('?')[0];
    if (s.includes(':')) s = s.split(':')[0]; // 剥端口
    const m = s.match(/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/);
    return m ? s : null;
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
