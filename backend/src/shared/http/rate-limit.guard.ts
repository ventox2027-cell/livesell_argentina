import { CanActivate, ExecutionContext, Injectable, SetMetadata, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { DomainError } from '@/shared/errors/domain.error';
import { RedisService } from '@/shared/redis/redis.service';

/**
 * Límite de peticiones por ventana deslizante, en Redis.
 *
 * ─── Por qué en Redis y no en memoria ───
 *
 * Un contador en memoria del proceso deja de servir en cuanto hay dos
 * instancias: el atacante reparte los intentos entre ellas y multiplica su
 * cuota por la cantidad de máquinas. Y en Fly.io escalar es agregar máquinas,
 * así que el problema aparece justo cuando hay tráfico.
 *
 * ─── Ventana deslizante y no fija ───
 *
 * Con ventanas fijas de un minuto, alguien manda su cuota completa en el
 * segundo 59 y otra igual en el 61: el doble del límite en dos segundos. La
 * ventana deslizante mira siempre los últimos N segundos y no tiene ese borde.
 *
 * Se implementa con un sorted set: cada intento es un miembro con el timestamp
 * como puntaje, se descartan los viejos y se cuentan los que quedan. Todo en
 * una sola ida a Redis con `multi`.
 */

export const RATE_LIMIT = 'http:rateLimit';

export interface RateLimitOptions {
  /** Peticiones permitidas dentro de la ventana. */
  limit: number;
  /** Tamaño de la ventana, en segundos. */
  windowSec: number;
  /**
   * Sufijo para separar contadores. Dos endpoints con el mismo `bucket`
   * comparten cuota, que es lo correcto para variantes de una misma acción
   * (por ejemplo, login con Google y con Apple).
   */
  bucket?: string;
}

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT, options);

export class RateLimitedError extends DomainError {
  constructor(retryAfterSec: number) {
    super('RATE_LIMITED', 'Demasiados intentos. Probá de nuevo en un momento.', { retryAfterSec });
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    const opciones = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opciones) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { id: string } }>();
    const clave = this.clave(req, opciones);

    const ahora = Date.now();
    const desde = ahora - opciones.windowSec * 1000;

    try {
      const client = this.redis.client;
      const resultados = await client
        .multi()
        // Fuera los intentos que ya salieron de la ventana.
        .zremrangebyscore(clave, 0, desde)
        // Este intento. El sufijo aleatorio evita que dos peticiones del mismo
        // milisegundo se pisen y cuenten como una sola.
        .zadd(clave, ahora, `${ahora}-${Math.random().toString(36).slice(2, 10)}`)
        .zcard(clave)
        // Expiración de la clave: sin esto Redis acumularía contadores de
        // direcciones que no volvieron nunca más.
        .expire(clave, opciones.windowSec + 1)
        .exec();

      const cantidad = Number(resultados?.[2]?.[1] ?? 0);

      if (cantidad > opciones.limit) {
        this.logger.warn({ msg: 'límite de peticiones excedido', clave, cantidad });
        throw new RateLimitedError(opciones.windowSec);
      }
      return true;
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      /**
       * Si Redis no responde, se DEJA PASAR.
       *
       * Es una decisión consciente. El límite protege contra abuso; cerrar el
       * paso cuando el contador está caído convierte una caída de Redis en una
       * caída total del login. Prefiero quedar expuesto un rato a rechazar a
       * todo el mundo, y que quede ruidoso en los logs.
       */
      this.logger.error({
        msg: 'Redis no disponible: se omite el límite de peticiones',
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /**
   * Clave del contador.
   *
   * Con sesión se limita por usuario; sin sesión, por IP. Limitar siempre por
   * IP castigaría a todos los que comparten una salida a internet —una oficina,
   * una universidad, el CGNAT de una operadora móvil, que en Argentina es
   * moneda corriente— y en móvil eso es la mayoría de la gente.
   */
  private clave(req: FastifyRequest & { user?: { id: string } }, o: RateLimitOptions): string {
    const ambito = o.bucket ?? req.routeOptions?.url ?? req.url;
    const sujeto = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    return `rl:${ambito}:${sujeto}`;
  }
}
