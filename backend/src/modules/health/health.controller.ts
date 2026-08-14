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
   * ═══════════════════════════════════════════════════════════════════════
   * SÓLO POSTGRESQL SACA LA INSTANCIA DE SERVICIO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Redis caído es `degraded`, no `error`. **No** devuelve 503.
   *
   * Suena raro hasta que se mira qué pasa de verdad cuando Redis se cae:
   *
   *   · Reservar stock: funciona. `expires_at` vive en PostgreSQL y el
   *     reconciliador vence las reservas sin tocar ninguna cola.
   *   · Crear una orden y cobrar: funcionan. No dependen de Redis en ningún
   *     paso.
   *   · Confirmar un pago: funciona. Los webhooks van directo a la base.
   *   · Lo que se pierde: la precisión al segundo de los vencimientos y el
   *     límite de peticiones —que además falla abierto a propósito—.
   *
   * O sea: con Redis caído se puede seguir vendiendo, y sacar la API de
   * servicio convertiría una degradación en una caída total. Eso sería
   * exactamente el error que el diseño tolerante a Redis existe para evitar.
   *
   * Con PostgreSQL caído es al revés: no se puede confirmar ninguna operación
   * sin mentir. Es preferible no vender durante veinte segundos a vender
   * unidades inexistentes.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [database, redisCheck] = await Promise.all([
      this.check(() => this.prisma.ping()),
      this.check(() => this.redis.ping()),
    ]);

    // Redis nunca es `error` de cara al balanceador: como mucho, degradado.
    const redis: Check =
      redisCheck.status === 'error' ? { ...redisCheck, status: 'degraded' } : redisCheck;

    const status: CheckState =
      database.status === 'error' ? 'error' : redis.status === 'degraded' ? 'degraded' : 'ok';

    reply.status(status === 'error' ? 503 : 200);
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
