import { Module } from '@nestjs/common';
import { InboundController } from './inbound.controller';
import { InboundService } from './inbound.service';
import { ServerModule } from '../server/server.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [ServerModule, EmailModule], // 到期提醒邮件
  controllers: [InboundController],
  providers: [InboundService],
  exports: [InboundService],
})
export class InboundModule {}
