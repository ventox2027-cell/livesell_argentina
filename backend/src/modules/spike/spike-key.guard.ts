import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

/**
 * Protección del módulo de spike con una clave compartida.
 *
 * Por qué no JWT: el módulo Auth todavía no existe y construirlo antes de los
 * spikes contradice el orden de trabajo. Una clave compartida es suficiente
 * para un módulo que solo vive en dev/staging, crea salas de prueba y guarda
 * telemetría.
 *
 * Salvaguardas: `SPIKE_ENABLED` no puede ser true en producción (validado en
 * env.schema.ts) y sin clave el módulo ni se registra.
 */
@Injectable()
export class SpikeKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers['x-spike-key'];
    const expected = env.SPIKE_API_KEY;

    if (!expected) throw new DomainError('SPIKE_DISABLED', 'No disponible');
    if (typeof provided !== 'string') {
      throw new DomainError('UNAUTHORIZED', 'Falta el header x-spike-key');
    }

    // Comparación en tiempo constante: una comparación con === filtra la clave
    // byte a byte mediante un ataque de temporización. Cuesta lo mismo hacerlo bien.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && timingSafeEqual(a, b);

    if (!ok) throw new DomainError('UNAUTHORIZED', 'Clave de spike inválida');
    return true;
  }
}
