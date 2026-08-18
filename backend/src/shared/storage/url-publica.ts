import { env } from '@/config/env.schema';

/**
 * La URL con la que se muestra un archivo, derivada del `storageKey`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE CALCULA AL LEER, NO SE GUARDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `product_images` tiene una columna `url` con la dirección completa, escrita
 * cuando se subió el archivo. Parecía razonable —el comentario del provider
 * decía «estable, no caduca»— y es falso en cuanto el host cambia.
 *
 * Pasó de verdad: varias fotos quedaron apuntando a
 * `…trycloudflare.com`, el túnel efímero de una sesión de desarrollo de hacía
 * días. Las tarjetas de «Mi tienda» mostraban el recuadro gris. El archivo
 * estaba entero en el almacenamiento; lo que estaba muerto era el host
 * guardado al lado.
 *
 * Y no es un problema sólo de desarrollo. Toda foto subida durante la beta
 * queda apuntando al host de la beta: el día que el backend pase a
 * `api.vendox.com.ar`, todas esas fotos dejan de verse a la vez, sin que nada
 * falle ni avise.
 *
 * El `storageKey` sí es estable: identifica el objeto, no dónde vive el
 * servidor hoy. Derivar de él hace que las filas viejas se curen solas en
 * cuanto la configuración es correcta.
 *
 * ⚠️ La columna `url` sigue existiendo y se sigue escribiendo, como registro
 * de dónde se subió. Lo que NO hay que hacer es devolverla: para eso está esta
 * función. Ver el test de contrato que recorre las respuestas buscando hosts
 * ajenos.
 */
export function urlPublicaDe(storageKey: string): string {
  if (env.R2_PUBLIC_BASE_URL) {
    return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${storageKey}`;
  }
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${storageKey}`;
}

/**
 * La portada de un producto, ya resuelta. `null` si no tiene fotos.
 *
 * Existe porque `images[0]?.url ?? null` estaba escrito en doce lugares. El
 * propio `FEED_SELECT` ya advertía sobre esto: «con el bloque repetido, agregar
 * un campo en una y olvidarlo en la otra deja tarjetas promocionadas sin foto,
 * y el error se ve recién en producción».
 *
 * Recibe la lista completa y no la primera imagen para que el orden lo decida
 * la consulta —siempre `position: 'asc'`— y no cada quien por su cuenta.
 */
export function portadaDe(imagenes: readonly { storageKey: string }[]): string | null {
  const primera = imagenes[0];
  return primera ? urlPublicaDe(primera.storageKey) : null;
}

/**
 * Las filas de imagen, con `url` en lugar de `storageKey`.
 *
 * Varias consultas devuelven las filas de Prisma tal cual, sin pasar por un
 * mapeador. Como ahora seleccionan `storageKey` y no `url`, sin esto la app
 * recibiría la clave de almacenamiento —un dato interno— y ninguna URL.
 *
 * El `storageKey` se saca a propósito: es dónde está el archivo en el bucket, y
 * no le sirve de nada a la app.
 */
export function conUrls<T extends { storageKey: string }>(
  imagenes: readonly T[],
): Array<Omit<T, 'storageKey'> & { url: string }> {
  return imagenes.map(({ storageKey, ...resto }) => ({
    ...resto,
    url: urlPublicaDe(storageKey),
  }));
}
