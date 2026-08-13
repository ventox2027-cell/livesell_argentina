import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { env } from '@/config/env.schema';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Reconexión con backoff acotado. Sin tope, una caída larga de Redis
      // deja las reconexiones a intervalos absurdos y la app no se recupera sola.
      retryStrategy: (times) => Math.min(times * 200, 3_000),
      lazyConnect: true,
    });

    this.client.on('error', (err) => this.logger.error({ err }, 'Redis error'));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconectando'));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis conectado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - start);
  }
}
