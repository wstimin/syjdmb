import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [SystemModule], // 邮件配置存放在 SystemSetting（group='email'）
  controllers: [EmailController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}