import { Body, Controller, Delete, Get, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { env } from '@/config/env.schema';

import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { CurrentUser, Public, type AuthenticatedUser } from './auth.guard';
import { AuthService } from './auth.service';
import {
  AppleLoginSchema,
  CompleteProfileSchema,
  DevLoginSchema,
  GoogleLoginSchema,
  RefreshSchema,
  UpdatePushTokenSchema,
  type AppleLoginDto,
  type CompleteProfileDto,
  type DevLoginDto,
  type GoogleLoginDto,
  type RefreshDto,
  type UpdatePushTokenDto,
} from './dto/auth.dto';
import { SessionsService } from './sessions.service';

/**
 * API de autenticación.
 *
 * Los endpoints de login llevan `@Public()` por necesidad —quien los llama
 * todavía no tiene sesión— y **límite de peticiones sin excepción**. Un login
 * público sin límite es una invitación a probar tokens en serie.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Contexto de la petición para la bitácora.
   *
   * `req.ip` respeta `X-Forwarded-For` sólo si Fastify tiene `trustProxy`. Si
   * no lo tuviera, acá se registraría la IP del proxy de Fly.io en lugar de la
   * de la persona, y el límite por IP agruparía a todo el mundo en un contador.
   */
  private ctx(req: FastifyRequest) {
    return {
      ip: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    };
  }

  /**
   * Configuración que la app necesita para iniciar sesión.
   *
   * Se sirve desde el backend en vez de compilarla dentro del APK por un
   * motivo práctico: cambiar un client ID no puede obligar a publicar una
   * versión nueva en las tiendas y esperar a que la gente actualice.
   *
   * Todo lo que devuelve es público por diseño. El client ID de Google viaja
   * dentro de cada token de identidad; no es un secreto y no sirve para
   * autenticarse con él.
   */
  @Public()
  @Get('config')
  config() {
    return {
      googleServerClientId: env.GOOGLE_CLIENT_ID_WEB ?? null,
      appleBundleId: env.APPLE_BUNDLE_ID ?? null,
      // Permite que la app esconda el acceso de prueba cuando no está
      // disponible, en vez de ofrecer un botón que va a fallar.
      devLoginEnabled: env.AUTH_DEV_LOGIN_ENABLED,
    };
  }

  // ─── Inicio de sesión ──────────────────────────────────────────────────────

  @Public()
  // Comparten cuota con Apple: son variantes de la misma acción, y separarlas
  // le daría a un atacante el doble de intentos por alternar.
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'auth:login' })
  @Post('google')
  google(
    @Body(new ZodValidationPipe(GoogleLoginSchema)) dto: GoogleLoginDto,
    @Req() req: FastifyRequest,
  ) {
    return this.auth.loginWithGoogle(dto.idToken, dto.device, this.ctx(req));
  }

  @Public()
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'auth:login' })
  @Post('apple')
  apple(
    @Body(new ZodValidationPipe(AppleLoginSchema)) dto: AppleLoginDto,
    @Req() req: FastifyRequest,
  ) {
    return this.auth.loginWithApple(
      dto.idToken,
      { firstName: dto.firstName, lastName: dto.lastName },
      dto.device,
      this.ctx(req),
    );
  }

  /** Sólo con `AUTH_DEV_LOGIN_ENABLED=true`. Prohibido en producción. */
  @Public()
  @RateLimit({ limit: 30, windowSec: 60, bucket: 'auth:dev' })
  @Post('dev')
  dev(
    @Body(new ZodValidationPipe(DevLoginSchema)) dto: DevLoginDto,
    @Req() req: FastifyRequest,
  ) {
    return this.auth.devLogin(dto, dto.device, this.ctx(req));
  }

  // ─── Sesión ────────────────────────────────────────────────────────────────

  /**
   * Renueva el par de tokens.
   *
   * El límite es más alto que el de login porque un dispositivo legítimo
   * refresca cada 15 minutos, y varios dispositivos detrás de la misma IP
   * suman. Aun así hay tope: un bucle de refresco descontrolado en la app —que
   * pasa— no puede tumbar el servicio.
   */
  @Public()
  @RateLimit({ limit: 30, windowSec: 60, bucket: 'auth:refresh' })
  @Post('refresh')
  refresh(
    @Body(new ZodValidationPipe(RefreshSchema)) dto: RefreshDto,
    @Req() req: FastifyRequest,
  ) {
    return this.sessions.refresh(dto.refreshToken, this.ctx(req));
  }

  @Public()
  @Post('logout')
  async logout(
    @Body(new ZodValidationPipe(RefreshSchema)) dto: RefreshDto,
    @Req() req: FastifyRequest,
  ) {
    await this.sessions.logout(dto.refreshToken, this.ctx(req));
    // Siempre 200, exista o no el token: responder distinto revelaría si un
    // token es válido a quien está probando.
    return { ok: true };
  }

  /** Cierra todas las sesiones. Es lo que se ofrece ante un acceso sospechoso. */
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    return this.sessions.logoutAll(user.id, this.ctx(req));
  }

  @Get('sessions')
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listSessions(user.id);
  }

  // ─── Perfil ────────────────────────────────────────────────────────────────

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  completeProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CompleteProfileSchema)) dto: CompleteProfileDto,
  ) {
    return this.auth.completeProfile(user.id, dto);
  }

  @Patch('push-token')
  updatePushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdatePushTokenSchema)) dto: UpdatePushTokenDto,
  ) {
    return this.auth.updatePushToken(user.id, dto);
  }

  /**
   * Cierre de cuenta.
   *
   * Borrado LÓGICO. Una cuenta con órdenes no se puede borrar de verdad sin
   * romper el historial de compras del vendedor y la contabilidad. Se marca,
   * se cortan todas las sesiones, y el borrado real —si corresponde— se hace
   * después con un proceso que sabe qué se puede eliminar y qué no.
   */
  @Delete('me')
  async deleteAccount(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    await this.sessions.logoutAll(user.id, this.ctx(req));
    return this.auth.closeAccount(user.id);
  }
}
