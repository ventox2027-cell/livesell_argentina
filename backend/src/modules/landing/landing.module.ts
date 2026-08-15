import { Module } from '@nestjs/common';

import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

/**
 * Las paginas que ve alguien que abre un enlace compartido.
 *
 * Un modulo aparte y no un endpoint mas dentro de `commerce` porque su salida
 * es distinta de todo el resto del backend: HTML para un navegador, no JSON
 * para la app. Mezclarlo haria que un controlador tuviera dos contratos.
 */
@Module({
  controllers: [LandingController],
  providers: [LandingService],
})
export class LandingModule {}
