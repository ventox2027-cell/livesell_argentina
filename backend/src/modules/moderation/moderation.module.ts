import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import { BloqueosService } from './bloqueos.service';
import {
  BloqueosController,
  ModerationAdminController,
  ModerationController,
} from './moderation.controller';
import { ModerationService } from './moderation.service';

/**
 * Reportes y moderación.
 *
 * ─── Por qué existe antes de abrir al público ───
 *
 * El día que entre alguien vendiendo algo que no se puede vender, la única
 * pregunta que importa es cuánto tarda en desaparecer. Sin un botón de
 * reportar, la respuesta es "hasta que alguien nos escriba por Instagram".
 */
@Module({
  controllers: [ModerationController, ModerationAdminController, BloqueosController],
  providers: [ModerationService, BloqueosService, AuditService],
  exports: [ModerationService, BloqueosService],
})
export class ModerationModule {}
