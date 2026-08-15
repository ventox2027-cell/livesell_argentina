import { Global, Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';
import { PushDeFirebase } from './push-firebase.provider';
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
 * `NotificationsService` depende de la clase abstracta `PushProvider`, y cuál
 * se usa se decide **una sola vez, acá**, mirando la configuración:
 *
 *   · con `FIREBASE_SERVICE_ACCOUNT_PATH` cargada y `PUSH_ENABLED`, se usa
 *     Firebase de verdad;
 *   · sin eso, la que escribe en el log. Las filas quedan en `SKIPPED`, no en
 *     `SENT`: marcarlas como enviadas sería mentirle a la base, y después nadie
 *     sabría cuáles salieron y cuáles no.
 *
 * ─── Por qué la decisión va en una fábrica y no en un `if` adentro ───
 *
 * Un proveedor que por dentro decide si manda o no obliga a cada llamador a
 * pensar en las dos ramas. Con dos clases, `NotificationsService` no sabe
 * —ni tiene por qué saber— si hay Firebase: pregunta `disponible` y actúa.
 *
 * Todo lo demás funciona igual en los dos casos: las filas se escriben, el
 * centro de notificaciones anda, la deduplicación anda, los reintentos andan.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsDispatcher,
    PushDeConsola,
    PushDeFirebase,
    {
      provide: PushProvider,
      /**
       * ⚠️ Los dos se instancian igual, y es a propósito.
       *
       * `PushDeFirebase` implementa `OnModuleInit` y ahí lee la credencial. Si
       * se creara sólo cuando hace falta, un error de configuración aparecería
       * recién con el primer aviso — seis horas después del despliegue, con un
       * pedido pagado esperando.
       *
       * Creándolo siempre, el arranque falla o avisa en el momento correcto.
       */
      useFactory: (firebase: PushDeFirebase, consola: PushDeConsola): PushProvider =>
        firebase.disponible ? firebase : consola,
      inject: [PushDeFirebase, PushDeConsola],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
