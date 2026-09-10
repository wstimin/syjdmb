import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class VirtualProductService {
  constructor(private prisma: PrismaService) {}

  // 商城公共字段（含未售码剩余数：AUTO 商品用「剩余交付码=0」提示售罄）
  private readonly publicSelect = {
    id: true,
    name: true,
    nameEn: true,
    description: true,
    descriptionEn: true,
    price: true,
    originalPrice: true,
    coverUrl: true,
    deliveryType: true,
    // SOCKS_PANEL 交付字段：时长（天）+ 绑定服务器（空数组=全局，激活时加权随机挑）
    duration: true,
    serverIds: true,
    sort: true,
    status: true,
    sold: true,
    _count: { select: { keys: { where: { status: 'UNUSED' } } } },
  } as const;

  // ---- Public ----
  async findActive() {
    return this.prisma.virtualProduct.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { price: 'asc' }],
      select: this.publicSelect,
    });
  }

  async findById(id: number) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id },
      select: this.publicSelect,
    });
    if (!product || product.status !== 'ACTIVE') {
      throw new NotFoundException('虚拟商品不存在');
    }
    return product;
  }

  // ---- Admin ----
  async findAllAdmin() {
    return this.prisma.virtualProduct.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'desc' }],
      include: {
        _count: {
          select: {
            keys: { where: { status: 'UNUSED' } },
          },
        },
      },
    });
  }

  async create(data: any) {
    return this.prisma.virtualProduct.create({ data });
  }

  async update(id: number, data: any) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('虚拟商品不存在');
    return this.prisma.virtualProduct.update({ where: { id }, data });
  }

  async remove(id: number) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundException('虚拟商品不存在');

    // 有成交订单的商品不允许物理删除（保留订单里的商品名快照能力），引导改为 ARCHIVED 下架
    const hasOrders = await this.prisma.order.count({
      where: { virtualProductId: id, status: { in: ['PAID', 'COMPLETED'] } },
    });
    if (hasOrders > 0) {
      throw new BadRequestException('该商品已有成交订单，无法删除；可将状态改为 ARCHIVED 下架');
    }

    await this.prisma.virtualProduct.delete({ where: { id } });
    return { message: 'Virtual product deleted' };
  }

  // ---- 交付码库 ----
  async listKeys(productId: number, status?: string, page = 1, limit = 50) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id: productId },
      select: { id: true, deliveryType: true },
    });
    if (!product) throw new NotFoundException('虚拟商品不存在');

    const where: any = { productId };
    if (status && (status === 'UNUSED' || status === 'SOLD')) where.status = status;

    const [keys, total, unused] = await Promise.all([
      this.prisma.productKey.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.productKey.count({ where }),
      product.deliveryType === 'AUTO'
        ? this.prisma.productKey.count({ where: { productId, status: 'UNUSED' } })
        : Promise.resolve(0),
    ]);

    return { keys, total, unused, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async addKeys(productId: number, text: string) {
    const product = await this.prisma.virtualProduct.findUnique({
      where: { id: productId },
      select: { id: true, deliveryType: true },
    });
    if (!product) throw new NotFoundException('虚拟商品不存在');

    // 每行一个码；去空行、去首尾空白；行内多段（账号/密码/链接）作为完整交付内容保留
    const codes = String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (codes.length === 0) {
      throw new BadRequestException('请输入至少一个交付码（每行一个）');
    }

    // 批内去重 + 与库内既有码去重（createMany skipDuplicates 幂等）
    const unique = [...new Set(codes)];
    const created = await this.prisma.productKey.createMany({
      data: unique.map((code) => ({ productId, code })),
      skipDuplicates: true,
    });

    return { added: created.count, totalText: codes.length, skippedText: codes.length - unique.length };
  }

  async removeKey(keyId: number) {
    // 仅未售码可删除（SOLD 码保留审计，防止删除后订单交付内容失联）
    const claimed = await this.prisma.productKey.deleteMany({
      where: { id: keyId, status: 'UNUSED' },
    });
    if (claimed.count === 0) {
      const key = await this.prisma.productKey.findUnique({
        where: { id: keyId },
        select: { status: true },
      });
      if (!key) throw new NotFoundException('交付码不存在');
      throw new BadRequestException('该交付码已售出，不能删除');
    }
  }
}