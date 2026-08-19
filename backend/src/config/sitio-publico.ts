import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Dónde están los archivos del sitio público.
 *
 * Dos ubicaciones posibles, y las dos son legítimas:
 *
 *   · `../web` — corriendo desde `backend/` en una máquina de desarrollo, con
 *     el repositorio completo alrededor.
 *   · `./web`  — dentro del contenedor, donde el Dockerfile copia sólo esa
 *     carpeta al lado de `dist`.
 *
 * Se devuelve `null` si no está ninguna, en vez de inventar una ruta. Un
 * `root` que no existe hace fallar el registro del plugin y con él todo el
 * arranque: la API entera caída porque falta una landing es un intercambio que
 * nadie haría.
 */
export function raizDelSitio(desde: string = process.cwd()): string | null {
  const candidatas = [resolve(desde, '..', 'web'), resolve(desde, 'web')];
  return candidatas.find((ruta) => existsSync(join(ruta, 'index.html'))) ?? null;
}

/**
 * Las páginas del sitio, por su ruta sin barra final ni `index.html`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTA LISTA SE DESCUBRE Y NO SE ESCRIBE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una lista a mano se olvida. La página que alguien agregue mañana va a
 * funcionar en `/pagina-nueva/` y dar 404 en `/pagina-nueva`, que es
 * exactamente el bug que esto viene a cerrar — sólo que descubierto meses
 * después, por alguien que escribió la URL sin la barra.
 *
 * Acá se leen los directorios que tienen `index.html`. Si existe la carpeta,
 * existe la ruta.
 *
 * ⚠️ La raíz NO está en esta lista: `/` ya lo sirve el plugin con su opción
 * `index`. Lo que le falta al plugin es la forma **sin** barra final de los
 * subdirectorios.
 */
export function paginasDelSitio(raiz: string): string[] {
  const encontradas: string[] = [];

  const recorrer = (directorio: string, prefijo: string): void => {
    for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
      if (!entrada.isDirectory()) continue;

      const ruta = `${prefijo}/${entrada.name}`;
      if (existsSync(join(directorio, entrada.name, 'index.html'))) encontradas.push(ruta);

      recorrer(join(directorio, entrada.name), ruta);
    }
  };

  recorrer(raiz, '');
  return encontradas.sort();
}
