import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';

import {
  configurarPrefijoYVersionado,
  crearAdaptador,
  registrarMultipart,
} from '@/http-setup';

/**
 * Arranca la aplicación EXACTAMENTE como lo hace `main.ts`.
 *
 * ─── Por qué esto no puede estar copiado en cada archivo de test ───
 *
 * Los tests no ejecutan `main.ts`. Cada vez que algo se registró sólo allá, la
 * suite terminó probando un servidor que no existe en producción. Ya pasó dos
 * veces, y las dos con la suite entera en verde:
 *
 *   · Sin `@fastify/multipart`, toda la subida de imágenes devolvía 415. No
 *     había ni un test de imágenes porque cualquiera habría fallado.
 *   · Sin el hook de cuerpo vacío, los DELETE que manda la app —con
 *     `content-type: application/json` y sin cuerpo— devolvían 400. Los cuatro
 *     DELETE estaban rotos en producción y ningún test lo vio, porque
 *     `inject()` sólo manda `content-type` cuando hay cuerpo.
 *   · Y este mismo archivo hacía `new FastifyAdapter()` sin opciones, así que
 *     `trustProxy` y `bodyLimit` existían sólo en producción. La más callada de
 *     las tres: `trustProxy` no rompe nada, cambia de dónde sale `request.ip`.
 *     Cualquier test del límite por IP corría en un servidor que ignora
 *     `X-Forwarded-For` mientras el de verdad lo obedecía.
 *
 *   · Y la cuarta, la peor, porque este archivo ya existía para evitarla: el
 *     prefijo global. Acá decía `exclude: [..., 'webhooks/(.*)', ...]` y
 *     `main.ts` enumeraba las rutas una por una. En los tests TODOS los
 *     webhooks quedaban fuera del prefijo; en producción, sólo dos.
 *
 *     `orders-flow.spec.ts` probaba `POST /webhooks/orders/mercadopago` en
 *     verde mientras el servidor real la servía en
 *     `/api/webhooks/orders/mercadopago`. Esa es la URL que se carga a mano en
 *     el panel de Mercado Pago: habríamos pegado la probada y cada
 *     notificación de pago habría dado 404, con la suite entera pasando.
 *
 * El arreglo no es acordarse de copiar: es que haya un solo lugar. Lo que
 * cambie el comportamiento del servidor —opciones y exclusiones incluidas— va
 * en `src/http-setup.ts`, y esto llama a las mismas funciones que `main.ts`.
 */
export async function crearAppDePrueba(
  moduleRef: TestingModule,
): Promise<NestFastifyApplication> {
  const app = moduleRef.createNestApplication<NestFastifyApplication>(crearAdaptador());

  // ⚠️ La misma función que llama `main.ts`. No escribir la lista acá.
  configurarPrefijoYVersionado(app);

  await registrarMultipart(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
