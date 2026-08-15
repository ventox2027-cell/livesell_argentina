#!/usr/bin/env node
/**
 * Aplica UNA migración a la base de desarrollo y a la de tests, y la registra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO ALCANZA CON `prisma migrate dev`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `migrate dev` aplica a UNA base. La de tests es otra, y si se queda atrás la
 * suite falla con errores de columna inexistente que parecen bugs del código.
 * Existe `pnpm test:db:migrate` para eso, pero necesita que la de desarrollo ya
 * esté al día y que el cliente de Prisma se pueda regenerar — dos cosas que en
 * esta máquina fallan cuando un proceso elevado tiene tomado el motor.
 *
 * Este script hace las dos bases de una y escribe la fila en
 * `_prisma_migrations` con el checksum correcto, que es lo que hace que
 * `migrate status` y `migrate deploy` sigan funcionando después.
 *
 * ⚠️ NO reemplaza a `prisma migrate deploy` en producción. Es una herramienta
 * de desarrollo local: no hay bloqueo, no hay transacción entre bases y no
 * verifica el orden. En un servidor se usa `pnpm migrate:deploy`.
 *
 * ─── Uso ───
 *
 *     node scripts/aplicar-migracion.mjs 20260814150000_lo_que_sea
 */

import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VERDE = '\x1b[32m';
const AMARILLO = '\x1b[33m';
const ROJO = '\x1b[31m';
const FIN = '\x1b[0m';

const nombre = process.argv[2];
if (!nombre) {
  console.error(`${ROJO}✗${FIN} Falta el nombre de la migración.`);
  console.error('  node scripts/aplicar-migracion.mjs 20260814150000_lo_que_sea');
  process.exit(1);
}

const archivo = join(RAIZ, 'prisma', 'migrations', nombre, 'migration.sql');
if (!existsSync(archivo)) {
  console.error(`${ROJO}✗${FIN} No existe ${archivo}`);
  process.exit(1);
}

const bruto = readFileSync(archivo);
const checksum = createHash('sha256').update(bruto).digest('hex');

/**
 * Se parten las sentencias por `;`, descartando primero las líneas de
 * comentario.
 *
 * Prisma no expone un ejecutor de archivos `.sql`, y `$executeRawUnsafe` acepta
 * una sentencia por vez. Los comentarios se sacan antes porque un `--` seguido
 * de un `;` en la misma línea partiría mal.
 *
 * ⚠️ Esto no entiende de funciones con `;` adentro (`DO $$ ... $$`). Si alguna
 * migración las necesita, hay que aplicarla con `psql`.
 */
const sentencias = readFileSync(archivo, 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const BASES = [
  ['desarrollo', 'postgresql://livesell:livesell@127.0.0.1:5433/livesell?schema=public'],
  ['tests', 'postgresql://livesell:livesell@127.0.0.1:5433/livesell_test?schema=public'],
];

let hubo = false;

for (const [etiqueta, url] of BASES) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  const yaEsta = await prisma.$queryRawUnsafe(
    'select count(*)::int n from _prisma_migrations where migration_name = $1 and finished_at is not null',
    nombre,
  );

  if (yaEsta[0].n > 0) {
    /**
     * Ya estaba aplicada: se refresca el checksum.
     *
     * Editar el SQL de una migración YA aplicada —para corregir algo antes de
     * commitear— deja el checksum guardado apuntando a la versión vieja, y
     * Prisma se niega a seguir con:
     *
     *     The migration `X` was modified after it was applied.
     *     We need to reset the schema. All data will be lost.
     *
     * En desarrollo eso significa perder la base entera por un comentario
     * corregido. Se refresca el checksum y listo.
     *
     * ⚠️ Es correcto SÓLO en desarrollo, donde el SQL ya aplicado y el del
     * archivo son equivalentes porque los editó la misma persona hace un
     * minuto. En un servidor, un checksum que no coincide es una señal de que
     * alguien cambió una migración desplegada, y ahí hay que mirar de verdad.
     */
    await prisma.$executeRawUnsafe(
      'update _prisma_migrations set checksum = $1 where migration_name = $2',
      checksum,
      nombre,
    );
    console.log(`${AMARILLO}=${FIN} ${etiqueta}: ya estaba aplicada (checksum refrescado).`);
    await prisma.$disconnect();
    continue;
  }

  /**
   * Todo o nada.
   *
   * ─── Por qué una transacción y no sentencia por sentencia ───
   *
   * La primera versión aplicaba de a una y seguía cuando alguna fallaba. El
   * resultado fue una migración a MEDIAS: los enums y una tabla creados, la
   * otra no, y la fila de `_prisma_migrations` sin escribir. Reintentar fallaba
   * con "ya existe", y limpiarlo a mano llevó más tiempo que escribir esto.
   *
   * PostgreSQL soporta DDL transaccional —a diferencia de MySQL— así que un
   * fallo a la mitad deshace también las tablas ya creadas.
   */
  let fallos = 0;
  try {
    await prisma.$transaction(sentencias.map((s) => prisma.$executeRawUnsafe(s)));
  } catch (err) {
    fallos = 1;
    hubo = true;
    console.log(`  ${ROJO}${String(err.message).replace(/\s+/g, ' ').slice(-200)}${FIN}`);
  }

  // Las filas a medias de un intento anterior confunden a `migrate deploy`,
  // que se niega a seguir mientras haya una migración marcada como fallida.
  await prisma.$executeRawUnsafe(
    'delete from _prisma_migrations where migration_name = $1 and finished_at is null',
    nombre,
  );

  if (fallos === 0) {
    await prisma.$executeRawUnsafe(
      'insert into _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) ' +
        'values ($1, $2, now(), $3, null, null, now(), $4)',
      randomUUID(),
      checksum,
      nombre,
      sentencias.length,
    );
    console.log(`${VERDE}✓${FIN} ${etiqueta}: ${sentencias.length} sentencias.`);
  } else {
    console.log(`${ROJO}✗${FIN} ${etiqueta}: ${fallos} fallaron, NO se registró.`);
  }

  await prisma.$disconnect();
}

process.exit(hubo ? 1 : 0);
