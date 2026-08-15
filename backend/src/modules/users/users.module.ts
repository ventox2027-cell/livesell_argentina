import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import { ExportacionService } from './exportacion.service';

/**
 * Los derechos de la persona sobre sus propios datos.
 *
 * Hoy tiene una sola cosa —la exportación— y la regla de mayoría de edad, que
 * es un módulo puro sin dependencias y por eso no se declara acá.
 *
 * Existe como módulo propio en vez de colgar de `auth` porque no es
 * autenticación: es lo que la Ley 25.326 obliga a darle a alguien sobre sus
 * datos. Cuando aparezcan la rectificación y el borrado real, van acá.
 */
@Module({
  providers: [ExportacionService, AuditService],
  exports: [ExportacionService],
})
export class UsersModule {}
