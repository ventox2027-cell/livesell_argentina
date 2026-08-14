import { Module } from '@nestjs/common';

import { SocialController } from './social.controller';
import { SocialService } from './social.service';

/**
 * "Me gusta" y compartir.
 *
 * Las dos cosas responden la misma pregunta desde ángulos distintos: **cómo se
 * propaga algo**. Un corazón dice "esto me gustó" y alimenta el ranking del
 * feed; un enlace compartido trae gente que todavía no tiene la app.
 *
 * Separarlas en dos módulos sería repetir las mismas dependencias para dos
 * funciones que la misma pantalla usa al lado una de la otra.
 */
@Module({
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
