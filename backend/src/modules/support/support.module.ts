import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import { SupportAdminController, SupportController } from './support.controller';
import { AsistenteGuionado, SupportAgent } from './support-agent';
import { SupportService } from './support.service';

/**
 * Soporte: 24 horas con asistente, escalada a una persona cuando hace falta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUIÉN CONTESTA SE ELIGE ACÁ Y EN NINGÚN OTRO LADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SupportService` depende de la clase abstracta `SupportAgent`. Hoy la única
 * implementación son respuestas guionadas; conectar un modelo de lenguaje es
 * agregar una clase y cambiar esta línea.
 *
 * Lo que NO cambia con esa línea: qué escala, qué no se puede prometer, y que
 * la plata siempre va a una persona. Todo eso vive en `escalada.ts`, fuera del
 * agente, y se aplica antes y después de que conteste.
 *
 * Es lo que hace que conectar un modelo sea una decisión reversible: con las
 * reglas adentro del prompt, cambiar de proveedor significaría reescribir la
 * política de escalada — y probarla de nuevo.
 */
@Module({
  controllers: [SupportController, SupportAdminController],
  providers: [
    SupportService,
    AsistenteGuionado,
    {
      provide: SupportAgent,
      useExisting: AsistenteGuionado,
    },
    AuditService,
  ],
  exports: [SupportService],
})
export class SupportModule {}
