import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { InboundModule } from '../inbound/inbound.module';
import { ServerModule } from '../server/server.module';
import { CouponModule } from '../coupon/coupon.module';

@Module({
  imports: [InboundModule, ServerModule, CouponModule],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
