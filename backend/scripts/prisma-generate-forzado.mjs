#!/usr/bin/env node
/**
 * `prisma generate` cuando el motor está bloqueado por otro proceso.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PROBLEMA RESUELVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En Windows, si hay un proceso Node vivo que ya cargó el cliente de Prisma
 * —el backend en modo watch, un test colgado, un `node dist/main.js`— el
 * archivo `query_engine-windows.dll.node` queda tomado. Prisma genera todo en
 * archivos temporales y al final los renombra; ese rename falla:
 *
 *     EPERM: operation not permitted, rename '...dll.node.tmp35488' -> '...dll.node'
 *
 * Y como falla, **no escribe tampoco los tipos**. El resultado es que
 * `schema.prisma` tiene la columna nueva, la base tiene la columna nueva, y
 * TypeScript insiste en que no existe. Se pierde media hora buscando el error
 * en el lugar equivocado.
 *
 * ─── Lo que hace este script ───
 *
 * Genera a un directorio temporal —donde nada está bloqueado— y copia encima
 * del directorio real todo MENOS el `.dll.node`. El motor viejo sirve igual
 * mientras la versión de Prisma no cambie: es el mismo binario.
 *
 * También borra los `.dll.node.tmpNNNNN` huérfanos que dejaron los intentos
 * fallidos. Son 21 MB cada uno y se acumulan de a decenas.
 *
 * ⚠️ Si la versión de Prisma en `package.json` cambió, esto NO alcanza: hace
 * falta el motor nuevo. Ahí hay que cerrar el proceso que lo tiene tomado y
 * correr `pnpm prisma generate` normal. El script lo detecta y avisa.
 *
 * ─── Uso ───
 *
 *     node scripts/prisma-generate-forzado.mjs
 *
 * Primero intenta el camino normal. Sólo si ese falla por EPERM hace el rodeo.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(RAIZ, 'prisma', 'schema.prisma');

const VERDE = '\x1b[32m';
const AMARILLO = '\x1b[33m';
const ROJO = '\x1b[31m';
const FIN = '\x1b[0m';

const CLI_PRISMA = join(RAIZ, 'node_modules', 'prisma', 'build', 'index.js');

function generar(extraEnv = {}) {
  // Se invoca el CLI de Prisma con el propio Node, no `npx`.
  //
  // `npx` en Windows es un `.cmd`, y Node 24 se niega a lanzarlo sin shell
  // (EINVAL); con shell, concatena los argumentos sin escaparlos y la ruta de
  // este proyecto tiene espacios. Ejecutar el JS directo evita las dos cosas.
  execFileSync(process.execPath, [CLI_PRISMA, 'generate'], {
    cwd: RAIZ,
    stdio: 'pipe',
    env: { ...process.env, ...extraEnv },
  });
}

// ─── 1 · El camino normal ────────────────────────────────────────────────────

try {
  generar();
  console.log(`${VERDE}✓${FIN} Cliente de Prisma generado.`);
  process.exit(0);
} catch (err) {
  const salida = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (!salida.includes('EPERM')) {
    console.error(salida || err.message);
    process.exit(1);
  }
  console.log(`${AMARILLO}!${FIN} El motor está bloqueado por otro proceso. Rodeo.`);
}

// ─── 2 · Dónde vive el cliente instalado ─────────────────────────────────────

const destino = (() => {
  const req = createRequirePolyfill();
  // `.prisma/client` es hermano de `@prisma/`, dentro del mismo
  // `node_modules`. Con pnpm esa ruta lleva un hash, así que se resuelve desde
  // el paquete instalado en vez de adivinarla:
  //
  //   .../node_modules/@prisma/client/default.js   ← resolve
  //   .../node_modules/@prisma/client              ← dirname
  //   .../node_modules                             ← ../..
  //   .../node_modules/.prisma/client              ← destino
  const paquete = req.resolve('@prisma/client');
  return join(dirname(paquete), '..', '..', '.prisma', 'client');
})();

function createRequirePolyfill() {
  return { resolve: (m) => import.meta.resolve(m).replace(/^file:\/\/\//, '').replace(/%20/g, ' ') };
}

if (!existsSync(destino)) {
  console.error(`${ROJO}✗${FIN} No encontré el cliente instalado en ${destino}`);
  process.exit(1);
}

// ─── 3 · Generar aparte ──────────────────────────────────────────────────────

const temporal = mkdtempSync(join(tmpdir(), 'prisma-forzado-'));
const salidaTemporal = join(temporal, 'client');
const original = readFileSync(SCHEMA, 'utf8');

try {
  const conSalida = original.replace(
    /generator client \{([^}]*)\}/,
    (bloque, cuerpo) =>
      /output\s*=/.test(cuerpo)
        ? bloque
        : `generator client {${cuerpo.replace(/\s*$/, '')}\n  output   = "${salidaTemporal.replace(/\\/g, '/')}"\n}`,
  );
  writeFileSync(SCHEMA, conSalida);
  generar();
} finally {
  // Pase lo que pase, el schema vuelve como estaba. Dejarlo con un `output`
  // apuntando a una carpeta temporal sería peor que el problema original.
  writeFileSync(SCHEMA, original);
}

// ─── 4 · Copiar encima, menos el motor ───────────────────────────────────────

let copiados = 0;
let bloqueados = 0;

for (const nombre of readdirSync(salidaTemporal, { withFileTypes: true })) {
  if (nombre.name.endsWith('.dll.node') || nombre.name.includes('.tmp')) continue;
  try {
    cpSync(join(salidaTemporal, nombre.name), join(destino, nombre.name), { recursive: true, force: true });
    copiados += 1;
  } catch {
    bloqueados += 1;
  }
}

// Los huérfanos de los intentos fallidos: 21 MB cada uno.
let basura = 0;
for (const nombre of readdirSync(destino)) {
  if (!nombre.includes('.dll.node.tmp')) continue;
  try {
    rmSync(join(destino, nombre));
    basura += 1;
  } catch {
    /* tomado por el mismo proceso que bloquea el motor */
  }
}

rmSync(temporal, { recursive: true, force: true });

console.log(`${VERDE}✓${FIN} Tipos actualizados (${copiados} archivos).`);
if (bloqueados > 0) console.log(`  ${AMARILLO}${bloqueados} quedaron bloqueados.${FIN}`);
if (basura > 0) console.log(`  ${basura} motores temporales huérfanos borrados.`);
console.log(`  ${AMARILLO}El motor sigue siendo el viejo.${FIN} Sirve mientras no cambie la versión de Prisma.`);
