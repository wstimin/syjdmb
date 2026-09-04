import { Module } from '@nestjs/common';
import { SocksController } from './socks.controller';
import { SocksService } from './socks.service';

@Module({
  controllers: [SocksController],
  providers: [SocksService],
  exports: [SocksService],
})
export class SocksModule {}
