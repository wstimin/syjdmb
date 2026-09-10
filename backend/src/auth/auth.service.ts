import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { EmailService } from '../email/email.service';
import { RegisterDto, LoginDto, AuthResponseDto } from './dto/auth.dto';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { getJwtSecret } from '../common/utils/env';

// 当前安装的 @nestjs/common 未导出 TooManyRequestsException（需要更新的 NestJS 版本才有）：
// 本地定义行为一致、响应码同为 429 的异常类，保证限流语义与 catch 的 instanceof 判断都成立。
class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, 429);
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // 登录防爆破策略（基于 Redis 计数，重启不丢）
  private readonly LOGIN_MAX_FAIL = 5; // 10 分钟内某账号累计失败 5 次
  private readonly LOGIN_WINDOW_SEC = 10 * 60; // 失败计数窗口
  private readonly LOGIN_LOCK_SEC = 15 * 60; // 触发后锁定 15 分钟（密码正确可立即解锁）
  private readonly IP_LOGIN_LIMIT = 100; // 单 IP 10 分钟内最多 100 次登录请求（防洪水，正常用户远达不到）
  private readonly IP_WINDOW_SEC = 10 * 60;
  private readonly IP_REGISTER_LIMIT = 10; // 单 IP 1 小时内最多注册 10 个账号（防刷号）
  private readonly REGISTER_WINDOW_SEC = 3600;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private redis: RedisService,
    private emailService: EmailService,
  ) {}

  async register(dto: RegisterDto, clientIp?: string): Promise<AuthResponseDto> {
    // 邮箱统一规范化（小写+去空格）：注册即归一，杜绝「大小写变体」占号/绕锁
    const email = String(dto.email || '').trim().toLowerCase();

    // 单 IP 注册限流：防批量注册刷号。Redis 故障时放行（fail-open），不把自己搞挂
    try {
      if (clientIp) {
        const ok = await this.redis.checkRateLimit(`auth:ip:reg:${clientIp}`, this.IP_REGISTER_LIMIT, this.REGISTER_WINDOW_SEC);
        if (!ok) {
          throw new TooManyRequestsException('注册过于频繁，请稍后再试 / Too many registrations, try again later');
        }
      }
    } catch (e) {
      if (e instanceof TooManyRequestsException) throw e;
      this.logger.warn(`注册限流检查异常，本次放行: ${(e as Error).message}`);
    }

    // Check existing
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existing) {
      throw new ConflictException('该邮箱已注册');
    }

    // Validate referral code
    let referrerId: number | undefined;
    if (dto.referralCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode: dto.referralCode },
      });
      if (!referrer) {
        throw new BadRequestException('邀请码无效');
      }
      referrerId = referrer.id;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 12);

    try {
      // Create user
      const user = await this.prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          username: dto.username || email.split('@')[0],
          referralCode: uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase(),
          referredBy: referrerId,
        },
      });

      return this.generateTokens(user);
    } catch (e: any) {
      // 并发注册撞唯一键：转成友好错误而不是 500
      if (e && e.code === 'P2002') {
        throw new ConflictException('该邮箱已注册');
      }
      throw e;
    }
  }

  async login(dto: LoginDto, clientIp?: string): Promise<AuthResponseDto> {
    const emailKey = String(dto.email || '').trim().toLowerCase();

    // 登录防爆破检查：只做 IP 限流（防登录洪水）。Redis 故障时放行，避免把自己登录搞挂。
    // 注意：账号锁定检查不放这里——放「密码错误」分支里，保证密码正确时永远能登录并解锁。
    try {
      if (clientIp) {
        const ipOk = await this.redis.checkRateLimit(`auth:ip:login:${clientIp}`, this.IP_LOGIN_LIMIT, this.IP_WINDOW_SEC);
        if (!ipOk) {
          throw new TooManyRequestsException('登录尝试过于频繁，请稍后再试 / Too many attempts, try again later');
        }
      }
    } catch (e) {
      if (e instanceof TooManyRequestsException) throw e;
      this.logger.warn(`登录限流检查异常，本次放行: ${(e as Error).message}`);
    }

    // 大小写不敏感查邮箱：注册时已归一化为小写，这里兼容历史数据/老账号
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: emailKey, mode: 'insensitive' } },
    });

    // 账号不存在或被禁用：统一报「凭据无效」，
    // 不透露「这个邮箱注册过没有 / 账号是什么状态」——防账号枚举与状态探测
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('账号或邮箱密码错误');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      // 只有密码错误才走这里：失败计数 + 锁定。
      // 密码正确 → 直接跳过本分支并解锁，攻击者无法用「试错制造锁定」来挡真实用户登录
      try {
        const locked = await this.redis.exists(`auth:lock:${emailKey}`);
        if (locked) {
          const mins = Math.round(this.LOGIN_LOCK_SEC / 60);
          throw new TooManyRequestsException(`登录失败次数过多，账号已临时锁定，请 ${mins} 分钟后再试 / Account locked, try again in ${mins} minutes`);
        }
        const fails = await this.redis.incrWithWindow(`auth:fail:${emailKey}`, this.LOGIN_WINDOW_SEC);
        if (fails >= this.LOGIN_MAX_FAIL) {
          await this.redis.set(`auth:lock:${emailKey}`, '1', this.LOGIN_LOCK_SEC);
          await this.redis.del(`auth:fail:${emailKey}`);
          const mins = Math.round(this.LOGIN_LOCK_SEC / 60);
          throw new TooManyRequestsException(`登录失败次数过多，账号已临时锁定，请 ${mins} 分钟后再试 / Account locked, try again in ${mins} minutes`);
        }
      } catch (e) {
        if (e instanceof TooManyRequestsException) throw e;
        this.logger.warn(`登录失败计数异常: ${(e as Error).message}`);
      }
      throw new UnauthorizedException('账号或邮箱密码错误');
    }

    // 登录成功：清空该账号的失败计数与锁定
    try {
      await this.redis.del(`auth:fail:${emailKey}`);
      await this.redis.del(`auth:lock:${emailKey}`);
    } catch (e) {
      this.logger.warn(`清除失败计数异常: ${(e as Error).message}`);
    }

    return this.generateTokens(user);
  }

  async refreshTokens(refreshToken: string): Promise<AuthResponseDto> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: getJwtSecret(),
      });

      // Check if token is blacklisted
      const isBlacklisted = await this.redis.get(`bl:${refreshToken}`);
      if (isBlacklisted) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }

      // 密码重置后旧令牌立即失效：签发于重置时间之前的刷新令牌一律拒绝。
      // 重置密码会写入 auth:pwr:<userId> 时间戳（8 天有效，覆盖 refresh 最长 7 天）。
      const passwordResetAt = await this.redis.get(`auth:pwr:${payload.sub}`).catch(() => null);
      if (passwordResetAt && Number(payload.iat || 0) < Number(passwordResetAt)) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('用户不存在或已停用');
      }

      // Blacklist old refresh token
      await this.redis.set(`bl:${refreshToken}`, '1', 7 * 24 * 3600);

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.redis.set(`bl:${refreshToken}`, '1', 7 * 24 * 3600);
  }

  // ==========================================
  // 忘记密码 / 重置密码（Redis 一次性 token + 邮件通知）
  // ==========================================

  /**
   * 申请重置：生成 30 分钟有效的一次性 token 存 Redis，重置链接邮件发给用户。
   * 账号不存在也正常返回（不抛错）——统一文案防账号枚举；IP 限流防刷信轰炸。
   */
  async forgotPassword(emailInput: string, clientIp?: string): Promise<void> {
    const emailKey = String(emailInput || '').trim().toLowerCase();

    // 邮件服务未开启时直接明确报错，绝不「假装已发送」：
    // 否则用户永远收不到重置链接却看到成功提示，白白锁在外面。
    // （这是配置状态提示，与账号是否存在无关，不构成枚举。）
    if (!(await this.emailService.isEnabled())) {
      throw new BadRequestException('邮件服务未开启，暂时无法通过邮件重置密码，请联系管理员');
    }

    // 单 IP 限流（1 小时 5 次）。Redis 故障放行，别把自己搞挂
    try {
      if (clientIp) {
        const ok = await this.redis.checkRateLimit(`auth:ip:fp:${clientIp}`, 5, 3600);
        if (!ok) {
          throw new TooManyRequestsException('发送过于频繁，请稍后再试 / Too many requests, try again later');
        }
      }
    } catch (e) {
      if (e instanceof TooManyRequestsException) throw e;
      this.logger.warn(`忘记密码限流检查异常，本次放行: ${(e as Error).message}`);
    }

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: emailKey, mode: 'insensitive' } },
    });
    if (!user) {
      // 不暴露邮箱是否注册：控制器统一返回「已发送」文案
      this.logger.log(`forgot-password requested for unknown email: ${emailKey}`);
      return;
    }

    const token = randomBytes(24).toString('hex'); // 48 位随机 hex，不可枚举
    await this.redis.set(`auth:reset:${token}`, user.email, 30 * 60); // 30 分钟有效

    const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
    const link = `${frontend}/reset-password?token=${token}`;
    const ok = await this.emailService.send({
      to: user.email,
      subject: '重置密码确认',
      html: this.emailService.wrap(
        '重置密码',
        `<p>您好：</p>
         <p>我们收到了重置密码的请求。点击下方按钮在 <b>30 分钟内</b>完成重置：</p>
         <p style="margin:24px 0;">
           <a href="${link}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 28px;border-radius:8px;text-decoration:none;font-weight:600;">重置密码</a>
         </p>
         <p style="color:#6b7280;word-break:break-all;">如果按钮无法点击，请复制以下链接到浏览器：<br/><a href="${link}" style="color:#4f46e5;">${link}</a></p>
         <p>如果不是你本人的操作，请忽略本邮件，你的密码不会被修改。</p>`,
      ),
    });
    if (!ok) {
      this.logger.warn(`重置密码邮件发送失败: ${user.email}`);
    }
  }

  /** 校验 token → 改密。token 一次性：用后即焚。 */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token) throw new BadRequestException('重置链接无效或已过期，请重新申请');
    if (!newPassword || String(newPassword).length < 6) {
      throw new BadRequestException('新密码至少 6 位');
    }
    if (String(newPassword).length > 128) {
      throw new BadRequestException('新密码过长');
    }

    const email = await this.redis.get(`auth:reset:${token}`);
    if (!email) throw new BadRequestException('重置链接无效或已过期，请重新申请');

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!user) throw new BadRequestException('重置链接无效或已过期，请重新申请');

    const hashed = await bcrypt.hash(String(newPassword), 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    // 使该账号所有已签发的刷新令牌立即失效（与 iat 比对，见 refreshTokens）。
    // 否则受害者重置密码后，之前被盗的 refresh token 仍可换新会话最长 7 天。
    try {
      await this.redis.set(
        `auth:pwr:${user.id}`,
        String(Math.floor(Date.now() / 1000)),
        8 * 24 * 3600,
      );
    } catch (e) {
      this.logger.warn(`记录密码重置时间失败: ${(e as Error).message}`);
    }

    // 一次性 token：用完即焚，防重放。Redis 故障时忽略删除（密码已改、pwr 标记已生效；
    // 残留 token 最长 30 分钟自动过期，若期间被重放只是再改一次密码）。
    try {
      await this.redis.del(`auth:reset:${token}`);
    } catch (e) {
      this.logger.warn(`清除重置 token 失败（残留至 30 分钟自动过期）: ${(e as Error).message}`);
    }
    this.logger.log(`Password reset completed for user ${user.id}`);
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        uuid: true,
        email: true,
        username: true,
        role: true,
        status: true,
        avatar: true,
        balance: true,
        language: true,
        referralCode: true,
        createdAt: true,
        _count: {
          select: {
            orders: { where: { status: 'COMPLETED' } },
            referrals: true,
          },
        },
      },
    });
    return user;
  }

  private generateTokens(user: any): AuthResponseDto {
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_EXPIRES_IN') || '15m',
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN') || '7d',
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        username: user.username,
        role: user.role,
        avatar: user.avatar,
      },
    };
  }
}
