/**
 * Sube a R2 los archivos de imagen que hoy viven en el disco local.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En desarrollo `STORAGE_DRIVER=local` guarda las fotos en `backend/storage/`.
 * Fuera de local eso no sirve —el disco del contenedor no se comparte entre
 * instancias y se borra al apagarse— así que el despliegue usa R2.
 *
 * Al mudarse, las filas de `product_images` siguen apuntando a los mismos
 * `storageKey`, pero los archivos no están del otro lado. La URL se arma bien
 * y devuelve 404: la tarjeta sale en gris.
 *
 * Esto copia los archivos, conservando la clave EXACTA. No toca la base.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SÓLO LO QUE LA BASE REFERENCIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El directorio tiene miles de archivos de 150 bytes: son las imágenes
 * sintéticas que la suite de integración sube en cada corrida. Sus productos no
 * existen en ninguna base —la suite trunca al arrancar— pero los archivos
 * quedan.
 *
 * Se recorre la BASE y no el directorio, así que eso no se sube. Un archivo sin
 * fila es basura por definición: nada puede pedirlo, porque la URL se deriva de
 * la fila.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Antes de subir se hace un `HEAD`. Si el objeto ya está y pesa lo mismo, se
 * saltea. Correrlo dos veces no vuelve a subir nada ni rompe nada, así que se
 * puede reintentar después de un corte sin pensarlo.
 *
 *   pnpm media:subir            # sube
 *   pnpm media:subir --dry-run  # sólo informa, no escribe nada
 *
 * ⚠️ NO borra los archivos locales. Eso es una decisión aparte, y conviene
 * tomarla después de verificar que las imágenes se ven desde el teléfono.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const SOLO_INFORMAR = process.argv.includes('--dry-run');

/** Las que hacen falta. Se piden explícitas para no subir a un bucket equivocado. */
const REQUERIDAS = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET',
] as const;

/**
 * El tipo REAL del archivo, por sus primeros bytes.
 *
 * No se confía en la columna `mime_type` a secas: es lo que se detectó al
 * subir, y si alguna vez se guardó mal, R2 devolvería ese `Content-Type` al
 * servir el objeto. Un archivo servido como `text/html` desde nuestro dominio
 * sería XSS almacenado. Se comparan los dos y se avisa si difieren.
 */
function mimeReal(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function main(): Promise<void> {
  const faltan = REQUERIDAS.filter((k) => !process.env[k]);
  if (faltan.length > 0) {
    console.error(
      `\nFaltan variables de R2: ${faltan.join(', ')}.\n\n` +
        'Se sacan del panel de Cloudflare → R2 → Manage API Tokens.\n' +
        'Cargalas en el entorno de esta terminal, no en el repositorio.\n',
    );
    process.exit(1);
  }

  const bucket = process.env.R2_BUCKET!;
  const cliente = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // R2 no soporta el estilo por subdominio. Sin esto las peticiones van a un
    // host que no resuelve y el error habla de DNS, no de configuración.
    forcePathStyle: true,
    maxAttempts: 3,
  });

  const prisma = new PrismaClient();
  const raiz = resolve(process.cwd(), 'storage');

  // La BASE es la fuente de verdad, no el directorio. Ver el comentario de
  // arriba sobre los miles de archivos de los tests.
  const filas = await prisma.productImage.findMany({
    select: { id: true, storageKey: true, mimeType: true, productId: true },
    orderBy: { storageKey: 'asc' },
  });

  console.log(`\nFilas de imagen en la base: ${filas.length}`);
  console.log(`Directorio local: ${raiz}`);
  console.log(`Bucket: ${bucket}`);
  if (SOLO_INFORMAR) console.log('\n⚠️  --dry-run: no se escribe nada en R2.\n');

  const stats = {
    subidos: 0,
    yaEstaban: 0,
    sinArchivoLocal: 0,
    tipoDiscordante: 0,
    errores: 0,
  };
  const contenidos = new Map<string, string[]>();

  for (const fila of filas) {
    const ruta = join(raiz, fila.storageKey);

    // El `storageKey` lo generamos nosotros, pero se comprueba igual que la
    // ruta final siga adentro: una clave inesperada no puede leer fuera de la
    // carpeta.
    if (!resolve(ruta).startsWith(raiz)) {
      console.error(`  ⨯ clave fuera de la carpeta: ${fila.storageKey}`);
      stats.errores += 1;
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(ruta);
    } catch {
      console.warn(`  · sin archivo local: ${fila.storageKey}`);
      stats.sinArchivoLocal += 1;
      continue;
    }

    // Duplicados: informativo. NO se colapsan — cada fila tiene su clave y
    // fusionarlas dejaría un producto apuntando al archivo de otro.
    const hash = createHash('sha256').update(bytes).digest('hex');
    contenidos.set(hash, [...(contenidos.get(hash) ?? []), fila.storageKey]);

    const detectado = mimeReal(bytes);
    if (detectado && detectado !== fila.mimeType) {
      console.warn(
        `  ⚠ tipo discordante en ${fila.storageKey}: la base dice ${fila.mimeType}, ` +
          `los bytes dicen ${detectado}. Se sube con el tipo REAL.`,
      );
      stats.tipoDiscordante += 1;
    }
    const contentType = detectado ?? fila.mimeType;

    try {
      const yaEsta = await cliente
        .send(new HeadObjectCommand({ Bucket: bucket, Key: fila.storageKey }))
        .then((r) => r.ContentLength === bytes.length)
        .catch(() => false);

      if (yaEsta) {
        stats.yaEstaban += 1;
        continue;
      }

      if (SOLO_INFORMAR) {
        console.log(`  + subiría ${fila.storageKey} (${bytes.length} bytes, ${contentType})`);
        stats.subidos += 1;
        continue;
      }

      await cliente.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fila.storageKey,
          Body: bytes,
          ContentType: contentType,
          // Un año. Es seguro porque la clave lleva un UUID: una imagen
          // distinta es una clave distinta, así que nada cacheado envejece mal.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      console.log(`  ✓ ${fila.storageKey} (${bytes.length} bytes, ${contentType})`);
      stats.subidos += 1;
    } catch (err) {
      // El mensaje del SDK, no el objeto: los errores de AWS traen la
      // configuración del cliente adentro, credenciales incluidas.
      console.error(
        `  ⨯ ${fila.storageKey}: ${err instanceof Error ? err.message : 'error desconocido'}`,
      );
      stats.errores += 1;
    }
  }

  const duplicados = [...contenidos.values()].filter((k) => k.length > 1);

  console.log('\n─── Resumen ───');
  console.log(`  referenciados por la base : ${filas.length}`);
  console.log(`  ${SOLO_INFORMAR ? 'a subir' : 'subidos'}                  : ${stats.subidos}`);
  console.log(`  ya estaban en R2          : ${stats.yaEstaban}`);
  console.log(`  sin archivo local         : ${stats.sinArchivoLocal}`);
  console.log(`  tipo discordante          : ${stats.tipoDiscordante}`);
  console.log(`  errores                   : ${stats.errores}`);
  console.log(
    `  contenidos duplicados     : ${duplicados.length}` +
      (duplicados.length > 0 ? ' (se suben igual: cada fila tiene su clave)' : ''),
  );

  await prisma.$disconnect();
  process.exit(stats.errores > 0 ? 1 : 0);
}

void main();
