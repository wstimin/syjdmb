import { Module } from '@nestjs/common';
import { InboundController } from './inbound.controller';
import { InboundService } from './inbound.service';
import { ServerModule } from '../server/server.module';
import { EmailModule } from '../email/email.module';
import { PlanModule } from '../plan/plan.module';

@Module({
  imports: [ServerModule, EmailModule, PlanModule], // 到期提醒邮件；删除节点后释放 Plan 可售名额
  controllers: [InboundController],
  providers: [InboundService],
  exports: [InboundService],
})
export class InboundModule {}
