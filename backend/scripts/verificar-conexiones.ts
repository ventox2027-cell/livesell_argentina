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

/**
 * Prueba el bucket de R2 de punta a punta: sube, firma, descarga y borra.
 *
 * ─── Por qué escribe de verdad en vez de sólo listar ───
 *
 * Las credenciales de R2 se crean con permisos que se eligen en un desplegable,
 * y la combinación equivocada es fácil: un token de sólo lectura deja pasar
 * cualquier comprobación pasiva y falla recién cuando un vendedor sube su
 * primera foto. Lo mismo con un token que puede escribir pero no borrar — eso
 * no se nota nunca, sólo va acumulando objetos huérfanos.
 *
 * El objeto de prueba se borra al final, y ese borrado ES parte de la prueba.
 */
async function probarR2(): Promise<void> {
  console.log('\n▸ Cloudflare R2');

  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import(
    '@aws-sdk/client-s3'
  );
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const bucket = process.env.CHECK_R2_BUCKET ?? 'vendox-products';
  const endpoint = process.env.CHECK_R2_ENDPOINT;

  if (!endpoint) {
    mal('falta CHECK_R2_ENDPOINT');
    return;
  }

  if (/\.r2\.cloudflarestorage\.com/.test(endpoint)) {
    ok('el endpoint tiene la forma de R2');
  } else {
    aviso('el endpoint no parece de R2');
  }

  const cliente = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: process.env.CHECK_R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.CHECK_R2_SECRET_ACCESS_KEY ?? '',
    },
    forcePathStyle: true,
    maxAttempts: 2,
  });

  // Un PNG mínimo real, con su firma en los primeros bytes.
  const contenido = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 1),
  ]);
  const clave = `_verificacion/${process.pid}-${contenido.length}.png`;

  let subido = false;

  try {
    const t0 = performance.now();
    await cliente.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: clave,
        Body: contenido,
        ContentType: 'image/png',
      }),
    );
    subido = true;
    ok(`escritura permitida (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    mal(`no se pudo subir: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    nota('Revisar que el token tenga permiso de escritura sobre este bucket.');
    cliente.destroy();
    return;
  }

  try {
    const firmada = await getSignedUrl(
      cliente,
      new GetObjectCommand({ Bucket: bucket, Key: clave }),
      { expiresIn: 120 },
    );
    ok('se pueden firmar URLs de lectura');

    /**
     * Y ahora la comprobación que de verdad importa: que la URL firmada
     * FUNCIONE desde afuera, sin credenciales.
     *
     * Es lo que va a hacer el teléfono. Firmar bien y que Cloudflare rechace la
     * firma son dos cosas distintas, y la segunda sólo se ve probándola.
     */
    const respuesta = await fetch(firmada);
    if (respuesta.ok) {
      const bytes = Buffer.from(await respuesta.arrayBuffer());
      if (bytes.length === contenido.length) {
        ok('la URL firmada descarga el archivo correcto sin credenciales');
      } else {
        mal(`la descarga devolvió ${bytes.length} bytes en vez de ${contenido.length}`);
      }
      const tipo = respuesta.headers.get('content-type');
      if (tipo === 'image/png') {
        ok('el Content-Type se conserva');
      } else {
        aviso(`Content-Type devuelto: ${tipo ?? 'ninguno'}`);
      }
    } else {
      mal(`la URL firmada devolvió ${respuesta.status}`);
    }
  } catch (err) {
    mal(`falló la lectura firmada: ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * Que el bucket NO sea público.
   *
   * Se pide el mismo objeto sin firma. Tiene que dar 401 o 403. Si diera 200,
   * el bucket está abierto a internet y cualquiera puede enumerar y bajar todo
   * lo que haya adentro.
   */
  try {
    const sinFirmar = `${endpoint.replace(/\/$/, '')}/${bucket}/${clave}`;
    const r = await fetch(sinFirmar);
    if (r.ok) {
      mal('⚠️ EL BUCKET RESPONDE SIN FIRMA: está abierto a internet');
      nota('Deshabilitar el acceso público en el panel de Cloudflare antes de seguir.');
    } else {
      ok(`el bucket rechaza el acceso sin firma (HTTP ${r.status})`);
    }
  } catch {
    ok('el bucket no responde sin firma');
  }

  if (subido) {
    try {
      await cliente.send(new DeleteObjectCommand({ Bucket: bucket, Key: clave }));
      ok('borrado permitido');
    } catch (err) {
      mal(`no se pudo borrar: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      nota('Sin permiso de borrado, cada imagen eliminada deja un objeto huérfano pago.');
      nota(`Queda un objeto de prueba en el bucket: ${clave}`);
    }
  }

  cliente.destroy();
}

async function main(): Promise<void> {
  const pg = process.env.CHECK_DATABASE_URL;
  const rd = process.env.CHECK_REDIS_URL;
  const r2 = process.env.CHECK_R2_ENDPOINT;

  console.log('\nVerificación de conexiones de staging');
  console.log(`${GRIS}No se imprime ninguna cadena de conexión.${FIN}`);

  if (!pg && !rd && !r2) {
    console.log(`\n${ROJO}Falta indicar qué verificar.${FIN}\n`);
    console.log('  PowerShell:');
    console.log('    $env:CHECK_DATABASE_URL="postgresql://..."');
    console.log('    $env:CHECK_REDIS_URL="rediss://..."');
    console.log('    $env:CHECK_R2_ENDPOINT="https://<cuenta>.r2.cloudflarestorage.com"');
    console.log('    $env:CHECK_R2_ACCESS_KEY_ID="..."');
    console.log('    $env:CHECK_R2_SECRET_ACCESS_KEY="..."');
    console.log('    $env:CHECK_R2_BUCKET="vendox-products"');
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
  if (r2) {
    await probarR2();
  }

  if (huboProblemas) {
    console.log(`\n${ROJO}Hay problemas que arreglar antes de desplegar.${FIN}\n`);
    process.exit(1);
  }
  console.log(`\n${VERDE}Todo en orden.${FIN}\n`);
}

void main();
