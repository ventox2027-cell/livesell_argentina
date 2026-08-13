import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { JwtService, type IssuedAccessToken } from './jwt.service';
import { generateRefreshToken, hashRefreshToken } from './tokens';

/**
 * Ciclo de vida de las sesiones.
 *
 * ─── La rotación y por qué existe ───
 *
 * Cada refresco entrega un token nuevo y quema el anterior. Si un token ya
 * quemado vuelve a aparecer, hay dos copias en circulación: el legítimo y una
 * robada. No hay forma de saber cuál es cuál —las dos son idénticas— así que
 * la única respuesta segura es **cortar las dos**: se revoca la familia
 * completa y las dos partes tienen que volver a iniciar sesión.
 *
 * Es molesto para la persona legítima. Es mucho menos molesto que un
 * desconocido comprando con su cuenta.
 *
 * ─── Por qué una familia y no una cadena ───
 *
 * Todas las rotaciones de una sesión comparten `familyId`. Revocar es entonces
 * un UPDATE por índice. Con la cadena de `replacedBy` habría que ir saltando
 * de fila en fila, una consulta por salto, justo en el momento en que hay que
 * reaccionar rápido.
 */

export class SessionRevokedError extends DomainError {
  constructor(reason: string) {
    super('SESSION_REVOKED', 'La sesión ya no es válida. Iniciá sesión de nuevo.', { reason });
  }
}

export interface SessionContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  deviceId?: string | undefined;
}

export interface IssuedSession extends IssuedAccessToken {
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Abre una sesión nueva: una familia nueva de refresh tokens. */
  async createSession(
    user: { id: string; role: string },
    ctx: SessionContext = {},
  ): Promise<IssuedSession> {
    const familyId = newId('ses');
    return this.issue(user, familyId, ctx, null);
  }

  /**
   * Canjea un refresh token por un par nuevo.
   *
   * Los tres caminos posibles, y por qué el tercero es el que importa:
   *
   *   1. El token no existe        → alguien inventó uno, o la sesión ya se
   *                                  limpió. Se rechaza.
   *   2. El token está vigente     → se rota y se entrega el par nuevo.
   *   3. **El token ya fue usado** → hay una copia robada dando vueltas. Se
   *                                  revoca la familia entera.
   */
  async refresh(rawToken: string, ctx: SessionContext = {}): Promise<IssuedSession> {
    const hash = hashRefreshToken(rawToken);

    const actual = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!actual) {
      await this.registrar(null, 'refresh', false, 'token desconocido', ctx);
      throw new SessionRevokedError('token desconocido');
    }

    // ── Caso 3: reuso ──
    if (actual.replacedById !== null || actual.revokedAt !== null) {
      /**
       * Acá está el corazón de la defensa.
       *
       * Este token ya se canjeó. Que vuelva a aparecer significa que existe
       * una segunda copia. Como no se puede distinguir al dueño del ladrón, se
       * cortan las dos: la persona legítima vuelve a entrar con su proveedor y
       * el ladrón se queda con nada.
       */
      await this.revokeFamily(actual.familyId, 'reuse_detected');
      await this.registrar(actual.userId, 'refresh.reuse', false, 'token ya usado', ctx);
      this.logger.warn({
        msg: '🚨 reuso de refresh token: familia revocada',
        userId: actual.userId,
        familyId: actual.familyId,
        ip: ctx.ip,
      });
      throw new SessionRevokedError('reuso detectado');
    }

    if (actual.expiresAt.getTime() <= Date.now()) {
      await this.registrar(actual.userId, 'refresh', false, 'token expirado', ctx);
      throw new SessionRevokedError('token expirado');
    }

    if (actual.user.status !== 'active' || actual.user.deletedAt !== null) {
      // Una cuenta suspendida no puede seguir renovando sesiones. Es lo que
      // hace que suspender a alguien tenga efecto en menos de 15 minutos.
      await this.revokeFamily(actual.familyId, 'user_not_active');
      await this.registrar(actual.userId, 'refresh', false, 'cuenta no activa', ctx);
      throw new SessionRevokedError('cuenta no activa');
    }

    // ── Caso 2: rotación normal ──
    return this.issue(
      { id: actual.user.id, role: actual.user.role },
      actual.familyId,
      { ...ctx, deviceId: ctx.deviceId ?? actual.deviceId ?? undefined },
      actual.id,
    );
  }

  /** Cierra una sesión concreta. El resto de los dispositivos siguen adentro. */
  async logout(rawToken: string, ctx: SessionContext = {}): Promise<void> {
    const hash = hashRefreshToken(rawToken);
    const actual = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    // Sin token válido no hay nada que cerrar, y tampoco hay nada que avisar:
    // decir "ese token no existe" es información gratis para quien prueba.
    if (!actual) return;

    await this.revokeFamily(actual.familyId, 'logout');
    await this.registrar(actual.userId, 'logout', true, null, ctx);
  }

  /** Cierra TODAS las sesiones. Es lo que se ofrece ante un acceso sospechoso. */
  async logoutAll(userId: string, ctx: SessionContext = {}): Promise<{ revoked: number }> {
    const r = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout_all' },
    });
    await this.registrar(userId, 'logout.all', true, null, ctx);
    return { revoked: r.count };
  }

  /** Sesiones abiertas, para mostrárselas a la persona. */
  async listSessions(userId: string) {
    const filas = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, replacedById: null, expiresAt: { gt: new Date() } },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });

    return filas.map((f) => ({
      sessionId: f.familyId,
      createdAt: f.createdAt,
      expiresAt: f.expiresAt,
      ip: f.ip,
      device: f.device
        ? { platform: f.device.platform, model: f.device.model, appVersion: f.device.appVersion }
        : null,
    }));
  }

  /**
   * Borra los tokens vencidos hace más de 30 días.
   *
   * No es sólo higiene: la tabla crece con cada refresco de cada dispositivo
   * —unas 96 filas por usuario por día— y sin limpieza el índice se degrada.
   * Se conservan 30 días después del vencimiento para poder investigar un
   * incidente hacia atrás.
   */
  async purgeExpired(olderThanDays = 30): Promise<{ deleted: number }> {
    const corte = new Date(Date.now() - olderThanDays * 86_400_000);
    const r = await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: corte } } });
    return { deleted: r.count };
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async issue(
    user: { id: string; role: string },
    familyId: string,
    ctx: SessionContext,
    replacesId: string | null,
  ): Promise<IssuedSession> {
    const { token, hash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_S * 1000);
    const nuevoId = newId('rtk');

    /**
     * Crear el nuevo y quemar el viejo van en la MISMA transacción.
     *
     * Si se hicieran por separado y el proceso muriera en el medio, quedaría
     * o un token nuevo con el viejo todavía vivo —dos válidos a la vez, que es
     * justo lo que la rotación evita— o el viejo quemado sin reemplazo, que
     * deja a la persona afuera sin motivo.
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.create({
        data: {
          id: nuevoId,
          userId: user.id,
          tokenHash: hash,
          familyId,
          deviceId: ctx.deviceId ?? null,
          expiresAt,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      if (replacesId) {
        await tx.refreshToken.update({
          where: { id: replacesId },
          data: { replacedById: nuevoId },
        });
      }

      await tx.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    });

    const acceso = await this.jwt.issueAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: familyId,
    });

    await this.registrar(user.id, replacesId ? 'refresh' : 'session.created', true, null, ctx);

    return {
      ...acceso,
      refreshToken: token,
      refreshExpiresAt: expiresAt.toISOString(),
      sessionId: familyId,
    };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Bitácora de autenticación. Nunca lanza: no puede tumbar un login. */
  private async registrar(
    userId: string | null,
    kind: string,
    success: boolean,
    reason: string | null,
    ctx: SessionContext,
  ): Promise<void> {
    try {
      await this.prisma.authEvent.create({
        data: {
          id: newId('aev'),
          userId,
          kind,
          success,
          reason,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        } satisfies Prisma.AuthEventUncheckedCreateInput,
      });
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo registrar el evento de autenticación',
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
