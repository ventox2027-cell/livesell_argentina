import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

/**
 * Bitácora de auditoría.
 *
 * Responde "quién cambió esto, cuándo y de qué a qué" — la pregunta que
 * aparece seis meses después, cuando un vendedor asegura que él no puso ese
 * precio y nadie tiene forma de saberlo.
 *
 * ─── Nunca lanza ───
 *
 * Un fallo al auditar no puede tumbar la operación auditada. Si la bitácora
 * está caída, se pierde el registro y queda un error en los logs; lo que no se
 * pierde es el trabajo de quien estaba cargando un producto.
 *
 * ─── Qué NO se guarda ───
 *
 * Nada sensible. Esta tabla se lee entera cuando se investiga un incidente, y
 * a veces la lee alguien que no debería ver datos personales. Se registran los
 * campos que cambiaron y nada más.
 */

/** Campos que jamás entran a la bitácora, aunque vengan en el objeto. */
const PROHIBIDOS = new Set([
  'password', 'token', 'accessToken', 'refreshToken', 'tokenHash', 'secret',
  'apiKey', 'cardNumber', 'cvv', 'securityCode', 'docNumber', 'docNumberEnc',
  'phoneE164', 'email',
]);

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'admin';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /**
   * Por qué se hizo. Obligatorio en las acciones administrativas — el
   * controlador lo exige antes de llegar acá.
   */
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          id: newId('aud'),
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          actorId: input.actorId ?? null,
          actorType: input.actorType ?? 'user',
          before: this.limpiar(input.before),
          after: this.limpiar(input.after),
          reason: input.reason ?? null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo registrar en la bitácora',
        action: input.action,
        entityId: input.entityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Registra sólo lo que cambió.
   *
   * Guardar el objeto entero en cada modificación hace que leer la bitácora sea
   * comparar dos JSON a ojo. Con el diff, "cambió el precio de 12.000 a 9.900"
   * se lee de un vistazo.
   */
  async logDiff(
    input: Omit<AuditInput, 'before' | 'after'> & {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    const antes: Record<string, unknown> = {};
    const despues: Record<string, unknown> = {};

    for (const clave of new Set([...Object.keys(input.before), ...Object.keys(input.after)])) {
      const a = input.before[clave];
      const b = input.after[clave];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        antes[clave] = a;
        despues[clave] = b;
      }
    }

    // Sin cambios reales no se escribe nada: una bitácora llena de filas
    // vacías es una bitácora que nadie lee.
    if (Object.keys(despues).length === 0) return;

    await this.log({ ...input, before: antes, after: despues });
  }

  private limpiar(
    obj: Record<string, unknown> | null | undefined,
  ): Prisma.InputJsonValue | undefined {
    if (!obj) return undefined;
    const salida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (PROHIBIDOS.has(k)) continue;
      salida[k] = v;
    }
    return salida as Prisma.InputJsonValue;
  }
}
