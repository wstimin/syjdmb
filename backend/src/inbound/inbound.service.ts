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

    // 客户端限额（3.6.0 面板客户端 totalGB 字段按【字节】解释，0=不限；
    // 不要换算成 GB —— 换算后 100GiB 套餐会变成几十字节配额，连上就被自动停用）
    const expiryTime =
      plan.duration > 0 ? Date.now() + plan.duration * 24 * 3600 * 1000 : 0;
    const totalGB = plan.traffic > 0 ? Number(plan.traffic) : 0;

    const isVless = protocol.toLowerCase() === 'vless';

    // ---- Reality 初始化（vless 系统默认）：完全复刻 3.6.0 手动创建流程 ----
    // 安全 → Reality → 「查找目标」选延迟最低的可行目标 → 最小客户端 1.0.0
    // 任一环节失败就地报错、节点不创建 —— 绝不降级成 ws 明文（那会建出不可用节点）
    let reality: {
      dest: string; // host（serverNames/SNI/本地链接用，只放纯域名）
      serverNames: string;
      target: string; // host:port（发面板的 dest，必须是真实可拨号目标）
      privateKey: string;
      publicKey: string;
      shortId: string;
    } | null = null;
    if (isVless) {
      try {
        const key = await this.serverService.getNewX25519Key(serverId);
        const t = await this.serverService.pickBestRealityTarget(serverId);
        reality = {
          dest: t.host,
          serverNames: t.host,
          target: t.target,
          privateKey: key.privateKey,
          publicKey: key.publicKey,
          shortId: this.randomHex(8),
        };
      } catch (e) {
        throw new BadRequestException(
          `Reality 初始化失败（x25519 或 目标扫描）：${e.message}。节点未创建，请检查面板连接与 API Token。`,
        );
      }
    }

    // ---- 面板备注：跟随服务器设置的名字 + 1-100 顺序号（如 香港1 / HK3）----
    // 与 3.6.0 手动建入站「备注」行为一致；仅用于面板侧标识。
    const panelRemark = await this.computeRemark(server);

    // ---- settings：两段式建客户端。入站先不带任何用户（clients: []）----
    // 与 3.6.0 手动流程一致：先建入站 → 再建客户端并绑定。客户端 UUID/subId/流控
    // 都不在入站里内嵌，全部由后续 clients/add + bulkAdjust 完成（面板服务端生成）。
    const settings = {
      clients: [],
      decryption: 'none',
      fallbacks: [],
    };

    // ---- Stream settings ----
    // VLESS → VLESS+Reality（fork 真名 minClientVer/maxClientVer/maxTimeDiff）
    // 其它协议 → WebSocket 明文（去掉假证书路径，开箱即用）；SS → 原生 tcp
    let streamSettings: any;
    if (isVless) {
      streamSettings = {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          show: false,
          dest: reality!.target, // 目标：延迟最低的可行目标（host:port，扫描结果原样）
          serverNames: [reality!.dest], // serverNames/SNI：纯域名
          privateKey: reality!.privateKey,
          shortIds: [reality!.shortId],
          minClientVer: '1.0.0', // 最小客户端版本（fork 字段名，面板 UI「最小客户端」对应处）
          maxClientVer: '',
          maxTimeDiff: 0,
          xver: 0,
          settings: {
            publicKey: reality!.publicKey,
            serverName: reality!.dest,
            fingerprint: 'chrome',
            spiderX: '/',
          },
        },
        tcpSettings: { header: { type: 'none' } },
      };
    } else if (protocol.toLowerCase() === 'shadowsocks') {
      streamSettings = {
        network: 'tcp',
        security: 'none',
        tcpSettings: { header: { type: 'none' } },
      };
    } else {
      // vmess / trojan → ws 明文（无假证书）
      streamSettings = {
        network: 'ws',
        security: 'none',
        wsSettings: {
          path: `/${uuidv4().slice(0, 8)}-${Date.now().toString(36)}`,
          headers: {},
        },
      };
    }

    // Port allocation：随机高位端口 —— 一台 3-xui 服务器要承载大量节点，
    // 全部走 10000-65535 随机端口（占用则换，有界重试兜底）
    let port = await this.getAvailablePort(serverId);

    // 3.6.0 文档 /inbounds/add 入站：10 个扁平字段、无 tag（面板自动生成 in-<port>-tcp）、
    // settings/streamSettings/sniffing 用嵌套对象（文档「preferred」格式）、
    // 入站级 expiryTime/total 都是 0 —— 到期/限额放在客户端层，由 clients/add 下发。
    // sniffing 取文档示例值 {enabled:true, destOverride:["http","tls"]}。
    const inboundData = {
      enable: true,
      remark: panelRemark,
      listen: '',
      port,
      // 面板 oneof 校验只认小写协议名（vless），大写 "VLESS" 会被拒
      protocol: protocol.toLowerCase(),
      expiryTime: 0,
      total: 0,
      settings,
      streamSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    };

    try {
      // 1) 建入站（settings.clients 为空）。端口可能被宿主机其它服务占用，命中 already in use
      //    时换随机高位端口有界重试，避免每笔订单永久卡死。
      let response: XuiResponse | null = null;
      let xuiInboundId = 0;
      let createdInboundRecord: any = null; // 定位到的入站完整记录（含 streamSettings/tag，供验证+relay）
      for (let attempt = 0; attempt < 5; attempt++) {
        inboundData.port = port;
        response = await this.serverService.addInbound(serverId, inboundData);
        const id = this.extractInboundId(response);
        if (response?.success) {
          // 3.6.0 的 /inbounds/add 示例返回 obj: "string"（通常是提示文本），不保证直接返回入站 ID；
          // 成功后必须回查 /inbounds/list，按端口 + 备注定位新入站（不提交 tag，靠 remark 兜底）。
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
      // 面板自动生成的入站 tag：3.6.0 格式 in-<port>-tcp（/inbounds/list 实测示例）。
      // relay 路由规则的 inboundTag 与运行配置断言都用它，不是自造的 inbound-<port>。
      const actualTag =
        typeof createdInboundRecord?.tag === 'string' && createdInboundRecord.tag
          ? createdInboundRecord.tag
          : `in-${port}-tcp`;

      if (!xuiInboundId) {
        // add 已成功但没定位到 id（承载端口已建好入站）—— 尽力回收该空入站，
        // 否则每笔失败订单都会在面板累积一个游离空闲入站
        await this.cleanupOrphanInbound(serverId, inboundData);
        throw new BadRequestException(response?.msg || 'Failed to obtain XUI inbound id');
      }

      // 3.6.0 原生一致性验证：add 后回读确认 reality + minClientVer=1.0.0 真实落库。
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
            '面板未保存 Reality 配置（需要 security=reality + minClientVer=1.0.0 等字段）——节点已回滚，请将后台日志里的 streamSettings 反馈排查',
          );
        }
      }

      // 2) 重载 Xray：/inbounds/add 只写入面板库，运行中的 Xray 不会自动加载新入站；
      //    3.6.0 文档 restartXrayService 原话 "Typically required after structural inbound
      //    or routing changes"。重载失败（通常新入站配置被 Xray 拒收）→ 回滚并再次重载恢复原状。
      try {
        const restartRes = await this.serverService.restartXrayService(serverId);
        if (!restartRes?.success) {
          throw new Error(`Xray reload failed: ${restartRes?.msg || 'unknown'}`);
        }
      } catch (e) {
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

      // 3) 建客户端并绑定到该入站（3.6.0 文档 clients/add：只传通用字段，UUID/subId/flow
      //    一律不传 —— UUID/subId 由面板服务端生成，flow 走下一步 bulkAdjust）。
      //    与手动流程一致：创建客户端 → 设流控 → 绑定新建节点（inboundIds=[xuiInboundId]）
      const clientRes = await this.serverService.addClient(
        serverId,
        {
          email,
          totalGB,
          expiryTime,
          limitIp: plan.deviceLimit || 0,
          enable: true,
        },
        [xuiInboundId],
      );
      if (!clientRes?.success) {
        // 双保险：客户端是否真的注册成功（能取到流量记录 或 能取到链接）
        let usable = false;
        try {
          const traffic = await this.serverService.getClientTraffic(serverId, email);
          usable = traffic?.success === true;
        } catch {}
        if (!usable) {
          try {
            const probe = await this.serverService.getClientLinks(serverId, email);
            usable = probe?.success && Array.isArray(probe.obj) && probe.obj.length > 0;
          } catch {}
        }
        if (!usable) {
          try {
            await this.serverService.deleteClient(serverId, email);
          } catch {}
          try {
            await this.serverService.deleteInbound(serverId, xuiInboundId);
          } catch {}
          throw new BadRequestException(`Failed to add XUI client: ${clientRes?.msg}`);
        }
        this.logger.warn(
          `clients/add 报错（${clientRes?.msg}）但客户端可检索，按已注册继续`,
        );
      }

      // 4) VLESS 客户端流控：xtls-rprx-vision（手动流程「流控设置」一步，bulkAdjust 原生端点）。
      //    流控设置失败 = 客户端可能连不上（半废节点），直接回滚。
      if (isVless) {
        try {
          const flowRes = await this.serverService.setClientFlow(serverId, email, 'xtls-rprx-vision');
          if (!flowRes?.success) throw new Error(`setClientFlow failed: ${flowRes?.msg}`);
        } catch (e) {
          try {
            await this.serverService.deleteClient(serverId, email);
          } catch {}
          try {
            await this.serverService.deleteInbound(serverId, xuiInboundId);
          } catch {}
          try {
            await this.serverService.restartXrayService(serverId);
          } catch {}
          throw new BadRequestException(
            `流控设置失败（XTLS Vision 未生效，节点已回滚）：${e.message}`,
          );
        }
      }

      // 5) 回读面板权威状态：UUID/subId 由面板生成（clients/add 未传），必须回读才能拼连接串。
      //    getClientTraffic 返回 { uuid, subId }；失败则从 /clients/links 的 vless:// 里解析。
      //    两种都拿不到 = 无法向用户交付连接串 → 视为建节点失败，回滚。
      let storedUuid = '';
      let storedSubId = '';
      try {
        const readback = await this.serverService.getClientTraffic(serverId, email);
        if (readback?.success && readback.obj) {
          storedUuid = readback.obj.uuid || '';
          storedSubId = readback.obj.subId || '';
        }
      } catch (e) {
        this.logger.warn(`Client state readback failed for ${email}: ${e.message}`);
      }
      if (!storedUuid) {
        try {
          const links = await this.serverService.getClientLinks(serverId, email);
          const first = Array.isArray(links?.obj)
            ? links.obj.find((u: any) => typeof u === 'string' && u.startsWith('vless://'))
            : null;
          const m = typeof first === 'string' ? first.match(/^vless:\/\/([^@]+)@/) : null;
          if (m && m[1]) storedUuid = m[1];
        } catch {}
      }
      if (!storedUuid && !storedSubId) {
        try {
          await this.serverService.deleteClient(serverId, email);
        } catch {}
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        try {
          await this.serverService.restartXrayService(serverId);
        } catch {}
        throw new BadRequestException('回读客户端 UUID/subId 失败（节点已回滚）');
      }

      // 6) 运行态最终断言（重载+clients/add+bulkAdjust 之后）：回读运行中(已落盘)的完整
      //    Xray 配置，确认入站在运行态、客户端嵌进来了、VLESS 带 Vision 流控。
      //    文档注明客户端级变更（clients/add / bulkAdjust）会自动更新运行中的 Xray，
      //    无需再手动重启。找不到 → 按未启用处理，回滚。
      try {
        await this.assertInboundLiveInRunningConfig(
          serverId,
          xuiInboundId,
          port,
          email,
          storedUuid,
          isVless,
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
          await this.serverService.deleteClient(serverId, email);
        } catch {}
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        try {
          await this.serverService.restartXrayService(serverId);
        } catch {}
        throw new BadRequestException(
          `节点未进入 Xray 运行配置（已回滚）：${e.message}`,
        );
      }

      // 7) Save to database（本地落库：settings/streamSettings 存 JSON 字符串供本地拼接连接串；
      //    备注存订单号用于幂等，与面板 remark 完全无关。落库失败要回滚已建好的 XUI 入站+客户端
      //    —— 否则 cron 重试会在新端口再建一个节点，面板遗留第一个永久游离节点）
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
            settings: JSON.stringify(settings),
            streamSettings: JSON.stringify(streamSettings),
            trafficLimit: plan.traffic,
            expiryTime: plan.duration > 0 ? new Date(expiryTime) : null,
            speedLimit: plan.speedLimit,
            relayEnabled: relay,
            relayTag: relay ? actualTag : null,
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
            remark: orderNo ? `Order ${orderNo}` : null,
          },
        });
      } catch (e) {
        // XUI 侧补偿回滚（仅限本地写失败的场景；勿动 relay 挂载，那发生在落库之后）。
        // 回滚后必须再重载一次 Xray，否则已确认活着的入站从面板库里消失、运行态却还在监听。
        try {
          await this.serverService.deleteClient(serverId, email);
        } catch {}
        try {
          await this.serverService.deleteInbound(serverId, xuiInboundId);
        } catch {}
        try {
          await this.serverService.restartXrayService(serverId);
        } catch {}
        throw e;
      }

      // 8) 购买时勾选中转：在该源节点上挂 SOCKS 出站（指向用户填的 SOCKS 节点，出口 = 该 SOCKS IP）
      //    + 一条只命中该节点端口的路由规则（inboundTag = 面板真实 tag）。不新增节点；节点全程走 SOCKS。
      if (relay) {
        await this.mountRelayOnNode(serverId, port, actualTag, {
          host: relaySocksHost,
          port: relaySocksPort,
          user: relaySocksUser,
          pass: relaySocksPass,
        });
      }

      this.logger.log(
        `Inbound created: ${email} port=${port} remark=${panelRemark} on server ${server.name}`,
      );
      return inbound;
    } catch (error) {
      this.logger.error(`Failed to create inbound: ${error.message}`);
      throw new BadRequestException(`Failed to create inbound: ${error.message}`);
    }
  }

  /**
   * 面板备注 = 服务器设置的名字 + 1-100 顺序号（如 香港1 / HK3），与手动创建一致。
   * 遍历该服务器面板上所有入站，按 remark 前缀匹配服务器名，取 1..100 中第一个空位：
   *  香港1、香港2…香港N 已存在 → 返回下一个未占用序号；100 个全占 → 报错拒绝创建。
   * 读面板列表失败不阻断（仅回退到「服务器名」本身），保证建节点主流程稳。
   */
  private async computeRemark(server: { id: number; name: string }): Promise<string> {
    const name = (server.name || 'Node').trim();
    const used = new Set<number>();
    try {
      const res = await this.serverService.getInbounds(server.id);
      const list = Array.isArray(res?.obj) ? res.obj : [];
      // 匹配「服务器名 数字」（允许中间空白，兼容手建的 香港 1）
      const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\d{1,3})$`);
      for (const item of list) {
        const m = typeof item?.remark === 'string' ? item.remark.match(re) : null;
        if (m) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 100) used.add(n);
        }
      }
    } catch (e) {
      this.logger.warn(`computeRemark list fetch failed for server ${server.id}: ${e.message}`);
    }
    for (let n = 1; n <= 100; n++) {
      if (!used.has(n)) return `${name}${n}`;
    }
    throw new BadRequestException(
      `服务器「${name}」节点数已达上限 100，无法继续创建（可删除部分旧节点后重试）`,
    );
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
    actualTag: string, // 面板真实入站 tag（in-<port>-tcp）：路由规则 inboundTag 用它
    socks: { host?: string; port?: number; user?: string; pass?: string },
  ) {
    if (!socks.host || !socks.port) {
      throw new BadRequestException(
        '开启中转需要填写 SOCKS 节点的地址和端口',
      );
    }

    const relayTag = actualTag;
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
   * 验证面板真实保存的入站确实是 Reality 且 minClientVer=1.0.0 已落库。
   * 最小客户端版本四种字段位都认（fork 真名 minClientVer 顶层/nested settings，
   * 兼容旧名 settings.minVersion / 顶层 minVersion / minClient —— 按面板实际采纳的来）。
   * dest 必须精确等于本次扫描选出的 target（host:port）——面板若丢弃 dest 会回退默认 example.com:443，直接判失败。
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
    // 最小客户端版本：fork 字段名 minClientVer（顶层或 nested settings），旧名兜底
    const storedMin =
      (rs?.minClientVer ??
        rs?.settings?.minClientVer ??
        rs?.settings?.minVersion ??
        rs?.minVersion ??
        rs?.minClient ??
        '') as string;
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
        `Reality 验证通过 inbound #${inboundId}: security=reality, minClientVer=${storedMin}, dest=${rs.dest}, serverNames=[${rs.serverNames.join(',')}]`,
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
    expectedVisionFlow?: boolean,
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
          (typeof i?.tag === 'string' &&
            (i.tag === `inbound-${port}` || i.tag === `in-${port}-tcp`)) ||
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
      const hasVisionFlow =
        expectedVisionFlow === true &&
        fClients.some(
          (c: any) =>
            (c?.email && c.email === expectedEmail) &&
            typeof c?.flow === 'string' &&
            c.flow === 'xtls-rprx-vision',
        );
      this.logger.log(
        `入站 inbound #${inboundId} 已确认进入 Xray 运行配置（port=${port}，用户 ${expectedEmail} 嵌入=${hasUser ? 'YES' : 'NO'}${expectedVisionFlow ? `，Vision 流控=${hasVisionFlow ? 'YES' : 'NO'}` : ''}）`,
      );
      if (!hasUser) {
        throw new Error(
          `运行配置入站 #${inboundId}(port=${port}) 中缺少客户端 ${expectedEmail} —— 配置生成器未组装用户`,
        );
      }
      if (expectedVisionFlow === true && !hasVisionFlow) {
        throw new Error(
          `运行配置入站 #${inboundId}(port=${port}) 中客户端 ${expectedEmail} 未带 Vision 流控 —— 流控未生效`,
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


