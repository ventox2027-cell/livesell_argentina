import { Module } from '@nestjs/common';

import { ModerationModule } from '@/modules/moderation/moderation.module';
import { SellerOAuthModule } from '@/modules/payments/seller-oauth.module';

import { AuthModule } from '@/modules/auth/auth.module';
import { LiveKitModule } from '@/modules/livekit/livekit.module';
import { AuditService } from '@/shared/audit/audit.service';

import { ChatModeracionService } from './chat-moderacion.service';
import { ChatRetencionService } from './chat-retencion.service';
import { ChatModeracionController, LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';
import { LiveStockListener } from './live-stock.listener';
import { AgendaBarridoService } from './agenda-barrido.service';
import { AgendaService } from './agenda.service';
import { LiveService } from './live.service';

/**
 * Sesiones en vivo.
 *
 * `AuthModule` porque el gateway verifica el token en el handshake: un socket
 * sin sesión válida se cierra antes de unirse a ninguna sala.
 *
 * `LiveGateway` se exporta para que `/ready` pueda preguntarle si el adaptador
 * de Redis quedó activo. Es la única degradación del sistema que no se ve desde
 * afuera: sin adaptador la app funciona igual, y lo único que se rompe es que
 * un evento emitido en una instancia no llega a quien está en otra.
 *
 * ⚠️ Este comentario decía que se exportaba "para que el módulo de inventario
 * avise cambios de stock", y no era cierto: `exports` sólo tenía `LiveService`.
 * Quien avisa el stock es `LiveStockListener`, que vive acá adentro y por eso
 * nunca necesitó la exportación.
 */
@Module({
  // `ModerationModule` por el bloqueo entre personas: el chat lo consulta en
  // cada mensaje para no dejar escribir a quien tiene bloqueo con el vendedor.
  imports: [AuthModule, LiveKitModule, SellerOAuthModule, ModerationModule],
  controllers: [LiveController, ChatModeracionController],
  providers: [
    LiveService,
    AgendaService,
    AgendaBarridoService,
    LiveGateway,
    LiveStockListener,
    ChatModeracionService,
    ChatRetencionService,
    AuditService,
  ],
  exports: [LiveService, AgendaService, LiveGateway, ChatModeracionService],
})
export class LiveModule {}
