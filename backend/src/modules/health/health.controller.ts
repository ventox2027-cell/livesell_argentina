import { timingSafeEqual } from 'node:crypto';

import { Controller, Get, Header, Headers, HttpCode, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { env } from '@/config/env.schema';
import { LiveGateway } from '@/modules/live/live.gateway';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { RedisService } from '@/shared/redis/redis.service';
import { MetricsService } from '@/shared/observability/metrics.service';

type CheckState = 'ok' | 'degraded' | 'error';

interface Check {
  status: CheckState;
  latencyMs?: number;
  error?: string;
  /** Por qué está degradado, en castellano. Para el humano que lo lea. */
  detalle?: string;
}

const startedAt = Date.now();

/**
 * Compara dos tokens sin filtrar por dónde difieren.
 *
 * `a === b` sobre strings corta en el primer byte distinto. Esa diferencia de
 * tiempo se mide desde afuera, y con suficientes intentos se adivina el token
 * carácter por carácter en vez de tener que probar todas las combinaciones.
 *
 * `timingSafeEqual` exige buffers del mismo largo, así que la comparación de
 * longitud va antes y sí es corta. No importa: la longitud del token no es el
 * secreto.
 */
function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
    private readonly gateway: LiveGateway,
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

    /**
     * El adaptador de Socket.IO, que es una degradación invisible.
     *
     * Sin él la app funciona: los endpoints responden, el vivo se ve, el chat
     * anda. Lo único que se rompe es que un mensaje emitido en la instancia A
     * no le llega a quien está conectado a la B — y eso, con una sola máquina,
     * no se nota nunca.
     *
     * El día que haya dos, el síntoma es "el chat anda a veces". Que salga por
     * acá permite que el monitoreo lo vea antes que un usuario.
     *
     * No cambia el estado general a `error`: con una instancia es correcto
     * funcionar así, y sacar la API de servicio por esto sería peor.
     */
    const realtime: Check = this.gateway.adaptadorDeRedisActivo
      ? { status: 'ok' }
      : {
          status: 'degraded',
          detalle: 'sin adaptador de Redis: el realtime sólo funciona con una instancia',
        };

    const status: CheckState =
      database.status === 'error'
        ? 'error'
        : redis.status === 'degraded' || realtime.status === 'degraded'
          ? 'degraded'
          : 'ok';

    reply.status(status === 'error' ? 503 : 200);
    return { status, version: env.GIT_SHA, checks: { database, redis, realtime } };
  }

  /**
   * Métricas en formato Prometheus.
   *
   * ─── Por qué está protegido ───
   *
   * `/metrics` no expone datos personales, pero sí el estado del negocio:
   * cuántas órdenes se crean por minuto, qué proporción de pagos se rechaza,
   * cuántas devoluciones hay, cuánto stock se agota. Publicarlo es publicar la
   * facturación aproximada de cada vendedor a cualquiera que sepa la URL.
   *
   * Además da reconocimiento gratis: los contadores por ruta dibujan el mapa
   * completo de la API, incluidos los endpoints que no están documentados.
   *
   * Sin `METRICS_TOKEN` configurado queda abierto, que es lo cómodo en local.
   * En staging y producción se configura y entonces exige la cabecera.
   *
   * ─── Comparación en tiempo constante ───
   *
   * `===` sobre strings corta en el primer byte distinto, y ese tiempo se mide.
   * Con suficientes intentos se adivina el token carácter por carácter. Cuesta
   * lo mismo hacerlo bien.
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async prometheus(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const esperado = env.METRICS_TOKEN;

    if (esperado) {
      const recibido = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokenValido(recibido, esperado)) {
        reply.status(401);
        // Sin cuerpo útil: un mensaje distinto según el motivo confirmaría al
        // que prueba si el endpoint existe y está protegido o no.
        return '';
      }
    }

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
