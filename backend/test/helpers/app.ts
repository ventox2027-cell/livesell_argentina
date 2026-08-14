import { VersioningType } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';

import { crearAdaptador, registrarMultipart } from '@/http-setup';

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
 * El arreglo no es acordarse de copiar: es que haya un solo lugar. Lo que
 * cambie el comportamiento del servidor —opciones incluidas— va en
 * `src/http-setup.ts`, y esto llama a la misma función que `main.ts`.
 */
export async function crearAppDePrueba(
  moduleRef: TestingModule,
): Promise<NestFastifyApplication> {
  const app = moduleRef.createNestApplication<NestFastifyApplication>(crearAdaptador());
  app.setGlobalPrefix('api', { exclude: ['health', 'ready', 'metrics', 'webhooks/(.*)'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  await registrarMultipart(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
