import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ServerService } from '../server/server.service';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// 一键导入出站的确定性 uuid：基于节点 uuid 派生（同一节点 ↔ 同一出站条目），
// 幂等 + 用户从「我的 SOCKS」删除后可重新导入（同 uuid 重建）。
const SOCKS_IMPORT_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // uuid DNS namespace
const SOCKS_IMPORT_TAG = 'socks-panel-import:';

// 面板交付 SOCKS 节点（SOCKS_PANEL 虚拟商品）
// ------------------------------------------------------------------
// 与现有 Inbound 节点体系【完全解耦】：Xray socks 入站没有 settings.clients，
// 认证在入站级 { auth:'password', accounts:[{user,pass}] } —— 因此节点全生命周期
// （创建/停用/复活/删除）都走 inbounds 级 API，绝不碰 clients/* 生命周期原语。
// 存储在本模块自己的 SocksNode 台账（与 SocksProxy 用户台账、Inbound 亦无关）。
//
// 语义（用户确认的三个维度选择）：
// - 时长制、不限流量（v1 无流量配额）：本地 SocksNode.expiryTime 是权威，
//   面板入站 expiryTime/total 恒为 0（与现有节点入站一致，面板永不按此停用）。
// - 服务器：商品绑定多台服务器，激活时按权重随机挑一台（空数组=全局）。
// - 到期策略与现有节点完全一致：到期 → 面板 enable:false → 本地 EXPIRED；
//   越过 1 天续费宽限期仍未续费 → 面板删入站 → 本地 DELETED（只能重新购买）。
// - 续费仅 EXPIRY（时长制根本没流量可续）：严格周期锚，新到期 = 原到期 + 商品时长；
//   local-first + renewalAppliedAt，重试天然幂等，不会双倍顺延。
//
// 面板入站级操作的【全量替换陷阱】：/inbounds/update/{id} 是全量替换不是 patch，
// 必须基于创建时的 panelSnapshot 重建完整 payload，漏字段会把入站配置清空。

@Injectable()
export class SocksPanelService implements OnModuleInit {
  private readonly logger = new Logger(SocksPanelService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private serverService: ServerService,
  ) {}

  /**
   * 启动自愈：对账 SOCKS 商品 sold 与现存节点数，修复「历史已删节点 sold 清不掉」的遗留问题。
   * 上线释放逻辑（releaseNodeQuota）之前删除的节点是 DELETED 终态，adminDelete 会直接拒绝，
   * sold 只增不减 → 已售虚高 + 售罄拦单。对账按「现存非 DELETED 节点数」重算即回正。
   * 包 try/catch：对账失败绝不断服务启动。
   */
  async onModuleInit() {
    try {
      const r = await this.reconcileSocksQuota();
      if (r.changed > 0 || r.restored > 0) {
        this.logger.log(
          `[reconcile] 启动校准完成: 修正 ${r.changed} 项, 恢复在售 ${r.restored} 项`,
        );
      }
    } catch (e) {
      this.logger.error(`[reconcile] 启动对账失败: ${(e as Error).message}`);
    }
  }

  // ==========================================
  // 交付（下单激活入口：activateOrderInner 派发）
  // ==========================================

  /**
   * SOCKS_PANEL 商品单交付：面板创建 socks 入站（时长制、不限流量）+ 本地台账 + 完结订单。
   * 幂等：按 orderNo 查存量 —— 崩溃后 cron 重试不会在第二个端口重建节点。
   * 任一面板环节失败 → 回滚已建入站 → 抛错，订单停在 PROCESSING 由 autoActivatePending
   * cron 重试；本地台账落库失败同样回滚面板 —— 与既有 createInbound 同标准，绝不留下
   * 「商城付了钱、面板飘着游离空入站」的账目裂口。
   */
  async deliverSocksNode(order: any) {
    // —— 幂等：同订单已有台账（上轮在完结前崩溃）→ 直接恢复 COMPLETED ——
    const existing = await this.prisma.socksNode.findFirst({
      where: { orderNo: order.orderNo },
    });
    if (existing && existing.status !== 'DELETED') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
      });
      this.logger.log(
        `SOCKS order ${order.orderNo} resumed from existing node ${existing.uuid}`,
      );
      return { socksNode: existing, order: { ...order, status: 'COMPLETED' } };
    }

    // —— 商品校验（createOrder 已拦，这里防御商品中途下架/归档）——
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id: order.virtualProductId },
    });
    if (
      !product ||
      product.status !== 'ACTIVE' ||
      product.deliveryType !== 'SOCKS_PANEL' ||
      !product.duration ||
      Number(product.duration) <= 0
    ) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException(
        '该商品已下架或未配置交付时长，无法交付，请联系客服退款',
      );
    }

    // —— 服务器：商品绑定多台时按权重随机挑一台（空数组=全局可用）——
    const server = await this.pickServer(product.serverIds || []);
    // —— 端口范围：商品可配置（都填才生效；有一项为空视为未配置，用默认高位端口）——
    const portStart = product.portStart != null ? Number(product.portStart) : null;
    const portEnd = product.portEnd != null ? Number(product.portEnd) : null;
    const rangeValid =
      portStart != null && portEnd != null && portStart >= 1 && portEnd <= 65535 && portStart <= portEnd;
    if (portStart != null || portEnd != null) {
      if (!rangeValid) {
        this.logger.warn(
          `Invalid port range ${portStart}-${portEnd} on virtual product ${product.id}, fallback to default high ports`,
        );
      }
    }
    const rangeMin = rangeValid ? portStart : null;
    const rangeMax = rangeValid ? portEnd : null;
    const remark = await this.computeRemark(server);
    const username = this.randomLowerAndNum(16);
    const password = this.randomLowerAndNum(24);
    let port = await this.getAvailablePort(server.id, rangeMin, rangeMax);
    const expiryTime = Date.now() + Number(product.duration) * 24 * 3600 * 1000;

    // Xray socks 入站：认证在入站级（accounts），没有 settings.clients；
    // udp:true 允许 UDP（3.6.0 面板手动创建 socks 入站的默认值）。
    const settings = {
      auth: 'password',
      accounts: [{ user: username, pass: password }],
      udp: true,
    };
    const streamSettings = {
      network: 'tcp',
      security: 'none',
      tcpSettings: { header: { type: 'none' } },
    };
    // 入站级 expiryTime/total 恒 0：时长在本地权威（与现有节点一致），
    // 到期停用由本模块生命周期 cron 负责。
    const inboundData = {
      enable: true,
      remark,
      listen: '',
      port,
      // 新版 3-x-ui 面板已把 socks 入站协议名改为 mixed（旧版才叫 socks）；
      // settings 同构（auth:password + accounts），deliverSocksNode 均以 mixed 创建。
      protocol: 'mixed',
      expiryTime: 0,
      total: 0,
      settings,
      streamSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    };

    // 1) 建入站（端口可能被宿主机其它服务占用，命中 already in use 换随机高位端口有界重试）
    let xuiInboundId = 0;
    let createdRecord: any = null;
    let response: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      inboundData.port = port;
      response = await this.serverService.addInbound(server.id, inboundData);
      const id = this.extractInboundId(response);
      if (response?.success) {
        xuiInboundId = id;
        if (!xuiInboundId) {
          const located = await this.findCreatedInboundId(server.id, inboundData);
          xuiInboundId = located.id;
          createdRecord = located.record;
        }
        if (xuiInboundId) break;
        break;
      }
      if (!/already in use|in use/i.test(response?.msg || '')) break;
      this.logger.warn(
        `Port ${port} in use on server ${server.id}, retry within port range ${
          rangeValid ? `${rangeMin}-${rangeMax}` : 'default high ports'
        }`,
      );
      port = await this.getAvailablePort(server.id, rangeMin, rangeMax);
    }
    if (!xuiInboundId) {
      // add 可能已成功但没定位到 id —— 尽力回收空入站，避免面板累积游离节点
      await this.cleanupOrphanInbound(server.id, inboundData);
      throw new BadRequestException(
        response?.msg || '未能获取 XUI 入站 ID，SOCKS 节点未交付',
      );
    }

    // 2) 重载 Xray：/inbounds/add 只写面板库，运行中的 Xray 不会自动加载新入站。
    //    重载失败（新入站配置被 Xray 拒收）→ 回滚并抛错，绝不交付未真正启用的节点。
    try {
      const restartRes = await this.serverService.restartXrayService(server.id);
      if (!restartRes?.success) {
        throw new Error(`Xray reload failed: ${restartRes?.msg || 'unknown'}`);
      }
    } catch (e) {
      try {
        await this.serverService.deleteInbound(server.id, xuiInboundId);
      } catch {}
      throw new BadRequestException(
        `Xray 重新加载失败（SOCKS 节点未真正启用，已回滚）：${(e as Error).message}`,
      );
    }

    // 3) 运行态最终断言：重载后回读运行中(已落盘)的 Xray 配置，确认入站 + 账号真的进了
    //    运行态（与 createInbound 的 assertInboundLiveInRunningConfig 同标准；失败回滚）。
    try {
      await this.assertSocksLiveInRunningConfig(server.id, xuiInboundId, port, username);
    } catch (e) {
      try {
        await this.serverService.deleteInbound(server.id, xuiInboundId);
      } catch {}
      try {
        await this.serverService.restartXrayService(server.id);
      } catch {}
      throw new BadRequestException(
        `SOCKS 节点未进入 Xray 运行配置（已回滚）：${(e as Error).message}`,
      );
    }

    // 4) 本地台账落库（失败回滚面板入站 —— 否则 cron 重试会在新端口再建一个，面板遗留游离节点）
    const connectionUrl = `socks5://${encodeURIComponent(username)}:${encodeURIComponent(
      password,
    )}@${server.host}:${port}`;
    let socksNode: any;
    try {
      socksNode = await this.prisma.socksNode.create({
        data: {
          uuid: uuidv4(),
          userId: order.userId,
          virtualProductId: product.id,
          orderId: order.id,
          orderNo: order.orderNo,
          serverId: server.id,
          inboundId: xuiInboundId,
          host: server.host,
          port,
          username,
          password,
          connectionUrl,
          expiryTime: new Date(expiryTime),
          status: 'ACTIVE',
          // 创建时完整 payload：后续停用/复活的 /inbounds/update 全量替换都从它重建
          panelSnapshot: inboundData as any,
          remark: order.orderNo,
        },
      });
    } catch (e) {
      try {
        await this.serverService.deleteInbound(server.id, xuiInboundId);
      } catch {}
      try {
        await this.serverService.restartXrayService(server.id);
      } catch {}
      throw e;
    }

    // 5) 完结订单 + 商品销量 +1（与 AUTO 自动发码同语义）
    const done = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
    });
    await this.prisma.virtualProduct.update({
      where: { id: product.id },
      data: { sold: { increment: 1 } },
    });
    // 限量库存：交付后读回 sold/stock，达量则置 SOLD_OUT（仅当仍为 ACTIVE，不覆盖管理员的下架/归档决定）。
    // 已付款并发交付即使略超上限也照常完成，新购入口由 createOrder 的 sold>=stock 拦截，幂等。
    if (product.stock != null) {
      const latest = await this.prisma.virtualProduct.findUnique({
        where: { id: product.id },
        select: { sold: true, stock: true },
      });
      if (latest && latest.stock != null && latest.sold >= latest.stock) {
        await this.prisma.virtualProduct.updateMany({
          where: { id: product.id, status: 'ACTIVE' },
          data: { status: 'SOLD_OUT' },
        });
      }
    }

    this.logger.log(
      `SOCKS node delivered: ${username} socks5://${server.host}:${port} on server ${server.name}, expires ${new Date(expiryTime).toISOString()}`,
    );
    return { socksNode, order: done };
  }

  // ==========================================
  // SOCKS 续费（仅 EXPIRY，时长制）
  // ==========================================

  /**
   * SOCKS 续费激活：
   * - 面板入站 expiryTime 恒 0（本地权威），因此续费【不需要面板加量】—— 只需在被到期
   *   cron 停用后重新启用入站（enable:true + 重启，幂等）。
   * - local-first + renewalAppliedAt：本地先推进到期（崩溃安全）→ 面板启用 → 完结。
   *   面板启用失败不回滚本地（避免重试时按「已推进的到期」再算一次 → 双倍顺延）；
   *   重试时 renewalAppliedAt 已设 → 只补面板启用 + 完结，绝不重复顺延。
   */
  async activateSocksRenewal(order: any) {
    const node = await this.prisma.socksNode.findUnique({
      where: { id: order.renewalOfSocksNodeId },
    });
    if (!node || node.userId !== order.userId || node.status === 'DELETED') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('目标 SOCKS 节点不存在或已被删除，续费失败');
    }
    if (node.status === 'SUSPENDED') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('该节点已被管理员暂停，无法续费，请联系客服');
    }

    // 幂等：本地已推进过（上次在面板启用前后崩溃）→ 只补面板启用 + 完结
    if (order.renewalAppliedAt) {
      return this.finishSocksRenewal(order, node);
    }

    const product = await this.prisma.virtualProduct.findUnique({
      where: { id: order.virtualProductId },
      select: { id: true, name: true, deliveryType: true, duration: true, status: true },
    });
    if (
      !product ||
      product.status !== 'ACTIVE' ||
      product.deliveryType !== 'SOCKS_PANEL' ||
      !product.duration ||
      Number(product.duration) <= 0
    ) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('续费商品不可用，无法续费，请联系客服');
    }
    if (!node.expiryTime) {
      // 时长制节点必有到期（createOrder 已拦，这里防御）
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('该节点没有到期时间，无法续费');
    }
    if (!node.inboundId) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException('该节点缺少面板入站 ID，无法续费，请联系客服');
    }

    const DAY_MS = 24 * 3600 * 1000;
    // 严格周期锚：以【当前本地到期日】为锚（下单校验已保证未超宽限期），不因续费时刻顺延。
    const newExpiry = new Date(node.expiryTime.getTime() + Number(product.duration) * DAY_MS);
    await this.prisma.$transaction([
      this.prisma.socksNode.update({
        where: { id: node.id },
        data: { expiryTime: newExpiry, status: 'ACTIVE' }, // EXPIRED→ACTIVE（复活）
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: { renewalAppliedAt: new Date() },
      }),
    ]);

    return this.finishSocksRenewal(order, { ...node, expiryTime: newExpiry, status: 'ACTIVE' });
  }

  /**
   * SOCKS 续费收尾：面板复活入站（enable:true，幂等）+ 完结订单。
   * 面板/重启失败 → 抛错保持订单 PROCESSING，autoActivate cron 重试
   * （面板当前已启用时再次 update/restart 幂等无害）。
   */
  private async finishSocksRenewal(order: any, node: any) {
    try {
      const res = await this.setSocksInboundEnabled(node, true);
      if (!res?.success) {
        throw new Error(`面板启用失败：${res?.msg || 'unknown'}`);
      }
    } catch (e) {
      this.logger.warn(
        `SOCKS renewal order ${order.orderNo} panel re-enable failed: ${e.message} — keeping PROCESSING, will retry`,
      );
      throw new BadRequestException('节点尚未在面板恢复，系统将自动重试');
    }

    const done = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'COMPLETED', paidAt: order.paidAt || new Date() },
    });
    this.logger.log(
      `SOCKS renewal applied order ${order.orderNo}: node #${node.id} expiry → ${node.expiryTime?.toISOString()}`,
    );
    return { socksNode: node, order: done };
  }

  // ==========================================
  // 面板入站级操作（全量替换陷阱：必须基于 panelSnapshot 重建完整 payload）
  // ==========================================

  /**
   * 基于创建时快照（panelSnapshot）重建完整入站 payload 并更新面板。
   * 3.6.0 的 /inbounds/update/{id} 是全量替换（不是 patch），漏字段会把入站配置清空 ——
   * 绝不能只传 { enable }。入站级变更不会自动应用到运行态 Xray → 改完必须重启。
   * 重启失败 ≠ 入站更新未落库（3xui 先落库后重启），返回失败由调用方决定重试策略。
   */
  private async setSocksInboundEnabled(node: any, enabled: boolean) {
    if (!node.serverId || !node.inboundId) {
      throw new BadRequestException('节点缺少服务器/面板入站 ID，无法在面板侧操作');
    }
    const snap =
      node.panelSnapshot && typeof node.panelSnapshot === 'object' ? node.panelSnapshot : {};
    const payload = {
      ...(snap as any),
      enable: enabled,
      listen: '',
      port: node.port,
      // 协议沿用创建时快照：存量 socks 节点保持 socks，新节点（mixed）不被覆盖回旧名
      protocol: (snap as any)?.protocol || 'mixed',
    };
    const res = await this.serverService.updateInbound(node.serverId, node.inboundId, payload);
    if (!res?.success) return res;
    const restart = await this.serverService.restartXrayService(node.serverId);
    if (!restart?.success) {
      return {
        ...restart,
        success: false,
        msg: `Xray 重新加载失败：${restart?.msg || 'unknown'}`,
      };
    }
    return res;
  }

  // ==========================================
  // 生命周期 cron：到期停用 → 1 天宽限期 → 自动删除（与现有节点完全一致）
  // ==========================================

  /**
   * 每分钟扫描 SOCKS 节点（Redis SETNX 锁防多实例重入，与 autoActivatePending 同模式）：
   * - 到期 → 仅 ACTIVE 节点：面板 enable:false（snapshot 全量回写）+ 重启，面板确认
   *   成功后才置本地 EXPIRED；失败保持 ACTIVE 下轮重试 —— 绝不出现「商城已过期、
   *   面板实际仍启用」的状态错位。
   * - 越过 1 天宽限期仍未续费 → 删除：面板删入站 + 本地 DELETED。门控：
   *   有在途续费单（PAID/PROCESSING）不删（等它完结）；管理员暂停（SUSPENDED）不自动
   *   删除（不静默抹掉管理动作）；写回前重读最新状态防并发续费。
   */
  @Cron('* * * * *')
  async checkSocksExpiryAndCleanup() {
    const lockKey = 'socks-panel:lifecycle:lock';
    const lockToken = uuidv4();
    const gotLock = await this.redis.setNx(lockKey, lockToken, 300).catch(() => false);
    if (!gotLock) return; // 另一个实例/上一轮还在跑
    try {
      const RENEWAL_GRACE_MS = 24 * 3600 * 1000;
      const now = Date.now();
      const nodes = await this.prisma.socksNode.findMany({
        where: { status: { in: ['ACTIVE', 'EXPIRED', 'SUSPENDED'] } },
      });
      for (const node of nodes) {
        // 长轮次续期：防止本轮还没跑完锁就过期，下一个实例带着新锁进来双跑
        await this.redis.expire(lockKey, 300).catch(() => {});
        try {
          const expiresAt = node.expiryTime ? new Date(node.expiryTime).getTime() : null;
          if (expiresAt === null) continue; // 时长制节点必有到期；防御性跳过

          // —— 过期自动删除（越过宽限期 + 无在途续费单）——
          if (
            now - expiresAt > RENEWAL_GRACE_MS &&
            (node.status === 'ACTIVE' || node.status === 'EXPIRED')
          ) {
            const graceRenew = await this.prisma.order.findFirst({
              where: {
                renewalOfSocksNodeId: node.id,
                status: { in: ['PAID', 'PROCESSING'] },
              },
              select: { id: true },
            });
            if (graceRenew) continue; // 有在途续费 → 不删，等它完结
            // 回写前重读最新状态：并发续费推进到期 / 管理员暂停 / 已删除 → 放弃删
            const fresh = await this.prisma.socksNode.findUnique({
              where: { id: node.id },
              select: { status: true, expiryTime: true },
            });
            if (
              !fresh ||
              fresh.status === 'DELETED' ||
              fresh.status === 'SUSPENDED' ||
              (fresh.expiryTime &&
                now - new Date(fresh.expiryTime).getTime() <= RENEWAL_GRACE_MS)
            ) {
              continue;
            }
            try {
              await this.autoDeleteSocksNode(node);
            } catch (e) {
              this.logger.warn(
                `Auto-delete failed for SOCKS node #${node.id}: ${(e as Error).message}`,
              );
            }
            continue;
          }

          // —— 到期停用（仅 ACTIVE；EXPIRED 已停用、SUSPENDED 保留管理动作）——
          if (expiresAt <= now && node.status === 'ACTIVE') {
            try {
              const res = await this.setSocksInboundEnabled(node, false);
              if (!res?.success) {
                this.logger.warn(
                  `Failed to disable SOCKS node #${node.id} on server ${node.serverId}: ${res?.msg} (will retry next minute)`,
                );
                continue; // 面板未确认停用 → 保持 ACTIVE 下轮重试
              }
            } catch (e) {
              this.logger.warn(
                `Failed to disable SOCKS node #${node.id}: ${e.message} (will retry next minute)`,
              );
              continue;
            }
            // 【对抗复核·续费竞态】与 Inbound updateTraffic 的 revived 护栏同理：cron 用本快照判定
            // 过期并已把面板侧停用；但并行的续费激活（本地先推进到期 → 面板复活）可能恰在这两者之间
            // 完成。直接按旧快照写 status=EXPIRED 会把刚续费的节点打回已过期。回写前重读一次：
            // 若已被续费推进到未来（ACTIVE 且新到期 > now）→ 放弃覆盖，并立即在面板侧复活
            // （本 cron 刚 disable 过它，续费激活的 enable 若已完成则幂等无害）。
            const fresh = await this.prisma.socksNode.findUnique({
              where: { id: node.id },
              select: { status: true, expiryTime: true },
            });
            if (fresh && fresh.status === 'ACTIVE') {
              const freshExpiresAt = fresh.expiryTime ? new Date(fresh.expiryTime).getTime() : null;
              if (freshExpiresAt !== null && freshExpiresAt > now) {
                try {
                  await this.setSocksInboundEnabled(node, true);
                } catch (e) {
                  this.logger.warn(
                    `Failed to re-enable SOCKS node #${node.id} after renewal, will retry next minute: ${e.message}`,
                  );
                }
                continue; // 已被续费复活 → 不覆盖
              }
            }
            await this.prisma.socksNode.update({
              where: { id: node.id },
              data: { status: 'EXPIRED' },
            });
            this.logger.log(`SOCKS node #${node.id} disabled (expired)`);
          }
        } catch (e) {
          this.logger.warn(
            `SOCKS lifecycle failed for node #${node.id}: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      // 只释放自己的锁：token 匹配才 del
      const cur = await this.redis.get(lockKey).catch(() => null);
      if (cur === lockToken) {
        await this.redis.del(lockKey).catch(() => {});
      }
    }
  }

  /**
   * 过期自动删除：面板删入站（面板卸载失败不阻断本地删除 —— 节点早已被 cron 停用，
   * 本地置 DELETED 即完成「商城消失、只能重新购买商品」的交付，残留由面板自愈兜底）。
   * 【CAS 防止续费竞态】本地回写先行且带条件：仅当到期仍落后于宽限期（续费没推进到期、
   * 状态仍是 ACTIVE/EXPIRED）才置 DELETED；命中 0 行说明这毫秒里刚被续费复活 → 放弃
   * 删除（面板入站由续费激活已恢复，绝不能删掉用户刚续费的节点）。
   */
  private async autoDeleteSocksNode(node: any) {
    const GRACE_MS = 24 * 3600 * 1000;
    const claimed = await this.prisma.socksNode.updateMany({
      where: {
        id: node.id,
        status: { in: ['ACTIVE', 'EXPIRED'] },
        expiryTime: { lte: new Date(Date.now() - GRACE_MS) },
      },
      data: { status: 'DELETED' },
    });
    if (claimed.count === 0) {
      this.logger.warn(
        `SOCKS auto-delete skipped for node #${node.id}: state changed (likely renewed concurrently), keeping it`,
      );
      return;
    }
    if (node.inboundId) {
      try {
        await this.serverService.deleteInbound(node.serverId, node.inboundId);
      } catch (e) {
        this.logger.warn(
          `Auto-delete SOCKS inbound #${node.inboundId} failed: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `SOCKS node #${node.id} auto-deleted (expired > 1 day without renewal, repurchase required)`,
    );
    // 名额释放：到期删除 = 释放一个可售名额（与 adminDelete 同语义）
    await this.releaseNodeQuota(node.virtualProductId);
  }

  // ==========================================
  // 用户查询（「我的商品」页合并 /socks-panel/mine，不动 getUserProducts）
  // ==========================================

  async getMySocksNodes(userId: number) {
    const [nodes, proxies] = await Promise.all([
      this.prisma.socksNode.findMany({
        where: { userId, status: { not: 'DELETED' } },
        include: {
          virtualProduct: { select: { id: true, name: true, nameEn: true, deliveryType: true } },
          server: { select: { id: true, name: true, host: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      // 出站池 join：标记每个节点是否已导入到 SocksProxy 台账（供前端按钮状态）
      this.prisma.socksProxy.findMany({
        where: { userId, status: { not: 'DELETED' } },
        select: { host: true, port: true },
      }),
    ]);
    const outboundKeys = new Set(proxies.map((p) => `${p.host}:${p.port}`));
    return nodes.map((n) => ({ ...n, importedToOutbound: outboundKeys.has(`${n.host}:${n.port}`) }));
  }

  /**
   * 用户修改自己的 SOCKS 节点：备注（remark）和/或认证信息（username/password）。
   * - 仅改 remark → 直接更新 DB。
   * - 改 username/password → 基于 panelSnapshot 全量替换面板入站 + 重启 Xray + 更新 DB。
   *   面板更新失败则抛错、DB 不变（绝不出现面板和 DB 认知不一致）。
   */
  async userUpdateNode(
    id: number,
    userId: number,
    dto: { remark?: string; username?: string; password?: string },
  ) {
    const node = await this.prisma.socksNode.findFirst({
      where: { id, userId, status: { not: 'DELETED' } },
    });
    if (!node) throw new NotFoundException('SOCKS 节点不存在或已删除');

    const newRemark = dto.remark?.trim() || null;
    const newUsername = dto.username?.trim() || null;
    const newPassword = dto.password?.trim() || null;
    const credsChanged = newUsername !== null || newPassword !== null;

    // —— 仅改备注：直接更新 DB ——
    if (!credsChanged) {
      return this.prisma.socksNode.update({
        where: { id },
        data: { remark: newRemark },
      });
    }

    // —— 改认证信息：先更新面板入站，成功后再落库 ——
    if (!node.serverId || !node.inboundId) {
      throw new BadRequestException('该节点缺少服务器/面板入站信息，无法在线修改认证');
    }

    const finalUser = newUsername || node.username || '';
    const finalPass = newPassword || node.password || '';
    if (!finalUser || !finalPass) {
      throw new BadRequestException('用户名和密码不能为空');
    }

    // 基于 panelSnapshot 重建完整 payload（全量替换，同 setSocksInboundEnabled 模式）
    const snap =
      node.panelSnapshot && typeof node.panelSnapshot === 'object' ? node.panelSnapshot : {};
    const payload = {
      ...(snap as any),
      enable: true,
      listen: '',
      port: node.port,
      protocol: (snap as any)?.protocol || 'mixed',
    };
    // 修改 settings.accounts[0] 的 user/pass
    if (payload.settings && Array.isArray(payload.settings.accounts) && payload.settings.accounts.length > 0) {
      payload.settings.accounts[0] = {
        ...payload.settings.accounts[0],
        user: finalUser,
        pass: finalPass,
      };
    }

    // 面板全量替换入站
    const res = await this.serverService.updateInbound(node.serverId, node.inboundId, payload);
    if (!res?.success) {
      throw new BadRequestException(`面板入站更新失败：${res?.msg || 'unknown'}`);
    }

    // 重启 Xray 使新认证生效
    const restart = await this.serverService.restartXrayService(node.serverId);
    if (!restart?.success) {
      this.logger.warn(
        `SOCKS node #${id} credential update: Xray restart failed (${restart?.msg}), credentials saved to DB but panel may need manual restart`,
      );
    }

    // 更新 DB
    const connectionUrl = `socks5://${finalUser}:${finalPass}@${node.host}:${node.port}`;
    return this.prisma.socksNode.update({
      where: { id },
      data: {
        remark: newRemark, // 前端表单始终带当前备注；留空 = 清除备注
        username: finalUser,
        password: finalPass,
        connectionUrl,
      },
    });
  }

  // ==========================================
  // 一键导入到 SOCKS 出站池（薄桥，纯新增）
  // ==========================================

  /**
   * 把已购 SOCKS 节点导入到用户的 SocksProxy 台账（买节点「勾选中转」时的出口池）。
   * 两端既有模块零改动：order.service 的 relaySocksId 取值、inbound/server、socks.service
   * 的 addSocks/delete、schema 全部不动；本端点只用 prisma 直接建台账行。
   *
   * 幂等双保险：
   *  (a) 同 (userId, host, port) 的记录已存在（含用户手动加过同地址的情况）→ 直接返回既有条目；
   *  (b) 否则用 v5(确定性 uuid from node.uuid) upsert —— SocksProxy.uuid 唯一约束兜底并发
   *      双击，不会建重复行；用户从「我的 SOCKS」删除后重导，同一确定性 uuid 重建。
   * 生命周期语义：导入 = 快照，与节点生命周期完全解耦 —— 节点过期/自动删除不清理台账行
   * （与现货 SOCKS「无存活校验」一致），用户可在「我的 SOCKS」手动删除。
   * 台账行字段 mirror addSocks；不设 serverId/inboundId，避开任何面板联动语义。
   */
  async importAsOutbound(nodeId: number, userId: number) {
    const node = await this.prisma.socksNode.findUnique({
      where: { id: nodeId },
      include: { virtualProduct: { select: { name: true } } },
    });
    if (!node || node.userId !== userId) {
      throw new NotFoundException('SOCKS 节点不存在');
    }
    if (node.status !== 'ACTIVE') {
      const reason =
        node.status === 'EXPIRED'
          ? '节点已过期，无法导入出站'
          : node.status === 'SUSPENDED'
            ? '节点已被暂停，无法导入出站'
            : '节点已删除，无法导入出站';
      throw new BadRequestException(reason);
    }
    if (!node.host || !node.port) {
      throw new BadRequestException('节点缺少连接信息，无法导入出站');
    }

    // (a) 同 host:port 已存在 → 幂等返回（含手动添加的同地址条目）
    const existing = await this.prisma.socksProxy.findFirst({
      where: { userId, host: node.host, port: node.port },
    });
    if (existing) {
      return { alreadyImported: true, socksProxy: existing };
    }

    // (b) 确定性 uuid upsert：并发双击也只会落一行
    const outboundUuid = uuidv5(SOCKS_IMPORT_TAG + node.uuid, SOCKS_IMPORT_NS);
    const remark = node.virtualProduct
      ? `购买节点 · ${node.virtualProduct.name}`
      : `购买节点 #${node.uuid.slice(0, 8)}`;
    const socksProxy = await this.prisma.socksProxy.upsert({
      where: { uuid: outboundUuid },
      create: {
        uuid: outboundUuid,
        userId,
        host: node.host,
        port: node.port,
        username: node.username || null,
        password: node.password || null,
        remark,
        status: 'ACTIVE',
      },
      update: { remark }, // 已存在的行只会是本端点建的同一节点条目（同 uuid），remark 重写无害
    });

    return { alreadyImported: false, socksProxy };
  }

  // ==========================================
  // 后台管理（与 Inbound admin 同语义：停用=SUSPENDED / 恢复=ACTIVE / 删除=彻底删）
  // ==========================================

  async adminList(page = 1, limit = 20, search?: string) {
    const where: any = { status: { not: 'DELETED' } };
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { remark: { contains: search } },
        { orderNo: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [nodes, total] = await Promise.all([
      this.prisma.socksNode.findMany({
        where,
        include: {
          user: { select: { email: true, username: true } },
          virtualProduct: { select: { id: true, name: true, nameEn: true } },
          server: { select: { id: true, name: true, host: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.socksNode.count({ where }),
    ]);

    return { socksNodes: nodes, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** 后台停用（面板 disable + SUSPENDED）：面板确认成功才置本地状态。 */
  async adminDisable(id: number) {
    const node = await this.prisma.socksNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('SOCKS 节点不存在');
    if (node.status === 'SUSPENDED') throw new BadRequestException('该节点已暂停');
    if (node.status === 'DELETED') throw new BadRequestException('节点已删除');

    // 已到期（EXPIRED）的节点面板侧已在停用态；重复 disable 幂等无害
    const res = await this.setSocksInboundEnabled(node, false);
    if (!res?.success) {
      throw new BadRequestException(`面板停用失败（${res?.msg || '未知错误'}），节点未暂停`);
    }
    return this.prisma.socksNode.update({
      where: { id },
      data: { status: 'SUSPENDED' },
    });
  }

  /** 后台恢复（面板 enable + ACTIVE）。恢复不改变到期时间 —— 已过期节点下一分钟由 cron 再停用。 */
  async adminResume(id: number) {
    const node = await this.prisma.socksNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('SOCKS 节点不存在');
    if (node.status === 'DELETED') throw new BadRequestException('节点已删除');

    const res = await this.setSocksInboundEnabled(node, true);
    if (!res?.success) {
      throw new BadRequestException(`面板启用失败（${res?.msg || '未知错误'}），节点未恢复`);
    }
    return this.prisma.socksNode.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
  }

  /** 后台彻底删除（面板删入站 + 本地 DELETED；续费订单引用 FK ON DELETE SET NULL 自动解绑）。 */
  async adminDelete(id: number) {
    const node = await this.prisma.socksNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('SOCKS 节点不存在');
    if (node.status === 'DELETED') throw new BadRequestException('节点已删除');

    if (node.inboundId && node.serverId) {
      try {
        await this.serverService.deleteInbound(node.serverId, node.inboundId);
      } catch (e) {
        this.logger.warn(
          `Admin delete SOCKS inbound #${node.inboundId} failed: ${(e as Error).message}`,
        );
      }
    }
    // —— 同步清理该节点导出的 SOCKS 出站台账行（host:port 匹配，含用户手动同地址条目）——
    // 用户确认：删除节点后「我的 SOCKS」不再显示该节点的连接串；导入既是死连接，快照一并移除。
    // 仅清理本节点归属用户的台账（授权/tmp 行不受影响），不触碰其他节点的台账语义。
    if (node.host && node.port) {
      const cleaned = await this.prisma.socksProxy.deleteMany({
        where: { userId: node.userId, host: node.host, port: node.port },
      });
      if (cleaned.count > 0) {
        this.logger.log(
          `Admin delete SOCKS node #${id}: cleaned ${cleaned.count} outbound ledger row(s) for ${node.host}:${node.port}`,
        );
      }
    }
    const updated = await this.prisma.socksNode.update({
      where: { id },
      data: { status: 'DELETED' },
    });
    // 名额释放：管理员删除节点 = 释放一个可售名额（与到期自动删除同语义）
    await this.releaseNodeQuota(updated.virtualProductId);
    return updated;
  }

  // ==========================================
  // 私有原语（与 InboundService 同款模式，独立在本模块，不相互耦合）
  // ==========================================

  /** 服务器选择：商品绑定服务器列表内按权重随机挑一台（空数组=全局）；无可用服务器抛错。 */
  private async pickServer(boundIds: number[]): Promise<any> {
    const servers =
      boundIds.length > 0
        ? await this.prisma.server.findMany({
            where: { id: { in: boundIds }, status: 'ACTIVE' },
          })
        : await this.prisma.server.findMany({ where: { status: 'ACTIVE' } });
    if (servers.length === 0) {
      throw new BadRequestException('暂无可用服务器');
    }
    const totalWeight = servers.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;
    for (const server of servers) {
      random -= server.weight;
      if (random <= 0) return server;
    }
    return servers[0];
  }

  /**
   * SOCKS 专用面板备注：SOCKS-<服务器名><1-100 空位序号>（如 SOCKS-香港1）。
   * 与节点计算备注（香港1）错开命名空间 —— 互不挤占序号，面板上一眼区分 SOCKS 与普通节点。
   */
  private async computeRemark(server: { id: number; name: string }): Promise<string> {
    const name = (server.name || 'Node').trim();
    const used = new Set<number>();
    try {
      const res = await this.serverService.getInbounds(server.id);
      const list = Array.isArray(res?.obj) ? res.obj : [];
      const re = new RegExp(
        `^SOCKS-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\d{1,3})$`,
      );
      for (const item of list) {
        const m = typeof item?.remark === 'string' ? item.remark.match(re) : null;
        if (m) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 100) used.add(n);
        }
      }
    } catch (e) {
      this.logger.warn(
        `computeRemark list fetch failed for server ${server.id}: ${e.message}`,
      );
    }
    for (let n = 1; n <= 100; n++) {
      if (!used.has(n)) return `SOCKS-${name}${n}`;
    }
    throw new BadRequestException(`服务器「${name}」SOCKS 节点数已达上限 100，无法继续创建`);
  }

  /**
   * SOCKS 节点端口分配（顺带作「端口范围已占满」前置校验）：
   * - 未配置范围（min/max 为 null）→ 沿用默认随机高位端口 [10000, 65534]；面板 GET 失败
   *   也保持旧行为：warn + 随机端口兜底（由调用方「占用重试」兜底），绝不提前中断交付。
   * - 配置了范围 → 只在 [min,max] 内随机挑未占用端口；整个范围已被占满 → 明确抛错，
   *   不反复打面板重试（此时订单留在 PROCESSING，端口释放后可重试）。
   */
  private async getAvailablePort(
    serverId: number,
    min: number | null = null,
    max: number | null = null,
  ): Promise<number> {
    const rangeConfigured = min != null || max != null;
    const low = min ?? 10000;
    // 默认上限沿用旧行为（随机高位端口最多到 65534）；显式配置则按配置原样使用（含 65535）
    const high = max ?? 65534;
    // rangeValid 已保证 low <= high → span >= 1
    const span = high - low + 1;
    let usedPorts: Set<number> | null = null;
    try {
      const response = await this.serverService.getInbounds(serverId);
      const inbounds = Array.isArray(response?.obj) ? response.obj : [];
      usedPorts = new Set(inbounds.map((i: any) => i.port));
    } catch (e) {
      // 无论是否配置范围，面板 GET 失败都只降级不抛错（与旧版一致；占用冲突由重试兜底）
      this.logger.warn(`Could not fetch inbounds: ${e.message}`);
    }
    if (usedPorts) {
      // 快路径：随机 300 次
      for (let i = 0; i < 300; i++) {
        const candidate = low + Math.floor(Math.random() * span);
        if (!usedPorts.has(candidate)) return candidate;
      }
      if (rangeConfigured) {
        // 兜底：范围内顺序扫第一个空闲（范围小且几乎占满时随机命中率低）
        for (let p = low; p <= high; p++) {
          if (!usedPorts.has(p)) return p;
        }
        throw new BadRequestException(
          `该商品的端口范围 ${low}-${high} 已被占满，暂无法创建 SOCKS 节点`,
        );
      }
    }
    // 未配置范围（或面板 GET 失败）→ 保持旧行为：均匀随机返回，占用冲突由「占用重试」兜底
    return low + Math.floor(Math.random() * span);
  }

  /**
   * 释放 SOCKS 商品的一个可售名额（sold -1）。
   * - 与 deliverSocksNode 的 sold+1 对称补充：节点被删除（管理员删除 / 到期自动清理）后名额回归，
   *   否则 sold 只增不减会让「已售 n/stock」虚高，且多名额商品删一单后 createOrder 的 sold>=stock
   *   仍会拦掉后来的买家。
   * - 幂等/并发安全：where sold > 0 保证下限不为负；同一商品多个节点并发删除各减各自份额。
   * - sold 减到位后若商品此前因满额被自动置为 SOLD_OUT 且现在有空位 → 恢复 ACTIVE（对称于交付满额置
   *   SOLD_OUT 的自动逻辑)；仅限 SOLD_OUT，绝不覆盖管理员的显式 HIDDEN/ARCHIVED。
   */
  private async releaseNodeQuota(virtualProductId: number | null) {
    if (!virtualProductId) return;
    await this.prisma.virtualProduct.updateMany({
      where: { id: virtualProductId, sold: { gt: 0 } },
      data: { sold: { decrement: 1 } },
    });
    const latest = await this.prisma.virtualProduct.findUnique({
      where: { id: virtualProductId },
      select: { sold: true, stock: true, status: true },
    });
    if (latest && latest.stock != null && latest.sold < latest.stock && latest.status === 'SOLD_OUT') {
      await this.prisma.virtualProduct.updateMany({
        where: { id: virtualProductId, status: 'SOLD_OUT' },
        data: { status: 'ACTIVE' },
      });
      this.logger.log(
        `SOCKS quota released for product #${virtualProductId}: sold ${latest.sold}/${latest.stock} — product back to ACTIVE`,
      );
    }
  }

  /**
   * 对账校准 SOCKS_PANEL 商品的可售名额（手动触发 / 启动自愈共用）。
   * 原理：sold 的权威值 = 现存未删除的节点数（ACTIVE/EXPIRED/SUSPENDED 都占着名额，
   * 只有 DELETED 才算释放）。逐商品重数并回写，附带给「满额被置 SOLD_OUT 但名额已释放」
   * 的商品恢复在售（镜像 releaseNodeQuota 的规则）。返回校准统计供前端展示。
   */
  async reconcileSocksQuota() {
    const products = await this.prisma.virtualProduct.findMany({
      where: { deliveryType: 'SOCKS_PANEL' },
      select: { id: true, name: true, sold: true, stock: true, status: true },
      orderBy: { id: 'asc' },
    });
    const details: any[] = [];
    let changed = 0;
    let restored = 0;
    for (const p of products) {
      const live = await this.prisma.socksNode.count({
        where: { virtualProductId: p.id, status: { not: 'DELETED' } },
      });
      if (live !== p.sold) {
        await this.prisma.virtualProduct.update({
          where: { id: p.id },
          data: { sold: live },
        });
        changed += 1;
        this.logger.warn(
          `[reconcile] SOCKS 商品 #${p.id}「${p.name}」sold 校准 ${p.sold} → ${live}（现存未删除节点数）`,
        );
      }
      if (p.stock != null && live < p.stock && p.status === 'SOLD_OUT') {
        await this.prisma.virtualProduct.updateMany({
          where: { id: p.id, status: 'SOLD_OUT' },
          data: { status: 'ACTIVE' },
        });
        restored += 1;
        this.logger.log(
          `[reconcile] SOCKS 商品 #${p.id}「${p.name}」售罄恢复在售（${live}/${p.stock}）`,
        );
      }
      details.push({ id: p.id, name: p.name, sold: live, stock: p.stock, status: p.status });
    }
    return {
      total: products.length,
      changed,
      restored,
      details,
    };
  }

  private extractInboundId(response: any): number {
    // 兼容少数面板/旧版本：有些会把 id 放在 obj.id / obj / id
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
      this.logger.warn(
        `Cannot locate created SOCKS inbound on server ${serverId}: ${listRes?.msg || 'invalid inbounds/list response'}`,
      );
      return { id: 0, record: null };
    }
    // 端口是唯一关键；remark/protocol 用来避免极端情况下误匹配
    const matched = listRes.obj
      .filter((item: any) => {
        const samePort = Number(item?.port) === Number(inboundData.port);
        const sameRemark = !inboundData.remark || item?.remark === inboundData.remark;
        const sameProtocol = !inboundData.protocol || item?.protocol === inboundData.protocol;
        return samePort && (sameRemark || sameProtocol);
      })
      .sort((a: any, b: any) => Number(b?.id || 0) - Number(a?.id || 0));
    return { id: Number(matched[0]?.id || 0), record: matched[0] || null };
  }

  /** 尽力回收「add 已成功但定位失败」的空入站（仅按端口匹配）。 */
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
          `Orphan SOCKS inbound port=${inboundData.port} (id=${orphan.id}) cleaned on server ${serverId}`,
        );
      }
    } catch (e) {
      this.logger.warn(`Orphan cleanup failed on server ${serverId}: ${e.message}`);
    }
  }

  /** 重载后回读运行中(已落盘)的 Xray 配置，确认 SOCKS 入站真的进了运行态且账号已内嵌。 */
  private async assertSocksLiveInRunningConfig(
    serverId: number,
    inboundId: number,
    port: number,
    username: string,
  ) {
    let raw: any;
    try {
      const res = await this.serverService.getRunningConfigJson(serverId);
      raw =
        typeof res?.obj === 'string'
          ? res.obj
          : res?.obj != null
            ? JSON.stringify(res.obj)
            : '';
    } catch (e) {
      this.logger.warn(`getConfigJson failed on server ${serverId}: ${e.message}`);
      return;
    }
    if (!raw) return;
    try {
      const cfg = JSON.parse(raw);
      const inbounds = Array.isArray(cfg?.inbounds) ? cfg.inbounds : [];
      // 3.6.0 面板自动生成的入站 tag：in-<port>-tcp；tag 或 port+protocol 任一命中即可
      const found = inbounds.find(
        (i: any) =>
          (typeof i?.tag === 'string' && i.tag === `in-${port}-tcp`) ||
          (Number(i?.port) === port && (i?.protocol === 'socks' || i?.protocol === 'mixed')),
      );
      if (!found) {
        throw new Error(`运行配置中未找到 SOCKS 入站 inbound#${inboundId}(port=${port})`);
      }
      const fSettings =
        typeof found?.settings === 'string' ? JSON.parse(found.settings) : found?.settings;
      const accounts = Array.isArray(fSettings?.accounts) ? fSettings.accounts : [];
      const hasUser = accounts.some((a: any) => a?.user === username);
      if (!hasUser) {
        throw new Error(
          `运行配置 SOCKS 入站 #${inboundId}(port=${port}) 缺少账号 ${username} —— 配置生成器未组装`,
        );
      }
      this.logger.log(
        `SOCKS 入站 inbound #${inboundId} 已确认进入 Xray 运行配置（port=${port}，账号 ${username} 内嵌=YES）`,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes('运行配置')) throw e;
      this.logger.warn(`运行配置解析失败: ${(e as Error)?.message}`);
    }
  }

  /** 与 v3.6.0 面板前端 RandomUtil.randomLowerAndNum(len) 同格式：小写字母+数字随机串。 */
  private randomLowerAndNum(length: number): string {
    const seq = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += seq.charAt(Math.floor(Math.random() * seq.length));
    }
    return out;
  }
}