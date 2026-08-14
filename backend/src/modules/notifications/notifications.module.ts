import { Global, Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';
import { PushDeConsola, PushProvider } from './push.provider';

/**
 * Avisos: el centro de notificaciones y el envío de push.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `@Global` A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Casi todos los módulos necesitan avisar algo: órdenes cuando cambia un
 * estado, tiendas cuando reabren, vivos cuando arranca uno, soporte cuando hay
 * respuesta. Importarlo en cada uno sería ocho líneas repetidas y, peor, un
 * grafo donde `NotificationsModule` termina importado por todos y no puede
 * importar a ninguno.
 *
 * Es la misma decisión que ya está tomada con `PrismaService`: infraestructura
 * transversal se inyecta, no se importa.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL PROVEEDOR DE PUSH SE ELIGE ACÁ Y EN NINGÚN OTRO LADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NotificationsService` depende de la clase abstracta `PushProvider`. Hoy la
 * única implementación es la que escribe en el log, porque **todavía no hay
 * credenciales de Firebase** — crearlas es una decisión con consecuencias
 * (proyecto de Google Cloud, clave privada de servicio) que no se toma sin el
 * dueño del producto delante.
 *
 * Todo lo demás funciona igual mientras tanto: las filas se escriben, el centro
 * de notificaciones anda, la deduplicación anda, los reintentos andan. Cuando
 * lleguen las credenciales, se agrega `PushDeFirebase` y se cambia esta línea.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsDispatcher,
    PushDeConsola,
    {
      provide: PushProvider,
      useExisting: PushDeConsola,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
