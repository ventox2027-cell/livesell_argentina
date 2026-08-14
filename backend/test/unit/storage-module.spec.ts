import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Que la aplicación ARRANQUE con los dos drivers de almacenamiento.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE TEST EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque ya se rompió, se commiteó y se pusheó así.
 *
 * `MediaController` declara `GET /media/*` para redirigir a una URL firmada de
 * R2. En modo `local`, `main.ts` monta además `@fastify/static` en el mismo
 * prefijo para servir los archivos del disco. Fastify no tolera dos
 * manejadores para la misma ruta y **no arranca**:
 *
 *     FastifyError: Method 'GET' already declared for route '/media/*'
 *
 * Lo que hace a este bug particularmente traicionero es que la verificación que
 * se hizo —arrancar la app compilada con `STORAGE_DRIVER=r2`— pasaba
 * perfectamente: en `r2` no se registra `fastifyStatic`, así que no hay
 * colisión. El único modo roto era `local`, que es el que usa el desarrollo.
 *
 * La lección no es "probar mejor": es que **una condición sobre configuración
 * crea dos programas**, y probar uno no dice nada del otro. Cada rama de
 * `STORAGE_DRIVER` necesita su propio arranque.
 *
 * ─── Por qué se prueba con Fastify a secas y no con la app entera ───
 *
 * Levantar el `AppModule` completo necesita PostgreSQL y Redis, lo que
 * convertiría esto en un test de integración lento por algo que es puramente
 * de registro de rutas. Acá se reproduce exactamente el conflicto: registrar
 * las dos cosas que registra `main.ts` sobre la misma instancia.
 */

const RUTA_MEDIA = '/media/*';

async function registrarComoEnProduccion(driver: 'local' | 'r2'): Promise<void> {
  const app = Fastify();

  // Lo que hace main.ts: sirve el disco SÓLO si el driver es el disco.
  if (driver === 'local') {
    await app.register(fastifyStatic, {
      root: process.cwd(),
      prefix: '/media/',
      index: false,
      list: false,
    });
  }

  // Lo que hace StorageModule: registra el controlador SÓLO con r2.
  if (driver === 'r2') {
    app.get(RUTA_MEDIA, () => ({ ok: true }));
  }

  // `ready()` es donde Fastify valida el árbol de rutas y donde estallaba.
  await app.ready();
  await app.close();
}

describe('registro de /media según STORAGE_DRIVER', () => {
  it('arranca con local: sirve el disco, sin controlador', async () => {
    await expect(registrarComoEnProduccion('local')).resolves.toBeUndefined();
  });

  it('arranca con r2: controlador que redirige, sin servidor de archivos', async () => {
    await expect(registrarComoEnProduccion('r2')).resolves.toBeUndefined();
  });

  it('⛔ registrar LOS DOS hace que Fastify no arranque', async () => {
    /**
     * El bug, reproducido. Este test es el que habría estado rojo.
     *
     * Se comprueba el error concreto y no sólo que falle: si algún día Fastify
     * cambiara a permitir rutas duplicadas —tapando una en silencio— este test
     * seguiría pasando por el motivo equivocado, y quiero que se ponga rojo.
     */
    const app = Fastify();

    await app.register(fastifyStatic, {
      root: process.cwd(),
      prefix: '/media/',
      index: false,
      list: false,
    });

    // Fastify rechaza el duplicado en el momento de declararlo, no al validar
    // el árbol: para cuando `fastifyStatic` está registrado, la ruta ya existe.
    expect(() => app.get(RUTA_MEDIA, () => ({ ok: true }))).toThrowError(/already declared/i);

    await app.close().catch(() => {});
  });
});

/**
 * Y que el módulo real refleje esa decisión.
 *
 * El test de arriba prueba el comportamiento de Fastify; este prueba que
 * `StorageModule` elija bien. Sin él, alguien podría arreglar el conflicto en
 * `main.ts` y volver a registrar el controlador siempre.
 */
describe('StorageModule', () => {
  afterEach(() => vi.doUnmock('@/config/env.schema'));

  async function controladoresCon(driver: 'local' | 'r2'): Promise<unknown[]> {
    vi.resetModules();
    vi.doMock('@/config/env.schema', () => ({
      env: {
        STORAGE_DRIVER: driver,
        R2_BUCKET: 'vendox-products',
        R2_PUBLIC_BASE_URL: undefined,
        R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'x',
        R2_SECRET_ACCESS_KEY: 'x',
        PUBLIC_BASE_URL: 'http://localhost:3100',
      },
      isLocalEnv: () => true,
    }));

    const { StorageModule } = await import('@/shared/storage/storage.module');
    // Los metadatos que Nest lee del decorador.
    return (Reflect.getMetadata('controllers', StorageModule) as unknown[]) ?? [];
  }

  it('con local no registra ningún controlador', async () => {
    expect(await controladoresCon('local')).toHaveLength(0);
  });

  it('con r2 registra MediaController', async () => {
    expect(await controladoresCon('r2')).toHaveLength(1);
  });
});
