import { Module } from '@nestjs/common';

import { LiveKitModule } from '@/modules/livekit/livekit.module';

import { SpikeController } from './spike.controller';
import { SpikeKeyGuard } from './spike-key.guard';
import { SpikeService } from './spike.service';

/**
 * Módulo temporal del Sprint 0.
 *
 * Se registra solo si SPIKE_ENABLED=true (ver app.module.ts) y env.schema.ts
 * impide que eso ocurra en producción. Cuando los dos spikes tengan veredicto,
 * este módulo se borra entero: las tablas quedan como registro histórico de la
 * medición, el código no.
 */
@Module({
  imports: [LiveKitModule],
  controllers: [SpikeController],
  providers: [SpikeService, SpikeKeyGuard],
})
export class SpikeModule {}
