import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { ServerService, XuiResponse } from '../server/server.service';
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
    orderNo?: string;  // 订单号，写入节点备注（激活幂等/后台排查用）
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
      orderNo,
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

    // Traffic quota in bytes（3.6.0 面板客户端 totalGB 字段按【字节】解释，0=不限；
    // 不要换算成 GB —— 换算后 100GiB 套餐会变成几十字节配额，连上就被自动停用）
    const totalGB = plan.traffic > 0 ? Number(plan.traffic) : 0;

    // Client object（3.6.0 客户端是内嵌在每条入站 settings.clients[] 里的一等公民；
    // 原生 UI 创建时客户端直接随入站一起写进 settings。这里同构内嵌，同时仍走
    // /clients/add 注册链接（两路都要，见下方 addInbound 与 addClient 注释））
    const isVless = protocol.toLowerCase() === 'vless';
    const client = {
      id: uuid,
      email,
      limitIp: plan.deviceLimit || 0,
      totalGB,
      expiryTime,
      enable: true,
      tgId: '',
      subId: email.replace(/@node$/, ''),
      reset: 0,
      // VLESS(Reality/TLS) 用 XTLS Vision 流控；不填部分客户端连不上
      flow: isVless ? 'xtls-rprx-vision' : '',
    };

    // Build protocol-specific settings（客户端已内嵌；VLESS 带 flow，其余 flow 为空）
    let settings: string;
    switch (protocol.toLowerCase()) {
      case 'vmess': {
        settings = JSON.stringify({
          clients: [{ ...client }],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'vless': {
        // fork 文档实证：这个面板的配置生成器直接读入站 settings JSON 里的
        // settings.clients[]（delAllClients/groups/bulkAdd 都是 patch 这条 JSON）。
        // 内嵌 = 用户随入站一起出生，重启后必然在运行配置里，不依赖 /clients/add
        // 是否回填 DB——这是「像原生面板创建一样」的关键一步。
        settings = JSON.stringify({
          clients: [{ ...client }],
          decryption: 'none',
          fallbacks: [],
        });
        break;
      }
      case 'trojan': {
        settings = JSON.stringify({
          clients: [{ ...client }],
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

    // ---- Stream settings ----
    // VLESS → VLESS+Reality（系统默认，最小客户端版本 1.0.0）
    // 其它协议 → WebSocket 明文（去掉假证书路径，开箱即用）；SS → 原生 tcp
    let streamSettings: string;
    let reality: {
      dest: string; // host（SNI/本地链接用）
      serverNames: string;
      target: string; // host:port（发面板的 dest）
      privateKey: string;
      publicKey: string;
      shortId: string;
    } | null = null;

    if (isVless) {
      // 系统默认：vless 一律建成 VLESS+Reality（用户硬性要求）：
      //  1) 面板生成 X25519 密钥对（GET /server/getNewX25519Cert）
      //  2) 面板探测 Reality 目标（POST /server/scanRealityTargets），
      //     取延迟最低的可行目标作为 dest/serverNames（用户要求）
      //  3) minVersion=1.0.0 最小客户端版本写死
      // 任一环节失败就地报错、节点不创建 —— 绝不降级成 ws 明文（那会建出不可用节点）
      let key: { privateKey: string; publicKey: string };
      let targetHost = 'www.microsoft.com'; // serverNames / SNI：只放域名
      let targetAddr = 'www.microsoft.com:443'; // dest：必须 host:port（面板「目标」字段格式）
      try {
        key = await this.serverService.getNewX25519Key(serverId);
        // 3.6.0 文档 scanRealityTargets 返回 { host, port, target:"host:port" }：
        //   dest → target（host:port）；裸域名会被面板丢弃回退默认（截图里 dest=example.com:443 就是这么来的）
        //   serverNames/SNI → host（不带端口）
        const t = await this.serverService.pickBestRealityTarget(serverId);
        targetHost = t.host;
        targetAddr = t.target;
      } catch (e) {
        throw new BadRequestException(
          `Reality 初始化失败（x25519 或 目标扫描）：${e.message}。节点未创建，请检查面板连接与 API Token。`,
        );
      }
      const shortId = this.randomHex(8);
      reality = {
        dest: targetHost, // 落库字段：作 SNI / 本地兜底链接的 sni 参数（只存域名）
        serverNames: targetHost,
        target: targetAddr, // 面板 dest 专用（host:port）
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        shortId,
      };
      streamSettings = JSON.stringify({
        network: 'tcp',
        security: 'reality',
        externalProxy: [],
        realitySettings: {
          show: false,
          dest: targetAddr,
          serverNames: [targetHost],
          privateKey: key.privateKey,
          shortIds: [shortId],
          minVersion: '1.0.0', // 字段位①：顶层，兼容部分面板
          minClient: '1.0.0', // 字段位②：Xray-core reality 原生名（minClient/maxClient）
          settings: {
            publicKey: key.publicKey,
            serverName: targetHost,
            fingerprint: 'chrome',
            spiderX: '/',
            minVersion: '1.0.0', // 字段位③：3-x-ui RealitySettings.Settings 模型（面板 UI「最小客户端版本」对应处）
          },
        },
        tcpSettings: { header: { type: 'none' } },
      });
    } else if (protocol.toLowerCase() === 'shadowsocks') {
      streamSettings = JSON.stringify({
        network: 'tcp',
        security: 'none',
        externalProxy: [],
        tcpSettings: { header: { type: 'none' } },
      });
    } else {
      // vmess / trojan → ws 明文（无假证书）
      streamSettings = JSON.stringify({
        network: 'ws',
        security: 'none',
        externalProxy: [],
        wsSettings: {
          path: `/${uuid.slice(0, 8)}-${Date.now().toString(36)}`,
          headers: {},
        },
      });
    }

    // Port allocation：一律随机高位端口 —— 一台 3-xui 服务器要承载大量节点，
    // 443 只有一个、固定偏好会互相抢占，全部走 10000-65535 随机端口（占用则换，有界重试兜底）
    let port = await this.getAvailablePort(serverId);

    const inboundData = {
      up: 0,
      down: 0,
      total: parseInt(plan.traffic.toString()) || 0,
      remark: orderNo ? `Order ${orderNo}` : `user-${user.id}-${protocol}`,
      enable: true,
      expiryTime,
      listen: '',
      port,
      // 面板 oneof 校验只认小写协议名（vless），大写 "VLESS" 会被拒
      protocol: protocol.toLowerCase(),
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
      // 1) 建入站（settings.clients 已内嵌用户）。端口可能被宿主机其它服务占用（尤其 443），命中 already in use
      //    时放弃 443 偏好、改用随机高位端口有界重试，避免每笔订单永久卡死。
      let response: XuiResponse | null = null;
      let xuiInboundId = 0;
      let createdInboundRecord: any = null; // 定位到的入站完整记录（含 streamSettings，供 Reality 验证）
      for (let attempt = 0; attempt < 5; attempt++) {
        inboundData.port = port;
        inboundData.tag = `inbound-${port}`;
        response = await this.serverService.addInbound(serverId, inboundData);
        const id = this.extractInboundId(response);
        if (response?.success) {
          // 3-x-ui 3.6.0 的 /inbounds/add 示例返回 obj: "string"（通常是提示文本），
          // 不保证直接返回入站 ID；因此成功后必须回查 /inbounds/list，按端口/tag/remark 定位新入站。
          xuiInboundId = id;
          if (!xuiInboundId) {
            const located = await this.findCreatedInboundId(serverId, inboundData);
            xuiInboundId = located.id;
            createdInboundRecord = located.record;
          }
          if (xuiInboundId) break;
          response = {
            ...response,
            msg: response?.msg || 'Inbound added, but failed to locate created inbound id',
          };
          break;
        }
        if (!/already in use|in use/i.test(response?.msg || '')) break;
        this.logger.warn(`Port ${port} in use on server ${serverId}, retry with a random high port`);
        port = await this.getAvailablePort(serverId);
      }

      if (!xuiInboundId) {
        // add 已成功但没定位到 id（承载端口已建好入站）—— 尽力回收该空入站，
        // 否则每笔失败订单都会在面板累积一个游离空闲入站
        await this.cleanupOrphanInbound(serverId, inboundData);
        throw new BadRequestException(response?.msg || 'Failed to obtain XUI inbound id');
      }

      // 3-x-ui 3.6.0 原生一致性验证：add 后回读确认 reality + minVersion=1.0.0 真实落库。
      // 面板 DTO 若丢弃字段会在这一环暴露；验证失败→回滚空入站→报错，绝不出货不可用节点。
      if (isVless) {
        const persistedOk = await this.verifyRealityPersisted(
          serverId,
          xuiInboundId,
          createdInboundRecord,
          reality!.target, // 期望 dest（host:port）；isVless 分支必已赋值
        );
        if (!persistedOk) {
          try {
            await this.serverService.deleteInbound(serverId, xuiInboundId);
          } catch {}
          throw new BadRequestException(
            '面板未保存 Reality 配置（需要 security=reality + minVersion=1.0.0 等字段）——节点已回滚，请将后台日志里的 streamSettings 反馈排查',
          );
        }
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
          flow: client.flow || undefined,
        },
        [xuiInboundId],
      );
      if (!clientRes?.success) {
        // 用户已内嵌在 settings.clients 时，clients/add 可能因「已存在」报错
        // ——先探测该邮箱是否真的可用：能取到链接 或 能取到流量记录 都视为已注册，
        // 继续出货；两者都没有才回滚入站。
        let usable = false;
        try {
          const probe = await this.serverService.getClientLinks(serverId, client.email);
          usable = probe?.success && Array.isArray(probe.obj) && probe.obj.length > 0;
        } catch {}
        if (!usable) {
          try {
            const traffic = await this.serverService.getClientTraffic(serverId, client.email);
            usable = traffic?.success === true;
          } catch {}
        }
        if (!usable) {
          try {
            await this.serverService.deleteInbound(serverId, xuiInboundId);
          } catch {}
          throw new BadRequestException(`Failed to add XUI client: ${clientRes?.msg}`);
        }
        this.logger.warn(
          `clients/add 报错（${clientRes?.msg}）但客户端可检索，按已注册继续`,
        );
      }

      // VLESS(Reality/TLS) 客户端补设 Vision 流控（clients/add 不保证接受 flow，用 bulkAdjust 确保）
      if (isVless) {
        try {
          const flowRes = await this.serverService.setClientFlow(serverId, client.email, 'xtls-rprx-vision');
          if (!flowRes?.success) this.logger.warn(`setClientFlow failed: ${flowRes?.msg}`);
        } catch (e) {
          this.logger.warn(`setClientFlow error: ${e.message}`);
        }
      }

      // 回读面板权威状态：clients/add 提交后，面板有权按自身规则重新生成
      // UUID/subId。以面板实际值为准落库，保证本地兜底连接串与面板 UI 完全一致。
      let storedUuid = client.id;
      let storedSubId = client.subId;
      try {
        const readback = await this.serverService.getClientTraffic(serverId, client.email);
        if (readback?.success && readback.obj) {
          if (readback.obj.uuid) storedUuid = readback.obj.uuid;
          if (readback.obj.subId) storedSubId = readback.obj.subId;
        }
      } catch (e) {
        // 回读失败不阻断建节点：继续用我们生成的 uuid/subId（链接走面板 /clients/links 时不受影响）
        this.logger.warn(`Client state readback failed for ${client.email}: ${e.message}`);
      }

      // —— 原生面板一致性关键步骤（此前缺失 ⇒ 建出的节点「面板有记录、Xray 无监听」= 废节点）——
      // 3.6.0 文档 restartXrayService："Reload Xray with the current config. Typically
      // required after structural inbound or routing changes." —— /inbounds/add 只写入面板库，
      // 运行中的 Xray 进程不会自动加载新入站；必须重载才能真正监听该端口。
      // 重载失败（通常是新入站的配置被 Xray 拒收、整个 config 起不来）→ 回滚并再次重载恢复原状。
      try {
        const restartRes = await this.serverService.restartXrayService(serverId);
        if (!restartRes?.success) {
          throw new Error(`Xray reload failed: ${restartRes?.msg || 'unknown'}`);
        }
        // 重载只是命令；再回读运行中(已落盘)的完整配置，确认该入站真的进了运行态，
        // 而不是只有面板库记录。找不到 → 按未启用处理，回滚。
        await this.assertInboundLiveInRunningConfig(
          serverId,
          xuiInboundId,
          port,
          client.email,
          client.id,
        );
        // 顺带抓 Xray 运行期拒绝信息（文档 GET /xray/getXrayResult），配置/目标被运行期
        // 拒收时这里能看到原因；失败不阻断。
        try {
          const xr = await this.serverService.getXrayResult(serverId);
          const xt = JSON.stringify(xr?.obj);
          if (xr?.success && xt && xt !== 'null' && /error|fail|reject|refus|invalid/i.test(xt)) {
            this.logger.warn(`Xray 运行期提示：${xt.slice(0, 600)}`);
          }
        } catch {}
      } catch (e) {
        try {
          await this.serverService.deleteClient(serverId, client.email);
        } catch {}
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        try {
          await this.serverService.restartXrayService(serverId);
        } catch {}
        throw new BadRequestException(
          `Xray 重新加载失败（节点未真正启用，已回滚）：${e.message}`,
        );
      }

      // Save to database（本地落库失败要回滚已建好的 XUI 入站+客户端——
      // 否则 cron 重试会在新端口再建一个节点，面板遗留第一个永久游离节点）
      let inbound: any;
      try {
        inbound = await this.prisma.inbound.create({
          data: {
            userId,
            serverId,
            inboundId: xuiInboundId,
            clientUuid: storedUuid,
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
            realityServerNames: reality ? reality.serverNames : null,
            realityPrivateKey: reality ? reality.privateKey : null,
            realityPublicKey: reality ? reality.publicKey : null,
            realityShortId: reality ? reality.shortId : null,
            realityDest: reality ? reality.dest : null,
            realityMinVersion: reality ? '1.0.0' : null,
            remark: orderNo
              ? `Order ${orderNo}`
              : `Order ${inboundData.remark}`,
          },
        });
      } catch (e) {
        // XUI 侧补偿回滚（仅限本地写失败的场景；勿动 relay 挂载，那发生在落库之后）。
        // 回滚后必须再重载一次 Xray，否则已确认活着的入站从面板库里消失、运行态却还在监听。
        try {
          await this.serverService.deleteClient(serverId, client.email);
        } catch {}
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        try {
          await this.serverService.restartXrayService(serverId);
        } catch {}
        throw e;
      }

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
    // Get existing inbounds from XUI，避开已占用端口
    try {
      const response = await this.serverService.getInbounds(serverId);
      const inbounds = response?.obj || [];
      const usedPorts = new Set(inbounds.map((i: any) => i.port));

      // 随机高位端口（10000-65535）：一台服务器承载多个节点，固定 443 会互相抢占
      for (let i = 0; i < 300; i++) {
        const candidate = 10000 + Math.floor(Math.random() * (65535 - 10000));
        if (!usedPorts.has(candidate)) return candidate;
      }
    } catch (e) {
      this.logger.warn(`Could not fetch inbounds: ${e.message}`);
    }
    return 10000 + Math.floor(Math.random() * (65535 - 10000));
  }

  private extractInboundId(response: any): number {
    // 兼容少数面板/旧版本：有些会把 id 放在 obj.id / obj / id。
    if (typeof response?.obj === 'number') return response.obj;
    if (typeof response?.obj === 'string' && /^\d+$/.test(response.obj.trim())) {
      return Number(response.obj.trim());
    }
    if (response?.obj?.id) return Number(response.obj.id) || 0;
    if (response?.id) return Number(response.id) || 0;
    return 0;
  }

  private async findCreatedInboundId(
    serverId: number,
    inboundData: any,
  ): Promise<{ id: number; record: any | null }> {
    const listRes = await this.serverService.getInbounds(serverId);
    if (!listRes?.success || !Array.isArray(listRes.obj)) {
      this.logger.warn(`Cannot locate created inbound on server ${serverId}: ${listRes?.msg || 'invalid inbounds/list response'}`);
      return { id: 0, record: null };
    }

    const matched = listRes.obj
      .filter((item: any) => {
        const samePort = Number(item?.port) === Number(inboundData.port);
        const sameTag = !inboundData.tag || item?.tag === inboundData.tag;
        const sameRemark = !inboundData.remark || item?.remark === inboundData.remark;
        const sameProtocol = !inboundData.protocol || item?.protocol === inboundData.protocol;
        // 端口是唯一关键；tag/remark/protocol 用来避免极端情况下误匹配。
        return samePort && (sameTag || sameRemark || sameProtocol);
      })
      .sort((a: any, b: any) => Number(b?.id || 0) - Number(a?.id || 0));

    return { id: Number(matched[0]?.id || 0), record: matched[0] || null };
  }

  /**
   * 验证面板真实保存的入站确实是 Reality 且 minVersion=1.0.0 已落库。
   * minVersion 两种字段位都认：顶层 realitySettings.minVersion 或 settings.minVersion
   * （3-x-ui 的 Settings 模型；截图里「最小客户端版本」显示 36.3.27 就是顶层字段不被采纳、按面板默认 xray 版本走了）。
   * dest 必须精确等于本次扫描选出的 target（host:port）——面板若丢弃 dest 会回退默认 example.com:443，这种节点直接判失败。
   * 验证失败返回 false —— 调用方据此回滚，确保绝不交付不可用节点。
   */
  private async verifyRealityPersisted(
    serverId: number,
    inboundId: number,
    record: any | null,
    expectedDest: string,
  ): Promise<boolean> {
    let ss: any = null;
    if (record && typeof record.streamSettings === 'object' && record.streamSettings !== null) {
      ss = record.streamSettings;
    } else {
      // record 缺失（少数面板 add 回执直接给了 id）→ 回查 /inbounds/list 取该入站
      try {
        const listRes = await this.serverService.getInbounds(serverId);
        if (listRes?.success && Array.isArray(listRes.obj)) {
          const found = listRes.obj.find((i: any) => Number(i?.id) === Number(inboundId));
          ss = found?.streamSettings;
        }
      } catch (e) {
        this.logger.warn(`verifyRealityPersisted list fetch failed for inbound #${inboundId}: ${e.message}`);
      }
    }
    const rs = ss?.realitySettings;
    // 最小客户端版本：三种字段位都认（settings.minVersion / 顶层 minVersion / minClient，按该 fork 实际采纳的来）
    const storedMin =
      (rs?.settings?.minVersion ?? rs?.minVersion ?? rs?.minClient ?? rs?.settings?.minClient ?? '') as string;
    const ok =
      ss?.security === 'reality' &&
      storedMin === '1.0.0' &&
      !!rs?.privateKey &&
      Array.isArray(rs?.serverNames) &&
      rs.serverNames.length > 0 &&
      !!expectedDest &&
      rs?.dest === expectedDest;
    if (ok) {
      this.logger.log(
        `Reality 验证通过 inbound #${inboundId}: security=reality, minVersion=${storedMin}, dest=${rs.dest}, serverNames=[${rs.serverNames.join(',')}]`,
      );
    } else {
      this.logger.error(
        `Reality 验证失败 inbound #${inboundId}，期望 dest=${expectedDest}，面板实际 streamSettings=${JSON.stringify(ss ?? null).slice(0, 600)}`,
      );
    }
    return ok;
  }

  /**
   * 重载后回读运行中(已落盘)的 Xray 配置，确认新入站真的进了运行态，
   * 且用户确实内嵌在该入站的 settings.clients[] 里。
   * GET /panel/api/server/getConfigJson 文档：Return the assembled Xray config
   * that's currently running on this host.（obj 是 JSON 字符串）。
   * - 入站不存在（按 tag/端口查）→ 只有面板库记录（废节点）→ 抛错回滚。
   * - 入站在、但 settings.clients[] 里没有该用户 → 这个 fork 的配置生成器没把用户
   *   组装进去 → Xray 跑着一个 0 用户的入站，和废节点毫无区别 → 抛错回滚。
   * 回读接口本身失败不阻断（restartXrayService 已是最强证据，这里只做增量确认）。
   */
  private async assertInboundLiveInRunningConfig(
    serverId: number,
    inboundId: number,
    port: number,
    expectedEmail: string,
    expectedUuid?: string,
  ) {
    let raw: any;
    try {
      const res = await this.serverService.getRunningConfigJson(serverId);
      raw = typeof res?.obj === 'string' ? res.obj : res?.obj != null ? JSON.stringify(res.obj) : '';
    } catch (e) {
      this.logger.warn(`getConfigJson failed on server ${serverId}: ${e.message}`);
      return;
    }
    if (!raw) return;
    try {
      const cfg = JSON.parse(raw);
      const inbounds = Array.isArray(cfg?.inbounds) ? cfg.inbounds : [];
      const found = inbounds.find(
        (i: any) =>
          (typeof i?.tag === 'string' && i.tag === `inbound-${port}`) ||
          (Number(i?.port) === port && typeof i?.protocol === 'string'),
      );
      if (!found) {
        throw new Error(`运行配置中未找到 inbound#${inboundId}(port=${port})`);
      }
      let fClients: any[] = [];
      try {
        const fSettings =
          typeof found?.settings === 'string' ? JSON.parse(found.settings) : found?.settings;
        fClients = Array.isArray(fSettings?.clients) ? fSettings.clients : [];
      } catch (e) {
        throw new Error(`运行配置入站 #${inboundId} settings 解析失败：${(e as Error)?.message}`);
      }
      const hasUser = fClients.some(
        (c: any) =>
          (expectedEmail && typeof c?.email === 'string' && c.email === expectedEmail) ||
          (expectedUuid && (c?.id === expectedUuid || c?.password === expectedUuid)),
      );
      this.logger.log(
        `入站 inbound #${inboundId} 已确认进入 Xray 运行配置（port=${port}，用户 ${expectedEmail} 嵌入=${hasUser ? 'YES' : 'NO'}）`,
      );
      if (!hasUser) {
        throw new Error(
          `运行配置入站 #${inboundId}(port=${port}) 中缺少客户端 ${expectedEmail} —— 配置生成器未组装用户`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('运行配置')) throw e;
      this.logger.warn(`运行配置解析失败: ${(e as Error)?.message}`);
    }
  }

  /**
   * 尽力回收「add 已成功但定位失败」的空入站。
   * 仅按端口匹配（该端口就是本次 add 刚刚建出的），删除由面板回执不可用导致的游离节点。
   */
  private async cleanupOrphanInbound(serverId: number, inboundData: any) {
    try {
      const listRes = await this.serverService.getInbounds(serverId);
      if (!listRes?.success || !Array.isArray(listRes.obj)) return;
      const orphan = listRes.obj
        .filter((item: any) => Number(item?.port) === Number(inboundData.port))
        .sort((a: any, b: any) => Number(b?.id || 0) - Number(a?.id || 0))[0];
      if (orphan?.id) {
        await this.serverService.deleteInbound(serverId, orphan.id);
        this.logger.warn(
          `Orphan inbound port=${inboundData.port} (id=${orphan.id}) cleaned up on server ${serverId}`,
        );
      }
    } catch (e) {
      this.logger.warn(`Orphan cleanup failed on server ${serverId}: ${e.message}`);
    }
  }

  private randomHex(length: number): string {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
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
    // 客户端 UUID：优先用落库的 clientUuid（settings.clients 是空的，内嵌无值）
    const uuid = inbound.clientUuid || client?.id || client?.password || '';
    const security = streamSettings?.security || 'none';
    const isReality = security === 'reality';

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
          net: streamSettings?.network || 'tcp',
          type: 'none',
          host: '',
          path: wsPath,
          tls: 'none',
          sni: '',
        };
        url = `vmess://${Buffer.from(JSON.stringify(vmessConfig)).toString('base64')}`;
        break;
      }
      case 'vless': {
        const params: Record<string, string> = {
          encryption: 'none',
          type: streamSettings?.network || 'tcp',
          headerType: 'none',
        };
        if (isReality) {
          // VLESS + Reality
          params.security = 'reality';
          params.flow = 'xtls-rprx-vision';
          params.fp = 'chrome';
          params.pbk = inbound.realityPublicKey || '';
          params.sni = inbound.realityDest || '';
          params.sid = inbound.realityShortId || '';
          const frag = `${server.name}-reality`;
          url = `vless://${uuid}@${host}:${port}?${new URLSearchParams(params).toString()}#${frag}`;
          break;
        }
        // VLESS + ws 明文
        params.security = 'none';
        params.path = wsPath;
        params.host = '';
        url = `vless://${uuid}@${host}:${port}?${new URLSearchParams(params).toString()}#${server.name}-vless`;
        break;
      }
      case 'trojan': {
        const params = new URLSearchParams({
          type: streamSettings?.network || 'tcp',
          security: 'none',
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

  /**
   * 校验面板返回的连接串是否真正可用。
   * Reality 链接缺 pbk/sid/sni（或 security 不对）→ 用户复制后必然连不上；
   * 与其出货坏链接，不如过滤掉，让调用方回退到我们自己的本地 builder（数据自写、受控）。
   */
  private isUsableLink(url: string, inbound: any): boolean {
    if (typeof url !== 'string' || !url) return false;
    try {
      const idx = url.indexOf('://');
      if (idx === -1) return false;
      const rest = url.slice(idx + 3);
      const queryStart = rest.indexOf('?');
      if (inbound.protocol === 'vless') {
        if (queryStart === -1) return false; // vless 无查询串必废
        const params = new URLSearchParams(rest.slice(queryStart));
        const security = params.get('security');
        if (security === 'reality') {
          return ['pbk', 'sid', 'sni'].every((k) => !!params.get(k)) && params.get('type') === 'tcp';
        }
        return security === 'none' && !!params.get('type'); // vless+ws
      }
      // vmess / trojan / ss 无查询串或查询串非关键，面板生成即可信
      return true;
    } catch (e) {
      return false;
    }
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

    // Enrich with connection links. 3-x-ui 3.6.0 provides the canonical URL generator:
    // GET /panel/api/clients/links/{email}. Use it first so Reality/WS/TLS parameters match the panel UI.
    return Promise.all(
      inbounds.map(async (inbound) => this.enrichInboundForResponse(inbound)),
    );
  }

  private async enrichInboundForResponse(inbound: any) {
    let urls: string[] = [];

    try {
      const linkRes = await this.serverService.getClientLinks(inbound.serverId, inbound.email);
      if (linkRes?.success && Array.isArray(linkRes.obj)) {
        urls = linkRes.obj.filter((url: any) => this.isUsableLink(url, inbound));
      } else if (linkRes && !linkRes.success) {
        this.logger.warn(`Failed to fetch client links for ${inbound.email}: ${linkRes.msg}`);
      }
    } catch (e) {
      this.logger.warn(`Failed to fetch client links for ${inbound.email}: ${e.message}`);
    }

    if (urls.length === 0) {
      try {
        const localLink = this.generateConnectionLink(inbound, inbound.server);
        urls = localLink.url ? [localLink.url] : [];
      } catch (e) {
        this.logger.warn(`Failed to generate fallback link for ${inbound.email}: ${e.message}`);
      }
    }

    const totalTraffic = Number(inbound.totalTraffic || 0);
    return {
      ...inbound,
      totalTraffic,
      trafficUsed: totalTraffic,
      connectionUrl: urls[0] || '',
      connectionUrls: urls,
      qrData: urls[0] || '',
    };
  }
  async findById(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const inbound = await this.prisma.inbound.findFirst({
      where,
      include: { server: true },
    });
    if (!inbound) throw new NotFoundException('Inbound not found');

    return this.enrichInboundForResponse(inbound);
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
          // 面板端停用客户端（启用切到停用用 bulkEnable/bulkDisable 原生端点，
          //  不用 /clients/update/{email} —— 那是全量替换不是 patch，会把
          //  totalGB/expiryTime 清空）
          //  仅当客户端当前是启用状态才调用，避免重复调用
          const clientEnabled = traffic?.obj?.enable !== false;
          if (inbound.status === 'ACTIVE' && clientEnabled) {
            const res = await this.serverService.setClientEnabled(
              inbound.serverId,
              inbound.email,
              false,
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

    // Suspend in XUI — 用原生 bulkDisable（update/{email} 是全量替换，只传 enable 会清字段）
    try {
      await this.serverService.setClientEnabled(inbound.serverId, inbound.email, false);
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

    // Resume in XUI — 用原生 bulkEnable（update/{email} 是全量替换，只传 enable 会清字段）
    try {
      await this.serverService.setClientEnabled(inbound.serverId, inbound.email, true);
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


