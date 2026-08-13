import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { env } from '@/config/env.schema';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      datasources: { db: { url: env.DATABASE_URL } },
      log:
        env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
          : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL conectado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Sonda de readiness. Barata a propósito: se ejecuta cada 10 s. */
  async ping(): Promise<number> {
    const start = performance.now();
    await this.$queryRaw`SELECT 1`;
    return Math.round(performance.now() - start);
  }
}
