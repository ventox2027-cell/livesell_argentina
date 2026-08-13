import { CanActivate, ExecutionContext, Injectable, SetMetadata, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

// Este guard se registra en `AuthModule`, que también provee `JwtService`, así
// que la dependencia se resuelve dentro del mismo módulo. No hay ciclo:
// `jwt.service.ts` no conoce nada de `shared/http`.
import { JwtService } from '@/modules/auth/jwt.service';
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
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    const opciones = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opciones) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { id: string } }>();
    const clave = await this.clave(req, opciones);

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
   *
   * ─── Por qué el usuario se resuelve acá y no se lee de `req.user` ───
   *
   * Este guard corre ANTES que `AuthGuard`, a propósito: así un intento de
   * fuerza bruta se rechaza sin gastar una verificación de firma ni una
   * consulta a la base. El efecto colateral es que `req.user` todavía no
   * existe, y leerlo de ahí hacía que TODOS los endpoints autenticados cayeran
   * al límite por IP sin que se notara.
   *
   * Eso convertía la protección en un problema: `POST /sellers` permite 3 por
   * hora, y detrás del CGNAT de una operadora eso es 3 tiendas nuevas por hora
   * para un bloque entero de abonados. La cuarta persona del día veía
   * "Demasiados intentos" sin haber intentado nada.
   *
   * Así que el token se verifica acá, pero sólo la firma: es un HMAC, cuesta
   * microsegundos. Lo caro de `AuthGuard` —leer el rol de la base en cada
   * petición— no se repite. Un token inválido o ausente cae a IP, que es
   * justamente lo que se quiere para quien está probando credenciales.
   */
  private async clave(
    req: FastifyRequest & { user?: { id: string } },
    o: RateLimitOptions,
  ): Promise<string> {
    const ambito = o.bucket ?? req.routeOptions?.url ?? req.url;
    const userId = req.user?.id ?? (await this.usuarioDelToken(req));
    const sujeto = userId ? `u:${userId}` : `ip:${req.ip}`;
    return `rl:${ambito}:${sujeto}`;
  }

  /** `sub` del access token, o `null` si no hay uno válido. Nunca lanza. */
  private async usuarioDelToken(req: FastifyRequest): Promise<string | null> {
    const cabecera = req.headers.authorization;
    if (!cabecera?.startsWith('Bearer ')) return null;

    try {
      const payload = await this.jwt.verifyAccessToken(cabecera.slice(7));
      return payload.sub;
    } catch {
      // Token vencido, falsificado o basura. Se limita por IP: si alguien está
      // probando tokens, no puede elegir su propia clave de contador.
      return null;
    }
  }
}
