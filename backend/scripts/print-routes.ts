/**
 * Imprime las rutas que el servidor registró de verdad.
 *
 * Sirve cuando un endpoint responde 404 y no se sabe si el problema es el
 * decorador, el prefijo global, el versionado o que el módulo no se cargó.
 * Leer el código no lo distingue; esto sí.
 *
 *   pnpm exec tsx scripts/print-routes.ts
 */
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api', { exclude: ['health', 'ready', 'metrics', 'webhooks/(.*)'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  console.log(app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }));
  await app.close();
}

void main();
