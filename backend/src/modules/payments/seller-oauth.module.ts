import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import { MercadoPagoOAuthClient } from './mp-oauth.client';
import {
  SellerOAuthCallbackController,
  SellerOAuthController,
} from './seller-oauth.controller';
import { SellerOAuthService } from './seller-oauth.service';

/**
 * La conexión de los vendedores con Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEPARADO DE `PaymentsModule`. NO ES UN DETALLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PaymentsModule` es el del spike: se registra sólo si
 * `PAYMENTS_SPIKE_ENABLED=true`, y `env.schema.ts` impide que eso ocurra en
 * producción. Todo lo que viva ahí adentro deja de existir en producción.
 *
 * Esto es lo contrario: es infraestructura productiva. Sin ella, ningún
 * vendedor puede cobrar en su propia cuenta y el marketplace no funciona.
 *
 * Meterlo en el módulo del spike lo habría dejado apagado exactamente donde
 * hace falta, y el fallo se habría visto recién en el primer despliegue, con
 * un vendedor real intentando conectar su cuenta.
 *
 * ─── Funciona sin credenciales ───
 *
 * Si `MP_CLIENT_ID` y compañía no están cargadas, el módulo se registra igual y
 * los endpoints responden `MP_OAUTH_NOT_CONFIGURED`. Es a propósito: la app
 * necesita poder preguntar "¿está disponible esto?" y recibir una respuesta
 * clara, en vez de un 404 que no distingue "no configurado" de "ruta mal
 * escrita".
 */
@Module({
  controllers: [SellerOAuthController, SellerOAuthCallbackController],
  providers: [SellerOAuthService, MercadoPagoOAuthClient, AuditService],
  exports: [SellerOAuthService],
})
export class SellerOAuthModule {}
