import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { LiveKitModule } from '@/modules/livekit/livekit.module';
import { AuditService } from '@/shared/audit/audit.service';

import { LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';
import { LiveStockListener } from './live-stock.listener';
import { LiveService } from './live.service';

/**
 * Sesiones en vivo.
 *
 * `AuthModule` porque el gateway verifica el token en el handshake: un socket
 * sin sesión válida se cierra antes de unirse a ninguna sala.
 *
 * `LiveGateway` se exporta para que el módulo de inventario pueda avisar
 * cambios de stock a las salas donde ese producto está destacado.
 */
@Module({
  imports: [AuthModule, LiveKitModule],
  controllers: [LiveController],
  providers: [LiveService, LiveGateway, LiveStockListener, AuditService],
  exports: [LiveService],
})
export class LiveModule {}
