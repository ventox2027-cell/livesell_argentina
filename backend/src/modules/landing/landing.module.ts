import { Module } from '@nestjs/common';

import { StorageModule } from '@/shared/storage/storage.module';

import { DescargasController } from './descargas.controller';
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
  imports: [StorageModule],
  controllers: [LandingController, DescargasController],
  providers: [LandingService],
})
export class LandingModule {}
