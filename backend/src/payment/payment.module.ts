import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { OrderModule } from '../order/order.module';
import { SystemModule } from '../system/system.module';

import { CouponModule } from '../coupon/coupon.module';

@Module({
  imports: [OrderModule, SystemModule, CouponModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
