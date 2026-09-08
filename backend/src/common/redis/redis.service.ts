import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  // SETNX：仅在 key 不存在时设置并返回 true（用于分布式锁）
  async setNx(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const result = ttlSeconds
      ? await this.client.set(key, value, 'EX', ttlSeconds, 'NX')
      : await this.client.set(key, value, 'NX');
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  // 原子计数 + 首建设置 TTL（Lua 一条命令内完成）：
  // 避免「incr 成功、进程在 expire 前崩溃 → 计数器永远不过期」的脏键。
  // 顺带自愈：旧模式留下的无 TTL 计数器（ttl<0）也会被补上过期时间。
  private readonly INCR_WITH_WINDOW_LUA = `
    local cur = redis.call('incr', KEYS[1])
    if cur == 1 then
      redis.call('expire', KEYS[1], ARGV[1])
    else
      local t = redis.call('ttl', KEYS[1])
      if t < 0 then
        redis.call('expire', KEYS[1], ARGV[1])
      end
    end
    return cur`;

  async incrWithWindow(key: string, windowSeconds: number): Promise<number> {
    const current = await this.client.eval(this.INCR_WITH_WINDOW_LUA, 1, key, windowSeconds);
    return Number(current);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  // Rate limiting helper（原子版：incr + 首建 TTL 同一条命令完成，无崩溃窗口）
  async checkRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const current = await this.incrWithWindow(key, windowSeconds);
    return current <= maxRequests;
  }
}
