import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EmailService } from './email.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Email')
@Controller('email')
export class EmailController {
  constructor(private emailService: EmailService) {}

  // 管理后台「邮件通知」配置页的「发送测试邮件」按钮 → 验证 webhook 是否打通
  @Post('test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Send a test email' })
  async test(@Body() body: { to: string }) {
    if (!body.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.to)) {
      return { success: false, message: '邮箱地址格式不正确' };
    }
    const ok = await this.emailService.send({
      to: body.to,
      subject: 'NodeShop 邮件通知测试',
      html: this.emailService.wrap(
        '邮件通知测试',
        `<p>如果你收到这封邮件，说明邮件通知通道已打通。<br/>如需调整收件配置，请前往管理后台「系统设置 → 邮件通知」。</p>`,
      ),
    });
    return ok
      ? { success: true, message: `测试邮件已发送至 ${body.to}` }
      : { success: false, message: '邮件发送失败，请检查 webhook 配置' };
  }
}