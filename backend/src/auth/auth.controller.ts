import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, RefreshTokenDto, ChangePasswordDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  async register(@Req() req: any, @Body() dto: RegisterDto) {
    const result = await this.authService.register(dto, this.getClientIp(req));
    return { success: true, data: result };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login' })
  async login(@Req() req: any, @Body() dto: LoginDto) {
    const result = await this.authService.login(dto, this.getClientIp(req));
    return { success: true, data: result };
  }

  // 取可靠客户端 IP：Express req.ip（socket 地址，不信任 X-Forwarded-For）
  private getClientIp(req: any): string {
    const ip = req?.ip ?? '';
    return String(ip).replace(/^::ffff:/, '').trim();
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh tokens' })
  async refresh(@Body() dto: RefreshTokenDto) {
    const result = await this.authService.refreshTokens(dto.refreshToken);
    return { success: true, data: result };
  }

  // 忘记密码：发送重置链接邮件（统一文案，不暴露邮箱是否注册）
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Req() req: any, @Body() body: { email: string }) {
    await this.authService.forgotPassword(body.email, this.getClientIp(req));
    return { success: true, message: '如果该邮箱已注册，重置链接已发送至邮箱（30 分钟内有效）' };
  }

  // 重置密码：用邮件里的 token 设置新密码（一次性 token）
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with email token' })
  async resetPassword(@Body() body: { token: string; newPassword: string }) {
    await this.authService.resetPassword(body.token, body.newPassword);
    return { success: true, message: '密码已重置，请使用新密码登录' };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout' })
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto.refreshToken);
    return { success: true };
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser('id') userId: number) {
    const profile = await this.authService.getProfile(userId);
    return { success: true, data: profile };
  }
}
