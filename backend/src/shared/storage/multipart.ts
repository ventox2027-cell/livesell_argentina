import type { FastifyRequest } from 'fastify';

import { DomainError } from '@/shared/errors/domain.error';

import { MAX_BYTES, type ArchivoSubido } from './storage.provider';

/**
 * Extrae el archivo de una petición `multipart/form-data`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTÁ ACÁ Y NO EN UN CONTROLADOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Era un método privado de `CommerceController`, cuando el único lugar que
 * subía archivos eran las imágenes de producto. Al aparecer las fotos de las
 * reseñas, copiarlo hubiera dejado dos lecturas de multipart con dos criterios
 * que se desincronizan: se endurece una y la otra queda como estaba.
 *
 * Y las tres cosas que hace son de seguridad, no de conveniencia.
 *
 * ⚠️ **El `filename` que llega es del cliente y NUNCA se usa como ruta.**
 * Sólo se pasa para registro. Un nombre como `../../etc/passwd` o
 * `foto.jpg.exe` no puede decidir dónde ni con qué nombre se guarda algo: el
 * nombre real lo genera `StorageProvider`.
 *
 * ⚠️ **El `mimetype` que llega tampoco se cree.** Quien valida es
 * `validarImagen`, que mira los primeros bytes. Un ejecutable declarado como
 * `image/jpeg` pasa esta función y muere ahí.
 *
 * ⚠️ **El tope de tamaño se aplica dos veces.** Fastify corta el stream antes
 * de que el buffer exista, y acá se vuelve a verificar. La segunda no es
 * redundante: si alguien configura mal el límite de Fastify, este `if` es lo
 * único entre una petición de 500 MB y la memoria del proceso.
 */
export async function leerArchivoSubido(req: FastifyRequest): Promise<ArchivoSubido> {
  const conMultipart = req as FastifyRequest & {
    file?: () => Promise<
      | {
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
        }
      | undefined
    >;
  };

  if (typeof conMultipart.file !== 'function') {
    throw new DomainError('INVALID_FILE', 'La petición no es multipart/form-data');
  }

  const parte = await conMultipart.file();
  if (!parte) throw new DomainError('INVALID_FILE', 'No se recibió ningún archivo');

  const buffer = await parte.toBuffer();
  if (buffer.length > MAX_BYTES) {
    throw new DomainError('FILE_TOO_LARGE', 'La imagen supera los 10 MB');
  }

  return { buffer, filename: parte.filename, mimetype: parte.mimetype };
}
