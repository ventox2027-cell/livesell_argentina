import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { CurrentUser, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { ipDelCliente } from '@/shared/http/client-ip';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { VerificationService } from './verification.service';

/**
 * Onboarding de verificación del vendedor.
 *
 * ⚠️ El número de documento y el CUIT llegan por acá y **no se guardan**: se
 * usan para consultar al proveedor y se descartan. Lo que queda es un HMAC y
 * los últimos cuatro dígitos. Ver `verification.service.ts`.
 */

const EnviarVerificacionSchema = z.object({
  legalFirstName: z.string().trim().min(2).max(80),
  legalLastName: z.string().trim().min(2).max(80),
  docType: z.enum(['DNI', 'LC', 'LE', 'PASAPORTE']).default('DNI'),
  /**
   * Se acepta con puntos y espacios: la gente escribe su DNI como se lo sabe.
   * El servicio normaliza a dígitos antes de usarlo.
   */
  docNumber: z.string().trim().min(7).max(20),
  taxId: z.string().trim().min(11).max(15).optional(),
  province: z.string().trim().min(2).max(60),
  city: z.string().trim().min(2).max(80),
});
type EnviarVerificacionDto = z.infer<typeof EnviarVerificacionSchema>;

@Controller({ path: 'sellers/verification', version: '1' })
export class VerificationController {
  constructor(private readonly verificacion: VerificationService) {}

  @Get()
  miEstado(@CurrentUser() user: AuthenticatedUser) {
    return this.verificacion.miEstado(user.id);
  }

  /**
   * Límite bajo a propósito.
   *
   * Cada envío es una revisión manual para alguien del equipo. Cinco por hora
   * alcanzan de sobra para corregir un dato mal tipeado dos o tres veces, y
   * evitan que se pueda usar este endpoint para probar números de documento
   * contra la detección de duplicados.
   */
  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'seller:verification' })
  @Post()
  enviar(
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(EnviarVerificacionSchema)) dto: EnviarVerificacionDto,
  ) {
    return this.verificacion.enviar(user.id, dto, { ip: ipDelCliente(req) });
  }
}
