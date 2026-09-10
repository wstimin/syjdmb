import { Module } from '@nestjs/common';
import { SocksPanelController } from './socks-panel.controller';
import { SocksPanelService } from './socks-panel.service';
import { ServerModule } from '../server/server.module';

// PrismaService / RedisService 为全局注入，无需在此 import。
// OrderModule import 本模块以在 activateOrderInner 派发交付/续费。
@Module({
  imports: [ServerModule], // ServerService：面板 inbounds 级操作
  controllers: [SocksPanelController],
  providers: [SocksPanelService],
  exports: [SocksPanelService],
})
export class SocksPanelModule {}