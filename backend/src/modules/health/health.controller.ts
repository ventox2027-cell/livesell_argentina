import { Controller, Get, Header, HttpCode, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { env } from '@/config/env.schema';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { RedisService } from '@/shared/redis/redis.service';
import { MetricsService } from '@/shared/observability/metrics.service';

type CheckState = 'ok' | 'degraded' | 'error';

interface Check {
  status: CheckState;
  latencyMs?: number;
  error?: string;
}

const startedAt = Date.now();

// VERSION_NEUTRAL: /health y no /v1/health. La URL que consulta el
// balanceador de Fly.io no puede cambiar nunca.
// Sin autenticación: lo consulta el balanceador de Fly.io, que no tiene sesión.
@Public()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Liveness. NO consulta dependencias a propósito.
   *
   * Si dependiera de Postgres, una caída de base reiniciaría todas las
   * instancias en bucle y convertiría un incidente de datos en una caída total.
   */
  @Get('health')
  @HttpCode(200)
  health() {
    return {
      status: 'ok',
      service: 'api',
      env: env.NODE_ENV,
      version: env.GIT_SHA,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    };
  }

  /**
   * Readiness. El balanceador saca la instancia de rotación si devuelve 503.
   *
   * Solo Postgres y Redis pueden provocar el 503: son las dependencias sin las
   * cuales no podemos servir nada. LiveKit `degraded` no saca la instancia —
   * el resto de la API sigue siendo útil aunque no se puedan emitir tokens.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [database, redis] = await Promise.all([this.check(() => this.prisma.ping()), this.check(() => this.redis.ping())]);

    const critical: Check[] = [database, redis];
    const status: CheckState = critical.some((c) => c.status === 'error') ? 'error' : 'ok';

    reply.status(status === 'ok' ? 200 : 503);
    return { status, version: env.GIT_SHA, checks: { database, redis } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async prometheus(): Promise<string> {
    return this.metrics.scrape();
  }

  private async check(fn: () => Promise<number>): Promise<Check> {
    try {
      const latencyMs = await fn();
      // Una dependencia que responde pero lenta es una señal temprana:
      // se reporta como degraded sin sacar la instancia de rotación.
      return { status: latencyMs > 500 ? 'degraded' : 'ok', latencyMs };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
