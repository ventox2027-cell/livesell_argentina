import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimitGuard } from '@/shared/http/rate-limit.guard';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { IdentityService } from './identity.service';
import { JwtService } from './jwt.service';
import { SessionsService } from './sessions.service';

/**
 * Módulo de autenticación.
 *
 * `@Global` porque `JwtService` lo necesita cualquier módulo que quiera
 * autenticar por fuera de HTTP —el gateway de Socket.IO, sin ir más lejos— y
 * repetir el import en cada uno sólo agrega ruido.
 *
 * ─── El orden de los guards importa ───
 *
 * `RateLimitGuard` va PRIMERO. Si fuera al revés, cada intento de fuerza bruta
 * costaría una verificación de firma y una consulta a la base antes de ser
 * rechazado, y el límite dejaría de proteger justamente contra lo que existe
 * para proteger: el consumo de recursos.
 *
 * En NestJS, los guards declarados con `APP_GUARD` se ejecutan en el orden en
 * que están registrados acá.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    IdentityService,
    JwtService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [JwtService, SessionsService, AuthService],
})
export class AuthModule {}
