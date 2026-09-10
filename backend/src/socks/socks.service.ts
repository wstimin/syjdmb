import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class SocksService {
  private readonly logger = new Logger(SocksService.name);

  constructor(private prisma: PrismaService) {}

  // ==========================================
  // User: Add user-supplied SOCKS proxy (台账)
  // ==========================================
  //
  // 注意：SOCKS「中转」已改为【购买时勾选】，在源节点上挂 SOCKS 出站+路由
  // （见 inbound.service.createInbound + server.service.ensureSocks*）。
  // 这里保留「用户自填 SOCKS 服务器」作为账本记录，后台再增加管理员建账+授权。

  async addSocks(params: {
    userId: number;
    host: string;
    port: number;
    username?: string;
    password?: string;
    remark?: string;
  }) {
    if (!params.host || !params.port) {
      throw new BadRequestException('请填写地址与端口');
    }

    const proxy = await this.prisma.socksProxy.create({
      data: {
        userId: params.userId,
        host: params.host,
        port: params.port,
        username: params.username || null,
        password: params.password || null,
        remark: params.remark || 'User SOCKS proxy',
        status: 'ACTIVE',
      },
    });

    return proxy;
  }

  // ==========================================
  // Admin: 创建 SOCKS 并「绑定给用户」（归属 + 可单独授权）
  // ==========================================

  /**
   * 后台新建 SOCKS：ownerUserId = 归属用户（出现在其台账、购买中转可选）；
   * grantUserIds = 另授权给其他用户使用（不出现在归属台账编辑权，但可选作中转出口）。
   * 归属用户重复出现在授权列表时自动剔除；重复项去重。
   */
  async createAdmin(params: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    remark?: string;
    ownerUserId: number;
    grantUserIds?: number[];
  }) {
    if (!params.host || !String(params.host).trim()) {
      throw new BadRequestException('请填写 SOCKS 地址');
    }
    if (!(Number(params.port) > 0)) {
      throw new BadRequestException('请填写正确的端口');
    }

    const owner = await this.prisma.user.findUnique({
      where: { id: Number(params.ownerUserId) },
    });
    if (!owner) throw new BadRequestException('归属用户不存在');

    const grantIds = (params.grantUserIds || [])
      .map(Number)
      .filter((id) => id !== Number(params.ownerUserId)) // 归属用户不必重复授权
      .filter((id, i, arr) => arr.indexOf(id) === i); // 去重
    for (const id of grantIds) {
      const u = await this.prisma.user.findUnique({ where: { id } });
      if (!u) throw new BadRequestException(`授权用户 ${id} 不存在`);
    }

    const proxy = await this.prisma.socksProxy.create({
      data: {
        userId: Number(params.ownerUserId),
        host: String(params.host).trim(),
        port: Number(params.port),
        username: params.username ? String(params.username).trim() || null : null,
        password: params.password ? String(params.password) : null,
        remark: params.remark ? String(params.remark).trim() || null : null,
        status: 'ACTIVE',
        grants: grantIds.length ? { create: grantIds.map((userId) => ({ userId })) } : undefined,
      },
    });

    return proxy;
  }

  // ==========================================
  // Queries
  // ==========================================

  /**
   * 用户可用 SOCKS = 归属的 + 被单独授权的，且未删除。
   * owned 标记区分归属/授权：归属项返回完整连接串（含密码），授权项只给地址端口不泄露密码。
   */
  async getMyProxies(userId: number) {
    const proxies = await this.prisma.socksProxy.findMany({
      where: {
        status: { not: 'DELETED' },
        OR: [{ userId }, { grants: { some: { userId } } }],
      },
      include: {
        server: { select: { name: true } },
        user: { select: { id: true, email: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return proxies.map((p) => {
      const owned = p.userId === userId;
      let connection = `socks5://${p.host}:${p.port}`;
      if (owned && p.username) {
        const auth = `${p.username}:${p.password || ''}@`;
        connection = `socks5://${auth}${p.host}:${p.port}`;
      }
      const { id, host, port, username, status, remark, serverId, server, uuid, protocol, createdAt, updatedAt } = p;
      return {
        id,
        host,
        port,
        username,
        status,
        remark,
        serverId,
        server,
        uuid,
        protocol,
        createdAt,
        updatedAt,
        owner: p.user,
        owned,
        connectionString: connection,
      };
    });
  }

  async findById(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const proxy = await this.prisma.socksProxy.findFirst({ where });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');
    return proxy;
  }

  async findAll(page = 1, limit = 20, search?: string) {
    const where: any = { status: { not: 'DELETED' } };
    if (search) {
      where.OR = [
        { host: { contains: search } },
        { remark: { contains: search } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [proxies, total] = await Promise.all([
      this.prisma.socksProxy.findMany({
        where,
        include: {
          user: { select: { email: true, username: true } },
          server: { select: { name: true } },
          _count: { select: { grants: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.socksProxy.count({ where }),
    ]);

    return { proxies, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ==========================================
  // Management
  // ==========================================

  async update(id: number, userId: number, data: any) {
    const proxy = await this.prisma.socksProxy.findFirst({ where: { id, userId } });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');

    return this.prisma.socksProxy.update({
      where: { id },
      data: {
        host: data.host ?? proxy.host,
        port: data.port ?? proxy.port,
        username: data.username !== undefined ? data.username : proxy.username,
        password: data.password !== undefined ? data.password : proxy.password,
        remark: data.remark !== undefined ? data.remark : proxy.remark,
      },
    });
  }

  /** 后台编辑：host/port/凭据/备注，可换归属用户（ownerUserId）。 */
  async updateAdmin(id: number, data: any) {
    const proxy = await this.prisma.socksProxy.findUnique({ where: { id } });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');

    const patch: any = {};
    if (data.host !== undefined) {
      if (!String(data.host).trim()) throw new BadRequestException('请填写 SOCKS 地址');
      patch.host = String(data.host).trim();
    }
    if (data.port !== undefined) {
      if (!(Number(data.port) > 0)) throw new BadRequestException('端口必须为正整数');
      patch.port = Number(data.port);
    }
    if (data.username !== undefined) patch.username = data.username ? String(data.username) : null;
    if (data.password !== undefined) patch.password = data.password ? String(data.password) : null;
    if (data.remark !== undefined) patch.remark = data.remark ? String(data.remark) : null;
    if (data.ownerUserId !== undefined && Number(data.ownerUserId) !== proxy.userId) {
      const owner = await this.prisma.user.findUnique({ where: { id: Number(data.ownerUserId) } });
      if (!owner) throw new BadRequestException('归属用户不存在');
      patch.userId = Number(data.ownerUserId);
    }

    return this.prisma.socksProxy.update({ where: { id }, data: patch });
  }

  /**
   * 删除 = 彻底删除（物理删行，授权记录级联清除）。
   * 正在被节点使用的中转不受影响：节点上存的是 host/port 快照列，与本地台账解耦。
   */
  async delete(id: number, userId?: number) {
    const where: any = { id };
    if (userId) where.userId = userId;

    const proxy = await this.prisma.socksProxy.findFirst({ where });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');

    await this.prisma.socksProxy.delete({ where: { id } });
    return { success: true, id };
  }

  /** 后台删除任意 SOCKS（物理删）。 */
  async deleteAdmin(id: number) {
    return this.delete(id);
  }

  async changeStatus(id: number, status: 'ACTIVE' | 'INACTIVE') {
    const proxy = await this.prisma.socksProxy.findUnique({ where: { id } });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');
    return this.prisma.socksProxy.update({ where: { id }, data: { status } });
  }

  // ==========================================
  // 授权管理（「绑定给用户」的单独授权部分）
  // ==========================================

  async listGrants(id: number) {
    const proxy = await this.prisma.socksProxy.findUnique({ where: { id } });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');
    return this.prisma.socksGrant.findMany({
      where: { socksProxyId: id },
      include: { user: { select: { id: true, email: true, username: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addGrant(id: number, grantUserId: number) {
    const proxy = await this.prisma.socksProxy.findUnique({ where: { id } });
    if (!proxy) throw new NotFoundException('SOCKS 代理不存在');
    const u = await this.prisma.user.findUnique({ where: { id: Number(grantUserId) } });
    if (!u) throw new BadRequestException('授权用户不存在');
    if (Number(grantUserId) === proxy.userId) {
      throw new BadRequestException('该用户已是归属用户，无需重复授权');
    }
    try {
      return await this.prisma.socksGrant.create({
        data: { socksProxyId: id, userId: Number(grantUserId) },
      });
    } catch (e: any) {
      if (e && e.code === 'P2002') throw new BadRequestException('该用户已在授权列表');
      throw e;
    }
  }

  async removeGrant(id: number, grantUserId: number) {
    const deleted = await this.prisma.socksGrant.deleteMany({
      where: { socksProxyId: id, userId: Number(grantUserId) },
    });
    if (deleted.count === 0) throw new NotFoundException('授权记录不存在');
    return { success: true };
  }

  async getStats() {
    const [total, active] = await Promise.all([
      this.prisma.socksProxy.count({ where: { status: { not: 'DELETED' } } }),
      this.prisma.socksProxy.count({ where: { status: 'ACTIVE' } }),
    ]);
    return { total, active, inactive: total - active };
  }
}