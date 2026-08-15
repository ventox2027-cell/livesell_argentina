import { Module } from '@nestjs/common';

import { LiveModule } from '@/modules/live/live.module';

import { HealthController } from './health.controller';

/**
 * `LiveModule` se importa para poder preguntarle al gateway si el adaptador de
 * Redis quedó activo. Es la única degradación del sistema que no se ve desde
 * afuera, y sin esto sólo la sabría quien mirara la consola en el arranque.
 */
@Module({ imports: [LiveModule], controllers: [HealthController] })
export class HealthModule {}
