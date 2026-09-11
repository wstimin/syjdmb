import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService) {}

  private readonly publicSelect = {
    id: true,
    name: true,
    nameEn: true,
    scope: true,
    sort: true,
  } as const;

  /**
   * 分类列表（公开接口，?scope=PLAN|VIRTUAL 可筛）。商城/后台共用。
   * 排序：scope、sort 升序、id 升序（后建的在先建之后，稳定）。
   */
  async findAll(scope?: string) {
    const where: any = {};
    if (scope === 'PLAN' || scope === 'VIRTUAL') {
      where.scope = scope;
    }
    return this.prisma.category.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { sort: 'asc' }, { id: 'asc' }],
      select: this.publicSelect,
    });
  }

  async create(data: any) {
    this.assertValid(data);
    // 唯一约束 (scope, name)：同 scope 内同名分类拦截
    const dup = await this.prisma.category.findFirst({
      where: { scope: data.scope, name: data.name },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('同范围内已存在同名分类');
    return this.prisma.category.create({
      data: {
        name: data.name,
        nameEn: data.nameEn || null,
        scope: data.scope || 'VIRTUAL',
        sort: Number(data.sort) || 0,
      },
    });
  }

  async update(id: number, data: any) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('分类不存在');

    // 名称/作用域变更时校验唯一（排除自身）
    if (data.name != null || data.scope != null) {
      const name = data.name ?? existing.name;
      const scope = data.scope ?? existing.scope;
      if (!name) throw new BadRequestException('分类名称不能为空');
      const dup = await this.prisma.category.findFirst({
        where: { scope, name, id: { not: id } },
        select: { id: true },
      });
      if (dup) throw new BadRequestException('同范围内已存在同名分类');
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        ...(data.name != null ? { name: data.name } : {}),
        ...(data.nameEn != null ? { nameEn: data.nameEn } : {}),
        ...(data.scope != null ? { scope: data.scope } : {}),
        ...(data.sort != null ? { sort: Number(data.sort) || 0 } : {}),
      },
    });
  }

  /**
   * 删除分类。绑定商品经 FK ON DELETE SET NULL 自动回到「未分类」，
   * 不触碰 Plan/VirtualProduct 数据本身。
   */
  async remove(id: number) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('分类不存在');
    await this.prisma.category.delete({ where: { id } });
    return { message: 'Category deleted' };
  }

  // 创建时校验：name 必填、scope 取值合法
  private assertValid(data: any) {
    if (!data.name || !String(data.name).trim()) {
      throw new BadRequestException('分类名称不能为空');
    }
    if (data.scope != null && data.scope !== 'PLAN' && data.scope !== 'VIRTUAL') {
      throw new BadRequestException('适用范围只能是 PLAN（网络产品）或 VIRTUAL（NP店铺）');
    }
  }
}