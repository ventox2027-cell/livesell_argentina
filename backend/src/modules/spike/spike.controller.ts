import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { Public } from '@/modules/auth/auth.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import {
  CreateSessionSchema,
  EndSessionSchema,
  GlassToGlassSchema,
  IngestEventsSchema,
  IngestSamplesSchema,
  IssueTokenSchema,
  TimeSyncQuerySchema,
  type CreateSessionDto,
  type EndSessionDto,
  type GlassToGlassDto,
  type IngestEventsDto,
  type IngestSamplesDto,
  type IssueTokenDto,
  type TimeSyncQueryDto,
} from './dto/spike.dto';
import { SpikeKeyGuard } from './spike-key.guard';
import { SpikeService } from './spike.service';

// Se protege con SpikeKeyGuard (clave compartida), no con sesión de usuario.
@Public()
@Controller({ path: 'spike', version: '1' })
@UseGuards(SpikeKeyGuard)
export class SpikeController {
  constructor(private readonly spike: SpikeService) {}

  /**
   * Sincronización de reloj (algoritmo de Cristian).
   *
   * Es el endpoint más importante de todo el spike y el más fácil de subestimar.
   * Sin él, comparar un timestamp del teléfono A con uno del teléfono B no
   * significa nada: dos Android pueden tener 3 segundos de diferencia entre sí.
   * Toda la medición de latencia se apoya en esto.
   *
   * El cliente llama 7 veces, se queda con la muestra de menor RTT y calcula:
   *     offset = serverTime + rtt/2 − clientReceiveTime
   *
   * Va protegido por la misma guard que el resto: el cliente ya tiene la clave
   * antes de sincronizar, y dejar un endpoint abierto "porque es inofensivo" es
   * cómo empiezan las superficies de ataque.
   */
  @Get('time')
  time(@Query(new ZodValidationPipe(TimeSyncQuerySchema)) q: TimeSyncQueryDto) {
    return {
      serverTimeMs: Date.now(),
      clientSentAtMs: q.clientSentAtMs ?? null,
    };
  }

  @Post('sessions')
  createSession(@Body(new ZodValidationPipe(CreateSessionSchema)) dto: CreateSessionDto) {
    return this.spike.createSession(dto);
  }

  @Post('sessions/:id/end')
  endSession(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(EndSessionSchema)) dto: EndSessionDto,
  ) {
    return this.spike.endSession(id, dto.notes);
  }

  @Get('sessions/:id/report')
  report(@Param('id') id: string) {
    return this.spike.buildReport(id);
  }

  @Post('token')
  issueToken(@Body(new ZodValidationPipe(IssueTokenSchema)) dto: IssueTokenDto) {
    return this.spike.issueToken(dto);
  }

  @Post('samples')
  ingestSamples(@Body(new ZodValidationPipe(IngestSamplesSchema)) dto: IngestSamplesDto) {
    return this.spike.ingestSamples(dto);
  }

  @Post('events')
  ingestEvents(@Body(new ZodValidationPipe(IngestEventsSchema)) dto: IngestEventsDto) {
    return this.spike.ingestEvents(dto);
  }

  /** Carga de la medición manual leída de la foto. Ver RUNBOOK §5. */
  @Post('glass-to-glass')
  glassToGlass(@Body(new ZodValidationPipe(GlassToGlassSchema)) dto: GlassToGlassDto) {
    return this.spike.recordGlassToGlass(dto);
  }
}
