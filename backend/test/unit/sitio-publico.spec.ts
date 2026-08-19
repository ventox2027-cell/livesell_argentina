import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * El sitio de vendox.com.ar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SON ARCHIVOS, ASÍ QUE SE LEEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Estas páginas no tienen lógica: son HTML que un navegador abre tal cual. Lo
 * único que se puede romper en silencio es que dejen de estar donde el servidor
 * las busca, o que un enlace apunte a una ruta que no existe.
 *
 * Las dos cosas se descubrirían recién cuando alguien entre — o peor, cuando un
 * revisor de Google Play abra la política de privacidad y reciba un 404.
 */
const RAIZ = join(process.cwd(), 'web');

/** Las páginas que tienen que existir, y por qué cada una. */
const PAGINAS = [
  { ruta: 'index.html', que: 'la portada' },
  { ruta: 'descargar/index.html', que: 'de dónde se baja la app' },
  { ruta: 'soporte/index.html', que: 'cómo pedir ayuda' },
  // Estas dos las exige Google Play y las verifica abriendo la URL.
  { ruta: 'privacidad/index.html', que: 'la política de privacidad (Play la exige)' },
  { ruta: 'eliminar-cuenta/index.html', que: 'la eliminación de cuenta (Play la exige)' },
];

describe('Las páginas del sitio están donde el servidor las busca', () => {
  for (const { ruta, que } of PAGINAS) {
    it(`existe ${ruta} — ${que}`, () => {
      expect(existsSync(join(RAIZ, ruta))).toBe(true);
    });
  }

  /**
   * ⛔ `web/` vive DENTRO de `backend/`, y no es cosmético.
   *
   * El contexto de construcción de la imagen es `backend/`. Un `COPY ../web` no
   * existe en Docker: lo que está fuera del contexto no se puede copiar. Con la
   * carpeta en la raíz del repositorio, la imagen se construye igual y el sitio
   * devuelve 404 en producción sin que nada falle.
   */
  it('⛔ el Dockerfile copia el sitio a la imagen', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/COPY .*web \.\/web/);
  });
});

describe('Los enlaces internos apuntan a rutas que existen', () => {
  /**
   * Un enlace roto en el pie de página no falla en ningún lado: simplemente
   * lleva a un 404. Y el pie está en las cinco páginas, así que un error se
   * multiplica por cinco.
   */
  const RUTAS_SERVIDAS = new Set([
    '/',
    '/descargar',
    '/soporte',
    '/privacidad',
    '/eliminar-cuenta',
    // Las sirve el backend, no los archivos.
    '/descargar/android',
    '/descargar/android.json',
    '/_estilo.css',
  ]);

  for (const { ruta } of PAGINAS) {
    it(`todos los enlaces de ${ruta} van a algún lado`, () => {
      const html = readFileSync(join(RAIZ, ruta), 'utf8');

      const internos = [...html.matchAll(/href="(\/[^"#]*)"/g)]
        .map((m) => m[1]!)
        // Sin la barra final: `/descargar/` y `/descargar` son lo mismo.
        .map((h) => (h.length > 1 && h.endsWith('/') ? h.slice(0, -1) : h));

      for (const enlace of internos) {
        expect(RUTAS_SERVIDAS.has(enlace), `${ruta} enlaza a ${enlace}, que no se sirve`).toBe(
          true,
        );
      }
    });
  }
});

describe('La portada dice lo que tiene que decir', () => {
  const portada = readFileSync(join(RAIZ, 'index.html'), 'utf8');

  it('lleva el lema de la marca', () => {
    expect(portada).toContain('Comprar se vive.');
    expect(portada).toContain('Vender también.');
    expect(portada).toContain('Comprá y vendé en vivo.');
  });

  /**
   * ⛔ EL BOTÓN NO PUEDE APUNTAR A UN ARTEFACTO DE GITHUB.
   *
   * Vencen a los catorce días y su URL cambia en cada corrida. Un botón así
   * funciona dos semanas y después devuelve 404 — y quien lo toca no tiene
   * forma de saber que el roto es el botón.
   */
  it('⛔ el botón de descarga usa la URL estable', () => {
    expect(portada).toContain('href="/descargar/android"');
    expect(portada).not.toContain('github.com');
    expect(portada).not.toContain('actions/runs');
  });

  it('el botón dice lo que hace', () => {
    expect(portada).toContain('Descargar VendoX para Android');
  });
});

describe('Todas las páginas comparten la identidad', () => {
  for (const { ruta } of PAGINAS) {
    const html = readFileSync(join(RAIZ, ruta), 'utf8');

    it(`${ruta} declara el idioma y el ancho del teléfono`, () => {
      expect(html).toContain('lang="es-AR"');
      expect(html).toContain('width=device-width');
    });

    /**
     * El fondo del `body` se pinta SIEMPRE, con un color propio.
     *
     * Un `body` transparente toma el del navegador, y la página termina
     * mostrando el texto de un tema sobre el fondo del otro. Es el error
     * clásico de las páginas que sólo definen colores dentro de la consulta de
     * tema oscuro.
     */
    it(`${ruta} define su propio fondo`, () => {
      const tieneEstiloPropio = html.includes('background: var(--fondo)');
      const usaElCompartido = html.includes('_estilo.css');

      expect(tieneEstiloPropio || usaElCompartido).toBe(true);
    });
  }
});
