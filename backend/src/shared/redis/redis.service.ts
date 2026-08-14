import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { env } from '@/config/env.schema';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Reconexión con backoff acotado. Sin tope, una caída larga de Redis
      // deja las reconexiones a intervalos absurdos y la app no se recupera sola.
      retryStrategy: (times) => Math.min(times * 200, 3_000),
      lazyConnect: true,
    });

    this.client.on('error', (err) => this.logger.error({ err }, 'Redis error'));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconectando'));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis conectado');
  }

  /**
   * Cierre que no puede tumbar el apagado.
   *
   * ─── Por qué `quit()` a secas no sirve ───
   *
   * `quit()` manda el comando QUIT al servidor y espera respuesta. Si la
   * conexión ya está cerrada —o Redis está caído, que es un escenario normal en
   * este sistema— la promesa se RECHAZA:
   *
   *     Error: Connection is closed.
   *
   * Y como esto corre dentro de `onModuleDestroy`, ese rechazo se propaga a
   * `app.close()`, mata el apagado ordenado y el proceso termina con código 1.
   * La plataforma lo registra como apagado fallido.
   *
   * Es absurdo que no poder despedirse cortésmente de Redis convierta un
   * despliegue limpio en uno fallido — y más en un sistema cuyo diseño entero
   * asume que Redis se puede caer sin consecuencias.
   *
   * `disconnect()` cierra el socket sin hablar con nadie y no falla nunca.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch (err) {
      this.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Redis no aceptó el QUIT: se cierra el socket directamente',
      );
      this.client.disconnect();
    }
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - start);
  }
}
