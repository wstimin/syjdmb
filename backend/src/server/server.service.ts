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
   * 续费/续流量：给客户端追加到期天数与流量配额（字节）。
   * POST /panel/api/clients/bulkAdjust  { emails, addDays, addBytes }
   * - addDays  → 现有 expiry_time 上加天数（无限期客户端被面板跳过）
   * - addBytes → 现有剩余配额 total 上加字节（不限流量客户端被面板跳过）
   * 面板在调整后会检测「耗尽被停用」的客户端（超流量/已过期），一旦不再耗尽
   * 就自动 BulkSetEnable(true) 并重载 Xray —— 即续费后节点自动复活重启。
   * 注意：不要用 /clients/update/{email} —— 那是全量替换，会把 totalGB/expiryTime 清空。
   */
  async adjustClientQuota(serverId: number, email: string, addDays = 0, addBytes = 0) {
    return this.xuiRequest(serverId, 'POST', '/clients/bulkAdjust', {
      emails: [email],
      addDays,
      addBytes,
    });
  }

  /**
   * 流量重置：清零客户端已用流量（up/down → 0）并重新启用（enable=true），
   * 用于「流量重置 / 开新周期」续费（不叠加语义：额度不累加，仅回到满额）。
   * POST /panel/api/clients/bulkResetTraffic  { emails }  （3.6.0 原生端点）
   * 面板会重置所有关联入站的已用统计并传播到节点；total（配额）与到期时间不变。
   * 对已被面板停用/耗尽的客户端自动复活 —— 这是节点续费后自动恢复的关键。
   */
  async resetClientTraffic(serverId: number, email: string) {
    return this.xuiRequest(serverId, 'POST', '/clients/bulkResetTraffic', {
      emails: [email],
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
   * 返回: { success, obj: { xraySetting: "<Xray JSON 模板>", inboundTags, ... } }
   * 注意面板的 obj 有两种形态，都要兼容：
   *  - vaxilu/x-ui 等：obj 直接是对象 { xraySetting, inboundTags }
   *  - 3.x fork（jsonObj 传 string）：obj 是 JSON 字符串，需先 JSON.parse 再取 xraySetting
   * 模板含 outbounds / routing / inbounds 等，可作为读-改-写的基础。
   * 解析失败返回 {}（调用方必须拒绝写回，防止用残缺配置覆盖面板模板）。
   */
  async getXrayConfig(
    serverId: number,
  ): Promise<{ config: any; outboundTestUrl?: string }> {
    const res = await this.xuiRequest(serverId, 'POST', '/xray/');

    // 形态一：obj 本身就是 xraySetting 对象（个别面板省一层包装）→ 直接用
    if (res?.obj && typeof res.obj === 'object' && !Array.isArray(res.obj) && 'outbounds' in res.obj) {
      return { config: res.obj as any };
    }

    // 形态二：obj 是 { xraySetting, ... } 对象；形态三：obj 是 JSON 字符串（3.x fork）
    let wrapper: any = res?.obj;
    if (typeof wrapper === 'string') {
      try {
        wrapper = JSON.parse(wrapper);
      } catch {
        return { config: {} };
      }
    }
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return { config: {} };

    // 面板 GET /xray/ 把管理员自定义的出站测速 URL 放在 obj 顶层（controller getXraySetting:
    // map["outboundTestUrl"]）。而 updateSetting 在该字段缺失时置默认「google generate_204」并
    // 无条件 SetXrayOutboundTestUrl —— 写回不带它，每次挂载/卸载都会把管理员的测速 URL 静默
    // 重置成默认值（outboundTestUrl 对抗复核确认的缺陷）。必须原样带回并在 updateXrayConfig 回传。
    let outboundTestUrl: string | undefined;
    if (typeof wrapper.outboundTestUrl === 'string' && wrapper.outboundTestUrl) {
      outboundTestUrl = wrapper.outboundTestUrl;
    }

    let raw: any = wrapper.xraySetting;
    if (raw == null) return { config: {}, outboundTestUrl };
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { config: {}, outboundTestUrl };
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: {}, outboundTestUrl };
    return { config: raw as any, outboundTestUrl };
  }

  /**
   * 写回 Xray 配置模板
   * POST /panel/api/xray/update
   * 文档：config 作为 form field（application/x-www-form-urlencoded）提交，
   *      值为 Xray JSON config 模板字符串。
   *
   * 保护铁律：只有「读到了完整模板再改」的配置才允许写回。无 outbounds 或无 routing.rules
   * 的配置是残缺的，写回去会把面板模板整体替换成残缺内容（曾导致默认/手动出站与路由被清空，
   * 只剩一条自动补回的 api 规则）。任何调用方发现读不完整都必须抛错，而不是写回。
   */
  async updateXrayConfig(serverId: number, config: any, echoOutboundTestUrl?: string) {
    const validShape =
      config &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      Array.isArray(config.outbounds) &&
      config.outbounds.length > 0 && // 非空强制：默认出站被历史 bug 清空的模板也拒绝写回
      config.routing &&
      typeof config.routing === 'object' &&
      !Array.isArray(config.routing) &&
      Array.isArray(config.routing.rules) &&
      config.routing.rules.length > 0; // 非空强制：routing.rules 为空数组同样拒绝写回
    if (!validShape) {
      throw new BadRequestException(
        '面板配置读取不完整，已拒绝写回（防止清空现有出站/路由）',
      );
    }

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
    // 3.6.0 updateSetting 只绑定 xraySetting 这一个 form 字段（controller xray_setting.go:143）：
    // config 同名同值一并发送，面板只读它认识的那个，多字段无害。
    form.set('xraySetting', configStr);
    form.set('config', configStr);
    // 【outboundTestUrl】updateSetting 对缺失字段置默认「google generate_204」并无条件
    // SetXrayOutboundTestUrl —— 每次挂载/卸载若不带回管理员自定义的值，会把面板测速 URL
    // 静默重置成默认值（对抗复核确认的缺陷，面板源码 xray_setting.go:148-155）。
    if (echoOutboundTestUrl) form.set('outboundTestUrl', echoOutboundTestUrl);

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
      // 【swallowed-failure 残项 + 一致性】面板 updateSetting 是「保存模板 → CheckXrayConfig
      // 校验 → RestartXray 应用」一路下来的，success=false 说明至少一步失败（保存失败/校验
      // 拒绝/应用失败）。原来只 logger.warn 会让挂载/卸载调用方把“没写成功”当“已成功”继续走完
      // —— 用户拿到“已挂载中转”实则未生效，与 suspend/resume 等兄弟端点（检查 res?.success）
      // 的约定不一致。必须抛错，由调用方决定回滚/终止（zombie-create 补偿、delete 中断）。
      throw new BadRequestException(`XUI 拒绝保存 Xray 配置：${data.msg || '未知错误'}`);
    }
    return data;
  }

  /** 单服务器互斥：模板「读→改→写」是两次非原子网络往返，并发读写会互相覆盖丢更新
   *  （race-lost-update 对抗复核确认的缺陷：先读同一旧快照、后写覆盖先写，先写方的
   *   socks-<port> 出站与路由规则静默消失）。用 promise 链为每个 serverId 串行化挂载/卸载。 */
  private readonly relayLocks = new Map<number, Promise<void>>();

  private withRelayLock<T>(serverId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.relayLocks.get(serverId) ?? Promise.resolve();
    // prev 失败也继续执行本次操作（互斥只保证顺序，不传递上一次的错误）；run 的错误原样抛给调用方
    const run: Promise<T> = prev.then(fn, fn);
    // 链尾：下一个调用者会接在 run 之后
    const tail = run.then(() => undefined, () => undefined);
    this.relayLocks.set(serverId, tail);
    tail.then(() => {
      // 队列空（没有新的调用者再次接链）→ 清理，防 Map 无限增长
      if (this.relayLocks.get(serverId) === tail) this.relayLocks.delete(serverId);
    });
    return run;
  }

  /** 读模板完整性断言 —— 形状护栏必须作用在【读取后、修改前】的原始配置上
   *  （shape-guard-bypass 对抗复核确认的缺陷：旧校验在 ensure 补完/重建后才跑，永远拦不到
   *   “读到的残缺配置”）。三个条件缺一即拒绝继续：
   *  - 空对象：面板读取失败/异常响应
   *  - outbounds 缺失/非数组/为空：模板被历史 bug 打残（或被 remove 清空）。此时补齐再写回
   *    等于给 Xray 只留一个 socks 出站当默认出口，同服务器其它入站流量会全落到某个用户
   *    的 SOCKS 上（跨用户流量经一个出口）或核心不可达
   *  - routing.rules 缺失/非数组：面板默认模板必有（api / geoip:private / bittorrent 三条） */
  private assertConfigComplete(config: any, action: '挂载' | '卸载') {
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length === 0) {
      throw new BadRequestException(
        `读取面板 Xray 配置失败，已终止${action}以保护现有出站/路由`,
      );
    }
    if (!Array.isArray(config.outbounds) || config.outbounds.length === 0) {
      throw new BadRequestException(
        `面板 Xray 配置没有默认出站（outbounds 为空），已拒绝${action}—— 模板可能被旧版 Bug 清空过，请先在面板恢复备份或手工重建出站后再试`,
      );
    }
    if (
      !config.routing ||
      typeof config.routing !== 'object' ||
      Array.isArray(config.routing) ||
      !Array.isArray(config.routing.rules) ||
      config.routing.rules.length === 0
    ) {
      throw new BadRequestException(
        `面板 Xray 配置缺少路由规则（routing.rules 为空），已拒绝${action}写回`,
      );
    }
  }

  /**
   * 幂等挂载一个节点的 SOCKS 中转（单次读-改-写）：
   * 1) 读一次面板模板（此前的分步实现里，第二步会因读取失败而把第一步写入的出站又覆盖掉；
   *    合并成单次读改写后，模板只会被整体改一次，现有出站/路由绝不会丢）
   * 2) 内存中确保「该节点专属出站 socks-<端口>」存在（指向用户自己的 SOCKS 节点）+ 追加一条
   *    只命中该入站的路由规则（inboundTag 精确匹配，不影响同服务器其它节点）
   * 3) 确有变更才写回一次，并原样带回面板出站测速 URL。
   * 读模板失败/不完整 → 抛错终止，绝不写回残缺配置（保护铁律，见 updateXrayConfig/assertConfigComplete）。
   */
  async ensureRelayMount(
    serverId: number,
    opts: {
      relayTag: string; // 面板真实入站 tag（in-<port>-tcp）：路由规则 inboundTag 用它
      outboundTag: string; // socks-<port>
      target: { host: string; port: number; user?: string; pass?: string };
    },
  ): Promise<{ changed: boolean }> {
    return this.withRelayLock(serverId, async () => {
      const { config, outboundTestUrl } = await this.getXrayConfig(serverId);
      this.assertConfigComplete(config, '挂载'); // 修改前断言（shape-guard-bypass）
      const cfg: any = config;

      let changed = false;
      const outbounds: any[] = cfg.outbounds;
      if (!outbounds.some((o: any) => o?.tag === opts.outboundTag)) {
        const servers = opts.target.user
          ? [{ address: opts.target.host, port: opts.target.port, users: [{ user: opts.target.user, pass: opts.target.pass }] }]
          : [{ address: opts.target.host, port: opts.target.port }];
        outbounds.push({
          tag: opts.outboundTag,
          protocol: 'socks',
          settings: { servers },
          streamSettings: { network: 'tcp', security: 'none' },
        });
        changed = true;
      }

      const rules: any[] = cfg.routing.rules;
      // 去重谓词兼容 inboundTag 的单字符串形态（备份恢复/手工编辑/面板自身都认字符串形态，
      // isApiRule 双态兼容 —— string-form-rule 复议 1-of-2 要求）
      const hasRule = rules.some(
        (r: any) =>
          r?.inboundTag === opts.relayTag ||
          (Array.isArray(r?.inboundTag) && r.inboundTag.includes(opts.relayTag)),
      );
      if (!hasRule) {
        // 【catch-all-shadow 对抗复核确认】Xray 路由按顺序首条命中即执行：追加到尾部会被
        // 管理员在此前配置的无 inboundTag 约束 catch-all/分流规则捕获，中转静默失效而 DB
        // 显示已挂载。插到 rules 最前 —— 本条只精确命中本入站，不影响其它入站的判定顺序
        // （面板 EnsureStatsRouting 后续把 api 规则钉到 [0] 时，我们自然退到 [1]，仍在
        // 任何 catch-all 之前）。
        rules.unshift({ type: 'field', inboundTag: [opts.relayTag], outboundTag: opts.outboundTag });
        changed = true;
      }

      if (changed) {
        await this.updateXrayConfig(serverId, cfg, outboundTestUrl);
        this.logger.log(
          `Relay mounted: outbound '${opts.outboundTag}' + rule '${opts.relayTag}' -> '${opts.outboundTag}' on server ${serverId}`,
        );
      }
      return { changed };
    });
  }

  /**
   * 幂等卸载一个节点的 SOCKS 中转（单次读-改-写）：
   * 移除该入站的路由规则；仅当无任何规则仍引用该出站时才移除出站。
   * 确有变更才写回一次，并原样带回面板出站测速 URL。
   */
  async removeRelayMount(
    serverId: number,
    opts: { relayTag?: string; outboundTag?: string },
  ): Promise<{ changed: boolean }> {
    return this.withRelayLock(serverId, async () => {
      const { config, outboundTestUrl } = await this.getXrayConfig(serverId);
      this.assertConfigComplete(config, '卸载'); // 修改前断言（read-only）
      const cfg: any = config;

      let changed = false;
      const rules: any[] = cfg.routing.rules;
      // 命中该作者卸载的入站即删；inboundTag 兼容数组与单字符串两种形态
      const matchesRelay = (r: any) =>
        Boolean(opts.relayTag) &&
        (r?.inboundTag === opts.relayTag ||
          (Array.isArray(r?.inboundTag) && r.inboundTag.includes(opts.relayTag)));
      const filtered = rules.filter((r: any) => !matchesRelay(r));
      if (filtered.length !== rules.length) changed = true;

      // 该出站仍被任何规则引用 → 保留出站（否则 Xray 会用着指向不存在 tag 的规则）
      const stillUsed = filtered.some((r: any) => opts.outboundTag && r?.outboundTag === opts.outboundTag);
      const outbounds: any[] = cfg.outbounds;
      const keptOuts =
        opts.outboundTag && !stillUsed
          ? outbounds.filter((o: any) => o?.tag !== opts.outboundTag)
          : outbounds;
      if (keptOuts.length !== outbounds.length) changed = true;

      if (changed) {
        cfg.outbounds = keptOuts;
        cfg.routing.rules = filtered;
        await this.updateXrayConfig(serverId, cfg, outboundTestUrl);
        this.logger.log(
          `Relay unmounted: rules/outbound for '${opts.relayTag}' / '${opts.outboundTag}' on server ${serverId}`,
        );
      }
      return { changed };
    });
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
