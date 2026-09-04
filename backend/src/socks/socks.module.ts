import { Module } from '@nestjs/common';
import { SocksController } from './socks.controller';
import { SocksService } from './socks.service';
import { ServerModule } from '../server/server.module';

@Module({
  imports: [ServerModule],
  controllers: [SocksController],
  providers: [SocksService],
  exports: [SocksService],
})
export class SocksModule {}
