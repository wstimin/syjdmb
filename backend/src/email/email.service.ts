import { Injectable, Logger } from '@nestjs/common';
import { SystemService } from '../system/system.service';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private systemService: SystemService) {}

  /**
   * 邮件配置（管理后台「系统设置」→ 邮件通知）：
   * - emailEnabled：总开关
   * - emailProvider：log（仅写日志，开发/自托管调试用）| webhook（HTTP 推送，无 SMTP 依赖）
   * - emailWebhookUrl / emailWebhookToken：webhook 接收端（如报警/邮件转发服务）
   * SMTP 暂不接入（无 nodemailer 依赖），webhook 已覆盖绝大多数自托管场景。
   */
  private async getConfig() {
    const s = await this.systemService.getSettings('email');
    return {
      enabled: s.emailEnabled === true || s.emailEnabled === 'true',
      provider: s.emailProvider || 'log',
      webhookUrl: s.emailWebhookUrl || '',
      webhookToken: s.emailWebhookToken || '',
      fromName: s.emailFromName || 'NodeShop',
      fromAddr: s.emailFromAddr || '',
    };
  }

  /** 邮件通知总开关（到期提醒 cron 用它判断「要不要推进提醒档位」） */
  async isEnabled(): Promise<boolean> {
    const cfg = await this.getConfig();
    return cfg.enabled;
  }

  /**
   * 发送邮件。通知类邮件尽力而为：
   * - provider=log：不真正发信，把内容打到日志（默认，保证「设置了开关就能用」）
   * - provider=webhook：POST JSON 到 webhookUrl，附带 Bearer token（如有）
   * 失败只告警不抛错 —— 忘记密码有 Redis token 兜底，到期提醒有档位标记不会重复发。
   */
  async send(options: { to: string; subject: string; html: string; text?: string }): Promise<boolean> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) {
      this.logger.log(`[email disabled, skipped] -> ${options.to}: ${options.subject}`);
      return true;
    }

    const payload = {
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || '',
      fromName: cfg.fromName,
      fromAddr: cfg.fromAddr,
    };

    if (cfg.provider === 'webhook' && cfg.webhookUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.webhookToken ? { Authorization: `Bearer ${cfg.webhookToken}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          this.logger.warn(`邮件 webhook 返回非 2xx (${res.status}) -> ${options.to}`);
          return false;
        }
        return true;
      } catch (e) {
        this.logger.warn(`邮件 webhook 推送失败 (${options.to}): ${(e as Error).message}`);
        return false;
      }
    }

    // 默认/兜底：写日志（自托管用户可在此挂第三方日志采集转邮件）
    this.logger.log(`[email] to=${options.to} subject=${options.subject} body=${(options.html || '').slice(0, 400)}`);
    return true;
  }

  /** 清理纯文本中的敏感字符（仅用于 HTML 内嵌，防注入） */
  escapeHtml(input: string): string {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 统一邮件外壳（简单内联样式，兼容大多数客户端） */
  wrap(subject: string, bodyHtml: string): string {
    return `<!DOCTYPE html><html lang="zh"><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
<div style="background:#4f46e5;padding:20px 28px;color:#ffffff;font-size:16px;font-weight:600;">${this.escapeHtml(subject)}</div>
<div style="padding:28px;color:#1f2937;font-size:14px;line-height:1.7;">${bodyHtml}</div>
<div style="padding:16px 28px;border-top:1px solid #eee;color:#9ca3af;font-size:12px;">此邮件由系统自动发送，请勿直接回复。</div>
</div></body></html>`;
  }
}