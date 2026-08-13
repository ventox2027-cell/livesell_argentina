import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

/**
 * Almacenamiento de archivos.
 *
 * ─── Por qué una interfaz y no Cloudflare directo ───
 *
 * Ningún controlador ni servicio de dominio conoce R2. Si lo conocieran,
 * probar la carga de imágenes exigiría credenciales de Cloudflare y una
 * conexión a internet, y cambiar de proveedor sería tocar cada lugar donde se
 * sube algo.
 *
 * En desarrollo se guarda en disco; en producción, en R2. El código que sube
 * una foto de producto es el mismo.
 *
 * ─── Lo que NUNCA se hace ───
 *
 * Guardar el binario en PostgreSQL. Infla los respaldos, satura el pool de
 * conexiones sirviendo bytes, y hace imposible poner un CDN adelante.
 */

// ─── Validación ─────────────────────────────────────────────────────────────

export const MIME_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMAGENES_POR_PRODUCTO = 10;

export class ArchivoInvalidoError extends DomainError {
  constructor(motivo: string) {
    super('INVALID_FILE', motivo);
  }
}

export class ArchivoDemasiadoGrandeError extends DomainError {
  constructor(bytes: number) {
    super('FILE_TOO_LARGE', `La imagen pesa ${(bytes / 1048576).toFixed(1)} MB. El máximo es 10 MB.`, {
      bytes,
      maxBytes: MAX_BYTES,
    });
  }
}

/**
 * Firmas de archivo (números mágicos).
 *
 * ─── Por qué no alcanza con el content-type ───
 *
 * El `content-type` lo declara quien sube. Un `.php` renombrado a `.jpg` y
 * enviado con `image/jpeg` pasa cualquier validación que se fíe de la
 * declaración.
 *
 * Los primeros bytes del archivo no mienten: son parte del formato. Si dicen
 * que no es una imagen, no es una imagen, sin importar qué diga el encabezado.
 */
const FIRMAS: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    // WEBP: "RIFF" .... "WEBP"
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/**
 * Detecta el tipo real a partir del contenido.
 *
 * Devuelve `null` si no reconoce ninguna imagen soportada — y en ese caso se
 * rechaza, sin intentar adivinar.
 */
export function detectarMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  return FIRMAS.find((f) => f.test(buffer))?.mime ?? null;
}

export interface ArchivoSubido {
  buffer: Buffer;
  /** Nombre declarado por el cliente. Se usa SÓLO para la extensión, nunca como ruta. */
  filename: string;
  mimetype: string;
}

export interface ArchivoGuardado {
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
}

export abstract class StorageProvider {
  abstract guardar(params: {
    buffer: Buffer;
    mimeType: string;
    /** Carpeta lógica: `products/prd_01ABC`. */
    prefijo: string;
  }): Promise<ArchivoGuardado>;

  abstract borrar(storageKey: string): Promise<void>;

  /**
   * Nombre del archivo en el almacenamiento.
   *
   * ⚠️ **Nunca se usa el nombre que mandó el cliente.**
   *
   * Un `filename` de `../../../etc/passwd` escribe fuera de la carpeta. Uno con
   * caracteres nulos rompe rutas. Y uno que colisiona con otro pisa la imagen
   * de otro vendedor.
   *
   * Se genera un UUID nuestro y se le pega la extensión que corresponde al
   * tipo REAL detectado, no a la que traía el nombre.
   */
  protected generarKey(prefijo: string, mimeType: string): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    // El prefijo se sanea igual: viene armado por nosotros, pero un id
    // inesperado no puede escaparse de la carpeta.
    const carpeta = prefijo.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/\.\./g, '');
    return `${carpeta}/${randomUUID()}.${ext}`;
  }
}

/**
 * Disco local. Para desarrollo.
 *
 * Se sirve por HTTP desde `/media`. No sirve para producción con más de una
 * máquina —cada una tendría sus propios archivos— y por eso la implementación
 * de R2 existe detrás de la misma interfaz.
 */
@Injectable()
export class LocalStorageProvider extends StorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly raiz = resolve(process.cwd(), 'storage');

  async guardar(params: {
    buffer: Buffer;
    mimeType: string;
    prefijo: string;
  }): Promise<ArchivoGuardado> {
    const storageKey = this.generarKey(params.prefijo, params.mimeType);
    const destino = join(this.raiz, storageKey);

    // Segunda barrera contra el escape de carpeta: aunque `generarKey` ya
    // saneó, se comprueba que la ruta final siga adentro. Las validaciones de
    // ruta se hacen dos veces porque una sola falla en silencio.
    if (!resolve(destino).startsWith(this.raiz)) {
      throw new ArchivoInvalidoError('Ruta de destino inválida');
    }

    await mkdir(join(destino, '..'), { recursive: true });
    await writeFile(destino, params.buffer);

    return {
      storageKey,
      url: `${env.PUBLIC_BASE_URL}/media/${storageKey}`,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
    };
  }

  async borrar(storageKey: string): Promise<void> {
    try {
      const destino = join(this.raiz, storageKey);
      if (!resolve(destino).startsWith(this.raiz)) return;
      await unlink(destino);
    } catch (err) {
      // Que no se pueda borrar un archivo no puede impedir borrar la fila: si
      // no, la imagen queda visible en la app para siempre.
      this.logger.warn({
        msg: 'no se pudo borrar el archivo',
        storageKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Sólo para el controlador que sirve `/media`. */
  rutaDe(storageKey: string): string | null {
    const destino = join(this.raiz, storageKey);
    return resolve(destino).startsWith(this.raiz) ? destino : null;
  }
}

/**
 * Cloudflare R2.
 *
 * Implementa la misma interfaz. Se conecta cuando existan las credenciales;
 * hasta entonces `StorageModule` provee la versión local y ningún otro archivo
 * del proyecto se entera de la diferencia.
 *
 * La subida a R2 se hace con la API S3 (`@aws-sdk/client-s3`), que R2 soporta.
 * Se deja escrito el contrato para que agregarla sea rellenar dos métodos.
 */
@Injectable()
export class R2StorageProvider extends StorageProvider {
  guardar(): Promise<ArchivoGuardado> {
    throw new DomainError(
      'NOT_FOUND',
      'El almacenamiento en R2 todavía no está configurado',
    );
  }

  borrar(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Valida un archivo subido antes de tocar el disco.
 *
 * El orden importa: primero el tamaño —para no procesar 500 MB— y después el
 * contenido.
 */
export function validarImagen(archivo: ArchivoSubido): string {
  if (archivo.buffer.length === 0) throw new ArchivoInvalidoError('El archivo está vacío');
  if (archivo.buffer.length > MAX_BYTES) throw new ArchivoDemasiadoGrandeError(archivo.buffer.length);

  const real = detectarMime(archivo.buffer);
  if (!real) {
    throw new ArchivoInvalidoError('El archivo no es una imagen JPG, PNG o WEBP');
  }
  if (!MIME_PERMITIDOS.has(real)) {
    throw new ArchivoInvalidoError(`Tipo no permitido: ${real}`);
  }

  // El tipo declarado se ignora salvo para avisar de la discrepancia: es
  // exactamente el patrón de un archivo disfrazado.
  if (archivo.mimetype && archivo.mimetype !== real) {
    Logger.warn(
      `tipo declarado (${archivo.mimetype}) distinto del real (${real})`,
      'validarImagen',
    );
  }

  return real;
}

/** Hash del contenido. Permite detectar la misma imagen subida dos veces. */
export function hashContenido(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}
