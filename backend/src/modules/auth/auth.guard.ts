import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { JwtService } from './jwt.service';
import { extractBearer } from './tokens';

/**
 * El guard es GLOBAL y todo está cerrado por defecto.
 *
 * Es la decisión de diseño más importante del módulo. La alternativa —proteger
 * endpoint por endpoint— falla siempre de la misma forma: alguien agrega una
 * ruta nueva, se olvida del decorador, y queda abierta. El olvido no se ve en
 * la revisión de código porque lo que falta es una línea que no está.
 *
 * Con el guard global el olvido tiene el signo contrario: si alguien no pone
 * nada, su endpoint pide autenticación y lo nota en el primer intento. Abrir
 * una ruta requiere escribir `@Public()`, que sí se ve al revisar.
 */

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_ROLES = 'auth:roles';

/** Marca un endpoint como accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restringe un endpoint a ciertos roles. */
export const Roles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES, roles);

export interface AuthenticatedUser {
  id: string;
  role: string;
  sessionId: string;
  email: string;
  status: string;
}

/** Inyecta el usuario autenticado en un parámetro del controlador. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
  return req.user;
});

export class UnauthenticatedError extends DomainError {
  constructor(reason: string) {
    super('INVALID_TOKEN', 'Necesitás iniciar sesión', { reason });
  }
}

export class ForbiddenRoleError extends DomainError {
  constructor(required: string[], actual: string) {
    super('FORBIDDEN', 'No tenés permiso para esta acción', { required, actual });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Sólo aplica a HTTP. Los sockets tienen su propio camino de autenticación.
    if (ctx.getType() !== 'http') return true;

    const esPublico = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const token = extractBearer(req.headers.authorization);

    if (esPublico) {
      /**
       * Un endpoint público con token igual identifica a la persona.
       *
       * El feed es el caso: cualquiera lo ve, pero si hay sesión se puede
       * personalizar. Un token inválido acá NO rompe la petición — sería
       * absurdo que el feed público fallara por un token vencido.
       */
      if (token) await this.intentarIdentificar(req, token);
      return true;
    }

    if (!token) throw new UnauthenticatedError('sin token');

    const payload = await this.jwt.verifyAccessToken(token);

    /**
     * Se consulta el usuario en la base en cada petición autenticada.
     *
     * Es una consulta por índice primario y vale lo que cuesta: sin ella, una
     * cuenta suspendida seguiría operando hasta que su access token expirara.
     * Bloquear a un estafador y que siga vendiendo 15 minutos no es aceptable.
     *
     * Cuando el volumen lo pida, esto se cachea en Redis con un TTL corto y una
     * invalidación al suspender. No antes: sería optimizar sin medir.
     */
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, email: true, status: true, deletedAt: true },
    });

    if (!user || user.deletedAt !== null) throw new UnauthenticatedError('usuario inexistente');
    if (user.status !== 'active') {
      throw new DomainError('ACCOUNT_SUSPENDED', 'Tu cuenta está suspendida', {
        status: user.status,
      });
    }

    /**
     * El rol se toma de la BASE, no del token.
     *
     * Si se leyera del token, alguien degradado de admin a buyer seguiría
     * siendo admin hasta que su token expirara. El token dice quién sos; la
     * base dice qué podés hacer ahora.
     */
    req.user = {
      id: user.id,
      role: user.role,
      sessionId: payload.sid,
      email: user.email,
      status: user.status,
    };

    const rolesRequeridos = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (rolesRequeridos?.length && !rolesRequeridos.includes(user.role)) {
      throw new ForbiddenRoleError(rolesRequeridos, user.role);
    }

    return true;
  }

  /** Identificación opcional para endpoints públicos. Nunca lanza. */
  private async intentarIdentificar(
    req: FastifyRequest & { user?: AuthenticatedUser },
    token: string,
  ): Promise<void> {
    try {
      const payload = await this.jwt.verifyAccessToken(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, email: true, status: true, deletedAt: true },
      });
      if (user && user.deletedAt === null && user.status === 'active') {
        req.user = {
          id: user.id,
          role: user.role,
          sessionId: payload.sid,
          email: user.email,
          status: user.status,
        };
      }
    } catch {
      // Silencio deliberado: es un endpoint público.
    }
  }
}
