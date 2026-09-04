import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class AnnouncementService {
  constructor(private prisma: PrismaService) {}

  async findAllActive(lang = 'zh') {
    const now = new Date();
    const announcements = await this.prisma.announcement.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });

    // Return localized fields
    return announcements.map((a) => ({
      id: a.id,
      title: lang === 'en' && a.titleEn ? a.titleEn : a.title,
      content: lang === 'en' && a.contentEn ? a.contentEn : a.content,
      type: a.type,
      isPinned: a.isPinned,
      createdAt: a.createdAt,
    }));
  }

  async findAll(page = 1, limit = 20) {
    const [announcements, total] = await Promise.all([
      this.prisma.announcement.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.announcement.count(),
    ]);
    return { announcements, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: number) {
    const announcement = await this.prisma.announcement.findUnique({ where: { id } });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  async create(data: any) {
    return this.prisma.announcement.create({ data });
  }

  async update(id: number, data: any) {
    const announcement = await this.prisma.announcement.findUnique({ where: { id } });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return this.prisma.announcement.update({ where: { id }, data });
  }

  async remove(id: number) {
    const announcement = await this.prisma.announcement.findUnique({ where: { id } });
    if (!announcement) throw new NotFoundException('Announcement not found');
    await this.prisma.announcement.delete({ where: { id } });
    return { message: 'Announcement deleted' };
  }
}
