import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ServerModule } from './server/server.module';
import { InboundModule } from './inbound/inbound.module';
import { PlanModule } from './plan/plan.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { CardModule } from './card/card.module';
import { SocksModule } from './socks/socks.module';
import { TicketModule } from './ticket/ticket.module';
import { AnnouncementModule } from './announcement/announcement.module';
import { SystemModule } from './system/system.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { LoggerMiddleware } from './common/middleware/logger.middleware';

@Module({
  imports: [
    // Global config
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database & Cache
    PrismaModule,
    RedisModule,

    // Scheduling（用于节点到期/流量检查定时任务）
    ScheduleModule.forRoot(),

    // Feature modules
    AuthModule,
    UserModule,
    ServerModule,
    InboundModule,
    PlanModule,
    OrderModule,
    PaymentModule,
    CardModule,
    SocksModule,
    TicketModule,
    AnnouncementModule,
    SystemModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
