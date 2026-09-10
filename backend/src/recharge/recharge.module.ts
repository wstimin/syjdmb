import { Module } from '@nestjs/common';
import { RechargeController } from './recharge.controller';
import { RechargeService } from './recharge.service';
import { PaymentModule } from '../payment/payment.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [PaymentModule, SystemModule], // 复用微信/支付宝下单与回调入账；SystemModule 供超时配置
  controllers: [RechargeController],
  providers: [RechargeService],
  exports: [RechargeService],
})
export class RechargeModule {}