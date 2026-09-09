import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { ServerService, XuiResponse } from '../server/server.service';
import { EmailService } from '../email/email.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private prisma: PrismaService,
    private serverService: ServerService,
    private emailService: EmailService,
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
      shortIds: string[]; // 复刻面板 RandomUtil.randomShortIds() 的完整列表
      shortId: string; // 本地连接串 sid 用第一个
    } | null = null;
    if (isVless) {
      try {
        const key = await this.serverService.getNewX25519Key(serverId);
        const t = await this.serverService.pickBestRealityTarget(serverId);
        // shortIds 完全复刻面板手动流程：RandomUtil.randomShortIds() = 偶数长度
        // 2..16 位 hex 各生成一个、乱序排列（手动创建 Reality 时面板自动预填这一串）。
        const shortIdList = this.randomShortIds();
        reality = {
          dest: t.host,
          serverNames: t.host,
          target: t.target,
          privateKey: key.privateKey,
          publicKey: key.publicKey,
          shortIds: shortIdList,
          shortId: shortIdList[0],
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
    // decryption + encryption 都是「none」——手动建 VLESS 默认值（面板 createDefaultVlessInboundSettings）。
    const settings = {
      clients: [],
      decryption: 'none',
      encryption: 'none',
      fallbacks: [],
    };

    // ---- Stream settings ----
    // VLESS → VLESS+Reality（v3.6.0 面板真实字段名：target/maxTimediff/minClientVer）
    // 其它协议 → WebSocket 明文（去掉假证书路径，开箱即用）；SS → 原生 tcp
    let streamSettings: any;
    if (isVless) {
      streamSettings = {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          show: false,
          target: reality!.target, // 目标：延迟最低的可行目标（host:port，v3.6.0 面板真实字段名，非 'dest'）
          serverNames: [reality!.dest], // serverNames/SNI：纯域名
          privateKey: reality!.privateKey,
          shortIds: reality!.shortIds, // 面板 RandomUtil.randomShortIds() 同款（2..16 位偶数 hex 乱序）
          minClientVer: '1.0.0', // 最小客户端版本（面板 UI「最小客户端」对应处）
          maxClientVer: '',
          maxTimediff: 0,         // v3.6.0 面板真实字段名（小写 diff，不是 maxTimeDiff）
          xver: 0,
          settings: {
            publicKey: reality!.publicKey,
            serverName: reality!.dest,
            fingerprint: 'chrome',
            spiderX: this.randomSpiderX(), // 面板 randomizeSpiderX 同款：'/' + 15 位大小写+数字
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

      // 3) 建客户端并绑定到该入站（3.6.0 面板 clients/add）。
      //    手动创建流程在客户端表单里预填：UUID=randomUUID、密码=16 位小写字母+数字、
      //    认证（Hysteria）=16 位随机、订阅ID=16 位随机。面板服务端对 VLESS 只自动补 UUID，
      //    不会补 password/auth —— 所以我们自己按手动流程生成并随 clients/add 下发，
      //    否则面板新建的客户端密码/认证为空（半废节点）。
      //    流控（flow=xtls-rprx-vision）不走 add（文档：add 不含 flow），由下一步 bulkAdjust 设。
      const clientUuid = uuidv4();
      const clientPassword = this.randomLowerAndNum(16); // 与面板前端 RandomUtil.randomLowerAndNum(16) 同格式
      const clientAuth = this.randomLowerAndNum(16); // Hysteria 认证（手动流程同样预填 16 位）
      const clientSubId = this.randomLowerAndNum(16);
      const clientRes = await this.serverService.addClient(
        serverId,
        {
          email,
          totalGB,
          expiryTime,
          tgId: 0,
          limitIp: plan.deviceLimit || 0,
          enable: true,
          id: clientUuid,          // VLESS UUID（手动流程 randomUUID）
          subId: clientSubId,      // 订阅ID（手动流程 16 位随机）
          password: clientPassword, // 客户端密码（手动流程预填，面板才能显示）
          auth: clientAuth,         // Hysteria 认证（手动流程预填，面板才能显示）
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
            // 订阅周期制：周期基础额度=套餐流量；周期切换点=到期日（含流量且有时长才有切换语义）。
            // 到期续费只顺延到期日不动切换点；周期切换时 cron 清零已用、额度回归 periodQuota。
            periodQuota: plan.traffic,
            trafficResetAt: plan.traffic > 0 && plan.duration > 0 ? new Date(expiryTime) : null,
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
        try {
          await this.mountRelayOnNode(serverId, port, actualTag, {
            host: relaySocksHost,
            port: relaySocksPort,
            user: relaySocksUser,
            pass: relaySocksPass,
          });
        } catch (e) {
          // 【zombie-create 对抗复核(2/2)】挂载失败必须全量回滚：
          // 否则 DB 已有一行 remark=Order <n> 的节点但面板从未挂上 relay —— order.service 的
          // 防重复建节点按 remark 查到此行会把订单直接置 COMPLETED，用户拿到「已中转」实为直连
          // 的节点；且 cron 重试会在新端口再建一个重复节点。回滚 DB 行 + 面板入站/客户端 +
          // 尽力清除模板上已写出的挂载，再抛错让 cron 下一轮干净重试。
          try {
            // 【复核488】单层兜底，不再双吞错（try{} 包 .catch(()=>{}) 会连日志都吞掉）：
            // 失败要留下 warn 痕迹 —— 否则模板残留脏规则/孤儿出站没人知道，
            // removeRelayMount 的「无规则引用才删出站」逻辑也会因规则没删掉永不清理。
            await this.serverService.removeRelayMount(serverId, {
              relayTag: actualTag,
              outboundTag: `socks-${port}`,
            });
          } catch (e) {
            this.logger.warn(
              `Rollback: failed to unmount relay ${actualTag} on server ${serverId}: ${e?.message || e} (panel template may retain dirty routing rules)`,
            );
          }
          try {
            await this.prisma.inbound.delete({ where: { id: inbound.id } });
          } catch {}
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
            `中转挂载失败，已回滚新建节点：${(e as Error).message}`,
          );
        }
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
        '开启出站需要填写 SOCKS 节点的地址和端口',
      );
    }

    const relayTag = actualTag;
    const outboundTag = `socks-${port}`;

    // 单次读-改-写（出站 + 路由合并一次写回）：分步实现会因面板 obj 形态解析失败
    // 而读到空配置写回，把面板全部出站/路由清空（只剩 api 规则）。读不完整直接抛错。
    await this.serverService.ensureRelayMount(serverId, {
      relayTag,
      outboundTag,
      target: { host: socks.host, port: socks.port, user: socks.user, pass: socks.pass },
    });
    // 【double-restart 对抗复核(2/2)】不再自行重启：3.6.0 的 /xray/update 保存成功后自己
    // RestartXray(false)——仅 outbounds/routing 变化时走 gRPC tryHotApply 零停机热应用，否则
    // 整进程重启。我们再强制 stop+start 会把面板已热应用的变更回滚成一次全机闪断（每次挂/
    // 卸载都双重重启）。面板保存/应用失败时 updateXrayConfig 已因 success=false 抛错上抛，
    // 挂载绝不会「静默成功实则未生效」（对应 restart-ignored 的上抛要求一并覆盖）。
    this.logger.log(
      `Relay mounted on source node ${relayTag} -> ${outboundTag} (${socks.host}:${socks.port}) on server ${serverId}`,
    );
  }

  /**
   * 移除【源节点】上的 SOCKS 中转：单次读-改-写，删该节点的路由规则 + 专属出站。
   * 配置确有变更时重启 Xray。
   */
  private async unmountRelayFromNode(serverId: number, inbound: any) {
    await this.serverService.removeRelayMount(serverId, {
      relayTag: inbound.relayTag || undefined,
      outboundTag: inbound.relaySocksOutboundTag || undefined,
    });
    // 同 mount：面板 /xray/update 保存成功后自建应用（热应用/整重启），不再自行二次重启。
    // 失败已由 updateXrayConfig 抛错上抛（delete-swallow 修正在 delete() 拦截）。
    this.logger.log(`Relay unmounted from ${inbound.relayTag} (server ${serverId})`);
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
    // 最小客户端版本：面板字段名 minClientVer（顶层或 nested settings），旧名兜底
    const storedMin =
      (rs?.minClientVer ??
        rs?.settings?.minClientVer ??
        rs?.settings?.minVersion ??
        rs?.minVersion ??
        rs?.minClient ??
        '') as string;
    // 目标：V3.6.0 写入字段是 target；回读时前端把 target——dest 别名映射为 dest。
    // 两处任一命中即视为已持久化（dest 是目标别名，面板落库以 target 为准）。
    const storedTarget = (rs?.target ?? rs?.dest ?? '') as string;
    // Short IDs / SpiderX：面板手动流程预填的随机值，必须真实落库（否则连不上/半废）。
    const storedShortIds = Array.isArray(rs?.shortIds) ? rs?.shortIds : [];
    const storedSpiderX = (rs?.settings?.spiderX ?? rs?.spiderX ?? '') as string;
    const ok =
      ss?.security === 'reality' &&
      storedMin === '1.0.0' &&
      !!rs?.privateKey &&
      Array.isArray(rs?.serverNames) &&
      rs.serverNames.length > 0 &&
      !!expectedDest &&
      storedTarget === expectedDest &&
      storedShortIds.length > 0 &&
      !!storedSpiderX;
    if (ok) {
      this.logger.log(
        `Reality 验证通过 inbound #${inboundId}: security=reality, minClientVer=${storedMin}, dest=${storedTarget}, serverNames=[${rs.serverNames.join(',')}], shortIds=[${storedShortIds.join(',')}], spiderX=${storedSpiderX}`,
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

  // 复刻 v3.6.0 面板 RandomUtil.randomShortIds()：偶数长度 2..16 位 hex 各一个、乱序。
  // 手动创建 VLESS+Reality 时面板自动预填这一串 Short IDs；Xray 端全部有效。
  private randomShortIds(): string[] {
    const lengths = [2, 4, 6, 8, 10, 12, 14, 16].sort(() => Math.random() - 0.5);
    return lengths.map((len) => this.randomHex(len));
  }

  // 复刻 v3.6.0 面板 RandomUtil.randomizeSpiderX()：'/' + 15 位 大小写字母+数字。
  // 手动创建 Reality 时面板随机生成（默认空 spiderX 会被这步覆盖）。
  private randomSpiderX(): string {
    const seq = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = '/';
    for (let i = 0; i < 15; i++) {
      out += seq.charAt(Math.floor(Math.random() * seq.length));
    }
    return out;
  }

  // 与 v3.6.0 面板前端 RandomUtil.randomLowerAndNum(len) 同格式：小写字母+数字随机串。
  // 用于客户端密码/认证/订阅ID —— 手动流程这些字段预填 16 位随机，API 创建若不给，
  // 面板会把 VLESS 的密码/认证留空（半废节点）。
  private randomLowerAndNum(length: number): string {
    const seq = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += seq.charAt(Math.floor(Math.random() * seq.length));
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
          // spiderX 从落库 streamSettings 读（面板手动流程是 '/' + 15 位随机）。
          // 链接 spx 参数必须与服务端一致，否则客户端用默认 '/' 会对不上 → 连不上。
          const rs = streamSettings?.realitySettings;
          params.security = 'reality';
          params.flow = 'xtls-rprx-vision';
          params.fp = 'chrome';
          params.pbk = inbound.realityPublicKey || '';
          params.sni = inbound.realityDest || '';
          params.sid = inbound.realityShortId || '';
          params.spx = rs?.settings?.spiderX || rs?.spiderX || '/';
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

  // ==========================================
  // 后期挂载/卸载 SOCKS 中转（对【已有节点】操作，用户自助）
  // 挂载：把用户台账里选的 SOCKS 代理写入该节点的出站（socks-<port>）+ 路由规则，
  //       让该节点流量全程走 SOCKS，出口 IP = 该 SOCKS 代理地址。复用创建时的挂载逻辑。
  // ==========================================

  /** 给用户自己的一个已购节点挂 SOCKS 中转。 */
  async attachRelay(userId: number, inboundId: number, socksId: number) {
    const inbound = await this.prisma.inbound.findFirst({
      where: { id: inboundId, userId },
    });
    if (!inbound) throw new NotFoundException('节点不存在');
    if (inbound.status !== 'ACTIVE') {
      throw new BadRequestException('仅对活跃节点可挂载出站');
    }
    if (inbound.relayEnabled || inbound.relayTag) {
      throw new BadRequestException('该节点已挂载出站，请先卸载');
    }

    const proxy = await this.prisma.socksProxy.findFirst({
      // 归属或授权的 SOCKS 都可用作中转出口（后台「绑定给用户」授权）
      where: {
        id: socksId,
        status: 'ACTIVE',
        OR: [{ userId }, { grants: { some: { userId } } }],
      },
    });
    if (!proxy) {
      throw new BadRequestException('所选 SOCKS 代理不存在或不可用');
    }

    const serverId = inbound.serverId;
    const port = inbound.port;
    const relayTag = inbound.relayTag || `in-${port}-tcp`; // 3.6.0 面板标准 tag
    const outboundTag = `socks-${port}`;

    // 复用创建时的挂载逻辑（面板 outbound + 路由规则，仅变更时重启 Xray）
    await this.mountRelayOnNode(serverId, port, relayTag, {
      host: proxy.host,
      port: proxy.port,
      user: proxy.username || undefined,
      pass: proxy.password || undefined,
    });

    // 回写本地状态
    return this.prisma.inbound.update({
      where: { id: inboundId },
      data: {
        relayEnabled: true,
        relayTag,
        relaySocksOutboundTag: outboundTag,
        relaySocksHost: proxy.host,
        relaySocksPort: proxy.port,
        relaySocksUser: proxy.username || null,
        relaySocksPass: proxy.password || null,
      },
    });
  }

  /** 卸载用户自己节点上的 SOCKS 中转。 */
  async detachRelay(userId: number, inboundId: number) {
    const inbound = await this.prisma.inbound.findFirst({
      where: { id: inboundId, userId },
    });
    if (!inbound) throw new NotFoundException('节点不存在');
    if (!inbound.relayEnabled && !inbound.relayTag) {
      throw new BadRequestException('该节点未挂载出站');
    }

    await this.unmountRelayFromNode(inbound.serverId, inbound);

    return this.prisma.inbound.update({
      where: { id: inboundId },
      data: {
        relayEnabled: false,
        relayTag: null,
        relaySocksOutboundTag: null,
        relaySocksHost: null,
        relaySocksPort: null,
        relaySocksUser: null,
        relaySocksPass: null,
      },
    });
  }

  // ==========================================
  // 后台手动绑定 SOCKS 到节点 / 卸载（管理员）
  // ==========================================

  /** 后台把某个 SOCKS 手动绑到任意节点（不校验归属，管理员权限）。 */
  async adminAttachRelay(inboundId: number, socksId: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id: inboundId } });
    if (!inbound) throw new NotFoundException('节点不存在');
    if (inbound.status === 'DELETED') {
      throw new BadRequestException('节点已删除，无法绑定出站');
    }
    if (inbound.relayEnabled || inbound.relayTag) {
      throw new BadRequestException('该节点已挂载出站，请先卸载');
    }

    const proxy = await this.prisma.socksProxy.findFirst({
      where: { id: socksId, status: { not: 'DELETED' } },
    });
    if (!proxy) {
      throw new BadRequestException('所选 SOCKS 出站不存在或已删除');
    }

    const serverId = inbound.serverId;
    const port = inbound.port;
    const relayTag = `in-${port}-tcp`; // 3.6.0 面板标准 tag
    const outboundTag = `socks-${port}`;

    // 复用创建/用户自助的挂载逻辑（面板 outbound + 路由规则，仅变更时重启 Xray）
    await this.mountRelayOnNode(serverId, port, relayTag, {
      host: proxy.host,
      port: proxy.port,
      user: proxy.username || undefined,
      pass: proxy.password || undefined,
    });

    return this.prisma.inbound.update({
      where: { id: inboundId },
      data: {
        relayEnabled: true,
        relayTag,
        relaySocksOutboundTag: outboundTag,
        relaySocksHost: proxy.host,
        relaySocksPort: proxy.port,
        relaySocksUser: proxy.username || null,
        relaySocksPass: proxy.password || null,
      },
    });
  }

  /** 后台卸载某节点上的 SOCKS 中转。 */
  async adminDetachRelay(inboundId: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id: inboundId } });
    if (!inbound) throw new NotFoundException('节点不存在');
    if (!inbound.relayEnabled && !inbound.relayTag) {
      throw new BadRequestException('该节点未挂载出站');
    }

    await this.unmountRelayFromNode(inbound.serverId, inbound);

    return this.prisma.inbound.update({
      where: { id: inboundId },
      data: {
        relayEnabled: false,
        relayTag: null,
        relaySocksOutboundTag: null,
        relaySocksHost: null,
        relaySocksPort: null,
        relaySocksUser: null,
        relaySocksPass: null,
      },
    });
  }

  /** 用户实时流量（面板权威数值）。 */
  async getMyTraffic(userId: number, inboundId: number) {
    const inbound = await this.prisma.inbound.findFirst({
      where: { id: inboundId, userId },
    });
    if (!inbound) throw new NotFoundException('节点不存在');

    const traffic = await this.serverService.getClientTraffic(inbound.serverId, inbound.email);
    const up = Number(traffic?.obj?.up || 0);
    const down = Number(traffic?.obj?.down || 0);
    return { up, down, total: up + down, trafficLimit: Number(inbound.trafficLimit || 0) };
  }

  /**
   * 定时任务：每分钟扫描所有活跃节点
   *  - 到期判定：expiryTime 已过 → 停用（面板端 + 本地）
   *  - 流量判定：累计流量 >= 套餐限额 → 停用
   *  - 过期自动删除：时间到期后越过「一天续费宽限期」仍未续费 → 节点自动删除（只能重新购买套餐）
   * 判定通过后调用面板接口真正关闭客户端（bulkDisable），否则用户仍可连接。
   * 只有面板确认停用后才标记本地 EXPIRED；面板调用失败时保持 ACTIVE，下轮重试，
   * 避免「商城显示已停用、面板实际仍启用、用户继续使用」的状态错位。
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

        // —— 过期自动删除（订阅周期制·一天续费宽限期）——
        // 时间到期后保留一天续费宽限期（期间可在商城「到期续费」，周期锚在原到期日）；越过宽限期
        // 仍未续费 → 节点自动删除，只能重新购买套餐。门控：
        //  - 仅 ACTIVE/EXPIRED（遍历快照含 SUSPENDED，但管理员暂停的节点不自动删除——不静默
        //    抹掉管理动作；DELETED 不在本扫描范围）
        //  - 仅时间维度：不限时节点（expiryTime=null）永不删除；超限耗尽但未到期的节点不删
        //  - 有在途续费单（PAID/PROCESSING）绝不删：宽限期内付款、激活线程/autoActivate cron
        //    可能正复活该节点（与下方 1311 的 renewInFlight 防护同理，删掉会截断已付的续费交付）
        //  - 回写前重读最新状态：并发续费若把到期推进到未来 / 管理员暂停 / 已删除 → 放弃删
        const RENEWAL_GRACE_MS = 24 * 3600 * 1000;
        if (
          expiresAt !== null &&
          now - expiresAt > RENEWAL_GRACE_MS &&
          (inbound.status === 'ACTIVE' || inbound.status === 'EXPIRED')
        ) {
          const graceRenew = await this.prisma.order.findFirst({
            where: {
              renewalOfInboundId: inbound.id,
              status: { in: ['PAID', 'PROCESSING'] },
            },
            select: { id: true },
          });
          if (graceRenew) continue; // 有在途续费 → 不删，等它完结
          const freshSt = await this.prisma.inbound.findUnique({
            where: { id: inbound.id },
            select: { status: true, expiryTime: true },
          });
          // 并发条件下重新核验：已被删除/管理员暂停 → 放弃；到期被续费推进到宽限期内或未来 → 放弃
          if (
            !freshSt ||
            freshSt.status === 'DELETED' ||
            freshSt.status === 'SUSPENDED' ||
            (freshSt.expiryTime &&
              now - new Date(freshSt.expiryTime).getTime() <= RENEWAL_GRACE_MS)
          ) {
            continue;
          }
          try {
            await this.autoDeleteExpiredInbound(inbound);
          } catch (e) {
            this.logger.warn(
              `Auto-delete failed for expired node ${inbound.email}: ${(e as Error).message}`,
            );
          }
          continue;
        }

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

        // —— 周期切换判定（订阅周期制：到周期切换点自动重置流量）——
        // 提前续费只顺延到期日、不动切换点，因此「切换点已到 && 到期日已被推进到切换点之后」
        // 说明用户为下个周期付了费：此刻自动清零已用、额度回归周期基础额度(periodQuota)、
        // 保持启用，并把切换点推进到新的到期日。叠加的流量续费(TRAFFIC)也随本次切换清零、不跨周期。
        // 到期未续费的节点走正常的「过期停用」分支（expiresAt <= switchAt，不满足切换条件）。
        const switchAt = inbound.trafficResetAt ? new Date(inbound.trafficResetAt).getTime() : null;
        if (
          switchAt !== null &&
          switchAt <= now &&
          expiresAt !== null &&
          expiresAt > switchAt && // 到期日被续费推进到了切换点之后 → 进入新周期
          // 门控：仅 SUSPENDED（管理员暂停）/ DELETED 不允许被周期切换复活。
          // ACTIVE 恒可切换；EXPIRED 也可能本周期已超限耗尽、由本 cron 标记过 ——
          // 若用户已「到期续费」顺延了时间，切换点一到必须把耗尽节点清零并复活，
          // 否则该节点在面板侧永远停用、本地永久 EXPIRED（用户付了时长却连不上）。
          (inbound.status === 'ACTIVE' || inbound.status === 'EXPIRED')
        ) {
          const r = await this.serverService.resetClientTraffic(inbound.serverId, inbound.email);
          if (!r?.success) {
            // 面板清零失败：不推进切换点、不标记任何状态 —— 节点保持 ACTIVE 继续用，
            // 下一分钟本分支重试，直到清零生效；绝不因此停用一个已付费在保的节点。
            this.logger.warn(
              `Period rollover reset failed for ${inbound.email}: ${r?.msg} (will retry next minute)`,
            );
            // 流量计数仍以面板为准同步一次，避免本地过度滞后
            await this.prisma.inbound.update({
              where: { id: inbound.id },
              data: { totalTraffic: BigInt(total) },
            });
            continue;
          }
          // 【对抗复核原则同 1232】cron 用的 inbound 是 findMany 顶部的快照：遍历到本节点
          // 前管理员可能已暂停（SUSPENDED）/ 用户已删除（DELETED）。暂停/删除的节点不允许被
          // 周期切换「复活」——回写前重读最新 status，SUSPENDED/DELETED 则放弃（下一轮不再切
          // 入，它们已无意义）。EXPIRED（超限耗尽标记）允许切换：这正是「到期续费后耗尽节点
          // 到点自动复活」的路径。续费并发的微秒级时序不回读也能自愈：
          // 若恰被 EXPIRY 拉开到期日，下一分钟 switchAt<=now 仍成立且 expiresAt>switchAt，
          // 按新的到期日再回归一次，无副作用（清零幂等）。
          const freshStatus = await this.prisma.inbound.findUnique({
            where: { id: inbound.id },
            select: { status: true },
          });
          if (
            !freshStatus ||
            freshStatus.status === 'SUSPENDED' ||
            freshStatus.status === 'DELETED'
          )
            continue;
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: {
              totalTraffic: BigInt(0),
              trafficLimit: BigInt(inbound.periodQuota || 0), // 回归周期基础额度（叠加量作废）
              trafficResetAt: expiresAt ? new Date(expiresAt) : null, // 推进到当前到期日
            },
          });
          this.logger.log(
            `Node ${inbound.email} period rolled over: traffic reset to ${inbound.periodQuota || 0} bytes, next switch at ${new Date(expiresAt)}`,
          );
          continue;
        }

        // —— 判定：到期或超流量 → 停用 ——
        if (expired || (limitExceeded && inbound.status !== 'EXPIRED')) {
          // 面板端停用客户端（启用切到停用用 bulkEnable/bulkDisable 原生端点，
          //  不用 /clients/update/{email} —— 那是全量替换不是 patch，会把
          //  totalGB/expiryTime 清空）
          // 仅当客户端当前是启用状态才调用，避免重复调用
          const clientEnabled = traffic?.obj?.enable !== false;
          // 面板侧本来就是停用状态（enable=false 或之前已停成功）→ 视为已生效
          let panelDisabled = !clientEnabled;
          if (inbound.status === 'ACTIVE' && clientEnabled) {
            const res = await this.serverService.setClientEnabled(
              inbound.serverId,
              inbound.email,
              false,
            );
            if (!res?.success) {
              // 面板停用失败：绝不能标记本地 EXPIRED —— 否则下轮 cron 的
              // 「status==='ACTIVE'」门控会跳过，客户端在面板上永远保持启用、
              // 用户仍可继续连接（商城却显示已过期）。保持 ACTIVE，下一分钟
              // 本 cron 自动重试，直到面板真正停用为止。
              this.logger.warn(
                `Failed to disable client ${inbound.email} on server ${inbound.serverId}: ${res?.msg} (will retry next minute)`,
              );
              await this.prisma.inbound.update({
                where: { id: inbound.id },
                data: { totalTraffic: BigInt(total) },
              });
              continue;
            }
            this.logger.log(
              `Node ${inbound.email} disabled (${expired ? 'expired' : 'traffic limit'})`,
            );
            panelDisabled = true;
          }

          // 面板真实停用成功（或原本就已停用）才标记本地 EXPIRED；
          // 管理员暂停的节点保持 SUSPENDED（不被到期时间覆盖，避免丢暂停标记）
          if (panelDisabled) {
            // 【major#1151 对抗复核】「激活续费与 cron 停用无互斥」竞态护栏：
            // cron 用本快照判定过期/超限并已把面板侧停用；但并行的续费激活（本地先提交 →
            // 面板加量/重置 → status=ACTIVE）可能恰在这两者之间把节点复活。直接按旧快照写
            // status=EXPIRED 会把刚续费的节点打回停用（下一次过期判定要等新到期日才松开，
            // 面板已恢复但商城显示已过期，用户白等一整轮）。
            // 写本地状态前重读一次：若该行已被续费复活（ACTIVE 且新到期在未来 且 新额度未超）
            // → 放弃覆盖，保留最新状态。
            const freshRow = await this.prisma.inbound.findUnique({
              where: { id: inbound.id },
              select: { status: true, expiryTime: true, trafficLimit: true, totalTraffic: true },
            });
            if (!freshRow) continue;
            const freshExpiresAt = freshRow.expiryTime ? new Date(freshRow.expiryTime).getTime() : null;
            // 【复核1232】freshExceeded 不再用「上一轮写库的陈旧本地 totalTraffic」判定：
            // 它在「续费激活 vs cron 停用」并行竞争的分钟窗口里是过期快照 —— 续费已把 quota
            // 调高（EXPIRY 顺延 / TRAFFIC 重置），库里的 used 还是上一分钟读面板的旧值，
            // 可能 ≥ 新 quota 造成假超限，把刚续费的节点误判为「未复活」。改判两件事：
            //  a) 用本轮刚读到的面板 total（同一次遍历刚取，比 DB 里的 freshRow.totalTraffic 新）
            //  b) 存在在途续费单（renewalOfInboundId + PAID/PROCESSING，已付款未完结）→
            //     节点正在被续费线程复活，这一轮绝不打回 EXPIRED
            const renewInFlight = await this.prisma.order.findFirst({
              where: {
                renewalOfInboundId: inbound.id,
                status: { in: ['PAID', 'PROCESSING'] },
              },
              select: { id: true },
            });
            const freshExceeded =
              !renewInFlight &&
              Number(freshRow.trafficLimit) > 0 &&
              Number(total) >= Number(freshRow.trafficLimit);
            const revived =
              freshRow.status === 'ACTIVE' &&
              (freshExpiresAt === null || freshExpiresAt > now) &&
              !freshExceeded;
            if (revived) {
              // 【复核1237】复活分支补回面板 enable：此刻面板侧刚被本 cron 停用
              // （enable=false）。续费激活只做 bulkAdjust/本地状态，不重查面板 enable →
              // 用户连接会断到下一分钟 cron 重新判定才恢复，白断一整轮。立即复位。
              try {
                await this.serverService.setClientEnabled(inbound.serverId, inbound.email, true);
              } catch (e) {
                // 复位失败不致命：cron 下一轮按新到期/quota 判「未超限 → 保持启用」。
                this.logger.warn(
                  `Failed to re-enable client ${inbound.email} after renewal, will retry next minute: ${e.message}`,
                );
              }
              continue; // 已被续费复活 → 不覆盖
            }
            // 【复核1243】最终写回基于 freshRow.status：旧的 inbound.status 快照在
            // findMany 之后可能已变化（管理员暂停 → SUSPENDED、用户删除 → DELETED）。
            //  - DELETED：跳过写（写回 EXPIRED 等于把已删节点「复活」成已过期状态，
            //    zombie-create 补偿的竞态干扰）
            //  - SUSPENDED：保持暂停标记（不被到期时间覆盖，避免丢暂停标记）
            if (freshRow.status === 'DELETED') continue;
            await this.prisma.inbound.update({
              where: { id: inbound.id },
              data: {
                totalTraffic: BigInt(total),
                status: freshRow.status === 'SUSPENDED' ? 'SUSPENDED' : 'EXPIRED',
              },
            });
          }
        } else {
          // 未到期超限，仅更新流量计数
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: { totalTraffic: BigInt(total) },
          });
          // 【对抗复核确认】面板 enable 自愈位：复活分支（上方 revived）的
          // setClientEnabled(true) 失败时只 warn、不重试（注释先前声称「下一分钟重试」，
          // 但下一轮 cron 走本 else 分支，从不触碰面板 enable）→ 节点本地 ACTIVE、
          // 面板永久停用（enable=false），用户连不上。这里每轮补一次幂等修复：本地
          // ACTIVE 而面板仍停用 → 重开；失败下轮再试，直至面板恢复。
          // SUSPENDED（管理员主动暂停，经 suspend 流程走面板停用）不该被复活，
          // 用 status 门控；expired/超限节点走上方分支，不会落进这里被兜底重开。
          //
          // 【对抗复核 F8/F14：不能用旧快照查 self-heal 门】inbound.status 是 updateTraffic
          // 顶部 findMany（L1163）抓的快照，跑一遍要经过多条面板往返，会过时。管理员暂停
          // （suspend：先面板 setClientEnabled(false) 后写 SUSPENDED，或先写后停）若恰在这
          // 快照之后、本节点迭代之前落地，这里旧快照仍读 ACTIVE + 面板 enable=false →
          // 会误把这台「已被管理员暂停」的节点在面板侧重新启用，商城显示已暂停、用户却还能连。
          // 复活/停用分支都已重读 freshRow 防并发，自愈位也必须重读当前 DB 状态：
          // 只在「此刻仍是 ACTIVE」时才准许重开（SUSPENDED/DELETED/已过期一律不碰）。
          if (traffic?.obj?.enable === false) {
            const nowStatus = await this.prisma.inbound.findUnique({
              where: { id: inbound.id },
              select: { status: true },
            });
            if (nowStatus && nowStatus.status === 'ACTIVE') {
              try {
                const r = await this.serverService.setClientEnabled(inbound.serverId, inbound.email, true);
                if (!r?.success) {
                  this.logger.warn(
                    `Failed to re-enable client ${inbound.email} (self-heal): ${r?.msg} (will retry next minute)`,
                  );
                } else {
                  // 【对抗复核 F9】面板侧被停用（enable=false）而本地仍 ACTIVE —— 除了实现
                  // 的「漂移修复」也可能是有人在 x-ui 面板手动停用了这台 ACTIVE 节点
                  // （紧急掐流/封滥用）。重开后明确打一条警告，让覆盖操作可审计、可察觉，
                  // 而非静默撤销运维意图。
                  this.logger.warn(
                    `Self-heal re-enabled client ${inbound.email} on panel (was disabled while local status ACTIVE); if this was a manual panel-side block, use 商城暂停(suspend) instead`,
                  );
                }
              } catch (e) {
                this.logger.warn(
                  `Failed to re-enable client ${inbound.email} (self-heal): ${e.message} (will retry next minute)`,
                );
              }
            }
          }
        }
      } catch (e) {
        this.logger.debug(
          `Failed to update traffic for ${inbound.email}: ${e.message}`,
        );
      }
    }
  }

  /**
   * 过期自动删除（updateTraffic cron 调用）：时间到期并越过「一天续费宽限期」仍未续费的节点
   * 从商城移除（本地置 DELETED，用户节点列表即刻消失；面板客户端/入站一并清除）。
   * 与用户主动删除（delete）同款清理流程，但面板卸载失败不阻断本地删除 —— 节点在面板侧早已
   * 停用（cron 到期停用），本地置 DELETED 即完成「商城消失、只能重新购买套餐」的交付；
   * 残留面板行由既有自愈机制兜底，不因面板抖动让已过期的节点无限残留。
   */
  private async autoDeleteExpiredInbound(inbound: any) {
    if (inbound.relayEnabled) {
      try {
        await this.unmountRelayFromNode(inbound.serverId, inbound);
      } catch (e) {
        this.logger.warn(
          `Auto-delete relay unmount failed for ${inbound.email}: ${(e as Error).message}`,
        );
      }
    }
    try {
      await this.serverService.deleteClient(inbound.serverId, inbound.email);
    } catch (e) {
      this.logger.warn(`Auto-delete XUI client failed for ${inbound.email}: ${(e as Error).message}`);
    }
    try {
      await this.serverService.deleteInbound(inbound.serverId, inbound.inboundId);
    } catch (e) {
      this.logger.warn(`Auto-delete XUI inbound failed for ${inbound.email}: ${(e as Error).message}`);
    }
    await this.prisma.inbound.update({
      where: { id: inbound.id },
      data: { status: 'DELETED' },
    });
    this.logger.log(
      `Node ${inbound.email} auto-deleted (expired > 1 day without renewal, repurchase required)`,
    );
  }

  // ==========================================
  // Admin Management
  // ==========================================

  async findAll(page = 1, limit = 20, search?: string) {
    // 过滤 DELETED：过期自动删除的墓碑、历史软删记录不再污染管理列表
    const where: any = { status: { not: 'DELETED' } };
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

    // Suspend in XUI — 用原生 bulkDisable（update/{email} 是全量替换，只传 enable 会清字段）。
    // 面板停用失败必须抛错、不置本地 SUSPENDED：否则商城显示已暂停、面板实际仍启用，用户继续可用。
    const res = await this.serverService.setClientEnabled(inbound.serverId, inbound.email, false);
    if (!res?.success) {
      this.logger.warn(`Failed to suspend ${inbound.email} in XUI: ${res?.msg}`);
      throw new BadRequestException(`面板停用失败（${res?.msg || '未知错误'}），节点未暂停`);
    }

    return this.prisma.inbound.update({
      where: { id },
      data: { status: 'SUSPENDED' },
    });
  }

  async resume(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    // Resume in XUI — 用原生 bulkEnable。同理，面板启用失败必须抛错，
    // 否则本地已回 ACTIVE、面板实际仍停用，用户连不上却显示活跃。
    const res = await this.serverService.setClientEnabled(inbound.serverId, inbound.email, true);
    if (!res?.success) {
      this.logger.warn(`Failed to resume ${inbound.email} in XUI: ${res?.msg}`);
      throw new BadRequestException(`面板启用失败（${res?.msg || '未知错误'}），节点未恢复`);
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

  /**
   * 到期提醒：每小时扫描活跃节点，到期前 3 天 / 1 天 / 已到期各发一封邮件（每档只会发一次，
   * 由 inbound.expiryReminderStage 档位标记保证 —— 0=未发 1=3天内 2=1天内 3=已到期）。
   * 停用本身由 updateTraffic 每分钟负责，这里只管提醒不重复打扰。
   * 邮件通道未配置（emailEnabled=false）时只打日志提醒，不推进档位，避免启用后补发丢失。
   */
  @Cron('0 * * * *')
  async sendExpiryReminders() {
    try {
      await this.runExpiryReminders();
    } catch (e) {
      this.logger.error(`Scheduled expiry reminder check failed: ${e.message}`);
    }
  }

  private async runExpiryReminders() {
    const emailEnabled = await this.emailService.isEnabled().catch(() => false);
    const inbounds = await this.prisma.inbound.findMany({
      where: { status: 'ACTIVE', expiryTime: { not: null } },
      include: {
        user: { select: { email: true, username: true } },
        server: { select: { name: true } },
      },
    });

    const now = Date.now();
    for (const inbound of inbounds) {
      try {
        // 查询条件已过滤 expiryTime=null，这里再收窄一次类型（Prisma 类型仍是 Date | null）
        if (!inbound.expiryTime) continue;
        const expiryMs = new Date(inbound.expiryTime).getTime();
        const msLeft = expiryMs - now;
        // 已到期的由 updateTraffic cron 停用，这里不发「已到期」（到期提醒在到期前发）
        if (msLeft <= 0) continue;

        const daysLeft = Math.ceil(msLeft / 86400000);
        // 档位：1=3天内（已过期不在此函数内处理）2=1天内；高于现有档位才发
        let stage = 0;
        if (daysLeft <= 3) stage = 1;
        if (daysLeft <= 1) stage = 2;
        if (stage <= (inbound.expiryReminderStage || 0)) continue;

        const labels: Record<number, string> = { 1: '即将在 3 天内到期', 2: '将在 24 小时内到期' };
        const subject = `节点到期提醒（${labels[stage]}）`;
        const dateStr = new Date(expiryMs).toLocaleString('zh-CN', { hour12: false });
        const nodeName = inbound.remark || `${inbound.server?.name || ''}-${inbound.port}`;
        const userEmail = inbound.user?.email;
        if (!userEmail) continue;

        const ok = emailEnabled ? await this.emailService.send({
          to: userEmail,
          subject,
          html: this.emailService.wrap(
            subject,
            `<p>您好：</p>
             <p>您的节点 <b>${this.emailService.escapeHtml(nodeName)}</b> ${labels[stage]}（到期时间：${dateStr}）。</p>
             <p style="color:#dc2626;">到期后节点将被停用，为避免影响使用，请尽快续期。</p>
             <p style="margin:24px 0;">
               <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/user/nodes" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 28px;border-radius:8px;text-decoration:none;font-weight:600;">前往续费</a>
             </p>`,
          ),
        }) : false;
        // 邮件通道未启用/发送失败 → 不推进档位（启用后或下轮成功时再发，不丢失提醒）
        if (ok) {
          await this.prisma.inbound.update({
            where: { id: inbound.id },
            data: { expiryReminderStage: stage },
          });
        }
      } catch (e) {
        this.logger.warn(`到期提醒处理失败 inbound#${inbound.id}: ${(e as Error).message}`);
      }
    }
  }

  async delete(id: number) {
    const inbound = await this.prisma.inbound.findUnique({ where: { id } });
    if (!inbound) throw new NotFoundException('Inbound not found');

    // 该节点是中转节点 → 先移除它的路由规则及其专属出站
    // 【delete-swallow 对抗复核】卸载失败不能吞掉继续删：面板模板会残留 dead 规则与孤儿
    // 出站，而 removeRelayMount 的「无规则引用才删出站」逻辑因规则没删掉永不清理，长期
    // 累积脏配置。失败时中断删除，让用户稍后重试（或联系客服修复面板模板）。
    if (inbound.relayEnabled) {
      await this.unmountRelayFromNode(inbound.serverId, inbound);
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

    // 彻底删除（后台不再留灰色的 DELETED 残留）：
    // ① 解除续费订单对节点的外键引用（Order.renewalOfInboundId → Inbound，PG RESTRICT，
    //    不先置空会删除失败）——节点已删除，续费本就无意义；
    // ② 物理删行。历史流量随之清除，符合「删除就是彻底删除了」。
    await this.prisma.$transaction([
      this.prisma.order.updateMany({
        where: { renewalOfInboundId: id },
        data: { renewalOfInboundId: null },
      }),
      this.prisma.inbound.delete({ where: { id } }),
    ]);

    return { success: true, id };
  }

  async getStats() {
    const [total, active, totalTraffic] = await Promise.all([
      this.prisma.inbound.count({ where: { status: { not: 'DELETED' } } }),
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


