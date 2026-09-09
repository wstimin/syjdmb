import { Module } from '@nestjs/common';
import { VirtualProductController } from './virtual-product.controller';
import { VirtualProductService } from './virtual-product.service';

@Module({
  controllers: [VirtualProductController],
  providers: [VirtualProductService],
  exports: [VirtualProductService],
})
export class VirtualProductModule {}