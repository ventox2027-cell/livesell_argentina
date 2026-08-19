import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { env } from '@/config/env.schema';

/** Local o tests: los dos entornos donde el log de consultas sirve. */
function esLocalODeTest(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      datasources: { db: { url: env.DATABASE_URL } },
      /**
       * Las consultas se emiten como evento en local Y en tests.
       *
       * Decía sólo `development`, y en tests `NODE_ENV` vale `test`: los
       * eventos no llegaban. Eso no molestaba a nadie hasta que se quiso
       * contar consultas para detectar un N+1 — y el contador daba cero, con
       * lo cual los tests pasaban por la razón equivocada.
       *
       * Contar consultas es la única forma barata de que un N+1 se note antes
       * de producción. Con la base a 682 ms de distancia, una consulta por
       * fila son doce segundos de pantalla en blanco que en local no se ven.
       *
       * En producción sigue apagado: emitir un evento por consulta en el
       * camino de cada petición es trabajo que nadie va a leer.
       */
      log: esLocalODeTest(env.NODE_ENV)
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL conectado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Sonda de readiness. Barata a propósito: se ejecuta cada 10 s. */
  async ping(): Promise<number> {
    const start = performance.now();
    await this.$queryRaw`SELECT 1`;
    return Math.round(performance.now() - start);
  }
}
