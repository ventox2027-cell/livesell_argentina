/**
 * Comprueba que las cadenas de conexión de staging sirven, ANTES de desplegar.
 *
 *   $env:CHECK_DATABASE_URL="postgresql://..."
 *   $env:CHECK_REDIS_URL="rediss://..."
 *   npm run check:conexiones
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sin esto, la primera vez que una cadena mal armada se ejerce es con la
 * aplicación ya desplegada. Y los errores de este tipo no se presentan como
 * errores de configuración:
 *
 *   · La región equivocada no falla. Anda, y anda lento. Se descubre midiendo
 *     capacidad, cuando uno cree haber encontrado el techo del diseño y en
 *     realidad está midiendo el viaje a Virginia.
 *   · El pooler sin `pgbouncer=true` tampoco falla al conectar. Falla más
 *     tarde, bajo concurrencia, con un mensaje sobre prepared statements que
 *     parece un bug del código.
 *   · `redis://` en vez de `rediss://` no falla nunca. Funciona igual, con las
 *     credenciales viajando en texto plano.
 *
 * Los tres se detectan acá en diez segundos.
 *
 * ─── Sobre imprimir ───
 *
 * NUNCA se imprime una cadena de conexión ni parte de ella. Se informa qué se
 * verificó y qué dio, no con qué. La salida de este script tiene que poder
 * pegarse en un chat sin consecuencias.
 */
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const FIN = '\x1b[0m';

let huboProblemas = false;

function ok(msg: string): void {
  console.log(`  ${VERDE}✓${FIN} ${msg}`);
}
function mal(msg: string): void {
  console.log(`  ${ROJO}✗${FIN} ${msg}`);
  huboProblemas = true;
}
function aviso(msg: string): void {
  console.log(`  ${AMARILLO}!${FIN} ${msg}`);
}
function nota(msg: string): void {
  console.log(`    ${GRIS}${msg}${FIN}`);
}

/**
 * Revisa la FORMA de la cadena antes de conectarse.
 *
 * Va primero porque los tres errores que más caro salen son de forma, no de
 * conectividad: con la cadena mal armada la conexión funciona igual y el
 * problema aparece semanas después.
 */
function revisarFormaPostgres(url: string): void {
  console.log('\n▸ PostgreSQL — forma de la cadena');

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    mal('no es una URL válida');
    return;
  }

  if (u.hostname.includes('.sa-east-1.')) {
    ok('región sa-east-1 (São Paulo)');
  } else if (/\.(us|eu|ap)-/.test(u.hostname)) {
    const region = /\.((?:us|eu|ap)-[a-z]+-\d)\./.exec(u.hostname)?.[1] ?? 'otra';
    mal(`la región es ${region}, no São Paulo`);
    nota('En Neon la región NO se puede cambiar: hay que borrar el proyecto y rehacerlo.');
    nota('Cada consulta se iría hasta allá y volvería. Mide capacidad de la red, no de la app.');
  } else {
    aviso('no se pudo deducir la región del host');
  }

  const esPooler = u.hostname.includes('-pooler');
  const tienePgbouncer = /[?&]pgbouncer=true/.test(url);

  if (esPooler && tienePgbouncer) {
    ok('es la URL del pooler y lleva pgbouncer=true');
  } else if (esPooler) {
    mal('es la URL del pooler pero le falta `pgbouncer=true`');
    nota('Prisma usaría prepared statements que PgBouncer no sostiene en modo transacción.');
    nota('Falla como `prepared statement "s0" already exists`, sólo bajo concurrencia.');
    nota('Agregar al final: &pgbouncer=true&connection_limit=5');
  } else {
    aviso('es la URL DIRECTA (sin -pooler)');
    nota('Correcta para migraciones (STAGING_DATABASE_URL_DIRECT).');
    nota('Para la aplicación va la del pooler: sin ella Neon corta conexiones bajo carga.');
  }

  if (/sslmode=(require|verify-full)/.test(url)) {
    ok('sslmode presente');
  } else {
    mal('falta `sslmode=require`');
  }

  if (esPooler) {
    const limite = /[?&]connection_limit=(\d+)/.exec(url)?.[1];
    if (limite) {
      ok(`connection_limit=${limite}`);
    } else {
      aviso('sin connection_limit: Prisma abre por omisión más conexiones de las necesarias');
      nota('Con 512 MB de RAM y el plan gratuito de Neon, 5 es un buen número.');
    }
  }
}

function revisarFormaRedis(url: string): void {
  console.log('\n▸ Redis — forma de la cadena');

  if (url.startsWith('rediss://')) {
    ok('rediss:// — la conexión va cifrada');
  } else if (url.startsWith('redis://')) {
    mal('redis:// con una sola ese: la conexión NO va cifrada');
    nota('El token de Upstash viaja en texto plano por internet abierto.');
    nota('No da error ni aviso: funciona igual. Por eso hay que mirarlo.');
    nota('En la consola de Upstash, elegí el cliente "ioredis": esa URL es la correcta.');
  } else {
    mal('no empieza con redis:// ni rediss://');
  }

  try {
    const u = new URL(url);
    if (u.hostname.includes('sa-east-1')) {
      ok('región sa-east-1 (São Paulo)');
    } else {
      aviso('no se pudo confirmar que la región sea São Paulo');
    }
  } catch {
    mal('no es una URL válida');
  }
}

async function probarPostgres(url: string): Promise<void> {
  console.log('\n▸ PostgreSQL — conexión real');

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const t0 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    const primera = Math.round(performance.now() - t0);
    ok(`conecta y responde (${primera} ms, primera consulta con handshake incluido)`);

    // Diez consultas seguidas sobre la conexión ya abierta: esto sí es la
    // latencia de red pura, y es el número que importa para capacidad.
    const tiempos: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      tiempos.push(performance.now() - t);
    }
    tiempos.sort((a, b) => a - b);
    const mediana = Math.round(tiempos[Math.floor(tiempos.length / 2)] ?? 0);

    console.log(`    ${GRIS}ida y vuelta mediano: ${mediana} ms${FIN}`);
    if (mediana < 60) {
      // No afirma dónde está la base: sólo que el número entra en presupuesto.
      // Un 1 ms es una base local, no São Paulo, y decir lo contrario sería
      // exactamente el tipo de confirmación falsa que este script existe para
      // no dar.
      ok('dentro del presupuesto de latencia');
    } else if (mediana < 150) {
      aviso(`${mediana} ms es más de lo esperable desde Argentina a São Paulo`);
      nota('Puede ser tu conexión. Desde Fly (gru) va a ser mucho menor.');
    } else {
      mal(`${mediana} ms sugiere que la base NO está en São Paulo`);
    }

    const [v] = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    const mayor = /PostgreSQL (\d+)/.exec(v?.version ?? '')?.[1];
    if (mayor && Number(mayor) >= 16) {
      ok(`PostgreSQL ${mayor}`);
    } else {
      aviso(`PostgreSQL ${mayor ?? '?'} — el proyecto se desarrolló contra 16`);
    }

    /**
     * Cuántas migraciones hay aplicadas.
     *
     * Contra una base recién creada esto falla porque la tabla todavía no
     * existe, y ESA es la respuesta correcta: significa que falta el paso de
     * migrar. Vale distinguirlo de un error de conexión.
     */
    try {
      const filas = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
      `;
      ok(`${filas[0]?.n ?? 0} migraciones aplicadas`);
    } catch {
      aviso('base vacía: todavía no se corrieron las migraciones');
      nota('Es lo esperable en una base recién creada. Se hace en el paso H.');
    }
  } catch (err) {
    mal(`no conecta: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function probarRedis(url: string): Promise<void> {
  console.log('\n▸ Redis — conexión real');

  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    retryStrategy: () => null, // acá no queremos que reintente: queremos saber
    connectTimeout: 10_000,
  });
  redis.on('error', () => {}); // el error se reporta abajo, sin ruido de ioredis

  try {
    const t0 = performance.now();
    await redis.connect();
    ok(`conecta (${Math.round(performance.now() - t0)} ms con handshake TLS)`);

    const tiempos: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await redis.ping();
      tiempos.push(performance.now() - t);
    }
    tiempos.sort((a, b) => a - b);
    const mediana = Math.round(tiempos[Math.floor(tiempos.length / 2)] ?? 0);
    console.log(`    ${GRIS}ida y vuelta mediano: ${mediana} ms${FIN}`);

    /**
     * BullMQ necesita estos comandos y algunos Redis administrados los limitan.
     * Vale comprobarlo antes: la cola de vencimiento de reservas depende de
     * ellos, y aunque el sistema tolera que Redis se caiga, no tolera un Redis
     * que responde pero no sabe hacer lo que se le pide.
     */
    const clave = `vendox:check:${process.pid}`;
    await redis.set(clave, '1', 'EX', 10);
    await redis.zadd(`${clave}:z`, 1, 'a');
    await redis.expire(`${clave}:z`, 10);
    await redis.eval("return redis.call('get', KEYS[1])", 1, clave);
    await redis.del(clave, `${clave}:z`);
    ok('SET, ZADD, EXPIRE y EVAL disponibles (los que usan BullMQ y el límite de peticiones)');
  } catch (err) {
    mal(`no conecta: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const pg = process.env.CHECK_DATABASE_URL;
  const rd = process.env.CHECK_REDIS_URL;

  console.log('\nVerificación de conexiones de staging');
  console.log(`${GRIS}No se imprime ninguna cadena de conexión.${FIN}`);

  if (!pg && !rd) {
    console.log(`\n${ROJO}Falta indicar qué verificar.${FIN}\n`);
    console.log('  PowerShell:');
    console.log('    $env:CHECK_DATABASE_URL="postgresql://..."');
    console.log('    $env:CHECK_REDIS_URL="rediss://..."');
    console.log('    npm run check:conexiones\n');
    process.exit(1);
  }

  if (pg) {
    revisarFormaPostgres(pg);
    await probarPostgres(pg);
  }
  if (rd) {
    revisarFormaRedis(rd);
    await probarRedis(rd);
  }

  if (huboProblemas) {
    console.log(`\n${ROJO}Hay problemas que arreglar antes de desplegar.${FIN}\n`);
    process.exit(1);
  }
  console.log(`\n${VERDE}Todo en orden.${FIN}\n`);
}

void main();
