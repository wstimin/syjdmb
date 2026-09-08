import { Module } from '@nestjs/common';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { CouponModule } from '../coupon/coupon.module';
import { InboundModule } from '../inbound/inbound.module';
import { EmailModule } from '../email/email.module';

@Module({
  // 退款涉及：优惠券名额回收（releaseCoupon）、节点停用（suspend）、邮件通知（EmailService）
  imports: [CouponModule, InboundModule, EmailModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}