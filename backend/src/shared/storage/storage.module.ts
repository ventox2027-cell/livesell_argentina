import { Global, Logger, Module } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { MediaController } from '@/shared/storage/media.controller';
import { R2StorageProvider } from '@/shared/storage/r2.provider';
import { StorageMetrics } from '@/shared/storage/storage.metrics';
import { LocalStorageProvider, StorageProvider } from '@/shared/storage/storage.provider';

/**
 * Dónde se eligen disco o R2. **El único lugar del proyecto que lo sabe.**
 *
 * ─── Por qué la elección vive acá y no en un `if` dentro del servicio ───
 *
 * `ImagesService` depende de la clase abstracta `StorageProvider` y no tiene
 * forma de saber cuál le tocó. Eso es lo que permite que los tests de subida
 * de imágenes corran sin credenciales de Cloudflare y sin red, y que cambiar
 * de proveedor no sea tocar cada lugar donde se sube algo.
 *
 * Un `if (env.STORAGE_DRIVER === 'r2')` dentro del servicio tendría el efecto
 * contrario: cada test tendría que decidir qué rama ejercita, y la rama de R2
 * quedaría sin probar por incómoda.
 *
 * ─── Global ───
 *
 * Porque el proveedor lo necesitan Commerce (subir y borrar) y el controlador
 * de `/media` (servir), y ninguno de los dos debería importar el módulo del
 * otro para conseguirlo.
 */
// Sin `imports: [ObservabilityModule]`: ese módulo es @Global y ya exporta
// `MetricsService`. Importarlo además abriría un ciclo el día que
// Observability necesite algo de acá.
@Global()
@Module({
  /**
   * ⚠️ El controlador SÓLO se registra con `r2`.
   *
   * Con `local`, `main.ts` monta `@fastify/static` en `/media/` para servir los
   * archivos del disco. Si además se registrara esto, habría dos manejadores
   * para `GET /media/*` y Fastify **se niega a arrancar**:
   *
   *     FastifyError: Method 'GET' already declared for route '/media/*'
   *
   * No es un aviso ni una ruta que quede tapada: el proceso muere al iniciar.
   * Y no se ve probando con `r2` —donde `fastifyStatic` no se registra y no hay
   * conflicto—, sólo en local, que es justamente donde se desarrolla.
   *
   * Los dos caminos tienen que probarse. Ver `test/unit/storage-module.spec.ts`.
   */
  controllers: env.STORAGE_DRIVER === 'r2' ? [MediaController] : [],
  providers: [
    StorageMetrics,
    LocalStorageProvider,
    R2StorageProvider,
    {
      provide: StorageProvider,
      inject: [LocalStorageProvider, R2StorageProvider],
      useFactory: (local: LocalStorageProvider, r2: R2StorageProvider): StorageProvider => {
        const elegido = env.STORAGE_DRIVER === 'r2' ? r2 : local;

        Logger.log(
          env.STORAGE_DRIVER === 'r2'
            ? `imágenes en R2 (bucket ${env.R2_BUCKET}, ` +
                `${env.R2_PUBLIC_BASE_URL ? 'dominio público' : 'redirección firmada'})`
            : 'imágenes en disco local',
          'StorageModule',
        );

        return elegido;
      },
    },
  ],
  /**
   * `R2StorageProvider` se exporta para `DescargasController`.
   *
   * Esa ruta reparte el APK con una URL firmada — el mismo mecanismo que
   * `/media/*`, y por el mismo motivo: el bucket es privado y tiene que seguir
   * siéndolo.
   *
   * Se exporta la clase concreta y no `StorageProvider` porque `urlFirmada`
   * sólo existe en R2: con disco local no hay nada que firmar, y el controlador
   * lo dice con un mensaje en vez de fingir una descarga.
   */
  exports: [StorageProvider, StorageMetrics, R2StorageProvider],
})
export class StorageModule {}
