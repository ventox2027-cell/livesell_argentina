import { describe, expect, it } from 'vitest';

import { escapar, paginaDeLanding, paginaNoEncontrada, recortar } from '@/modules/landing/pagina';

/**
 * La página de un enlace compartido.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODO LO QUE ENTRA ACÁ LO ESCRIBIÓ UN VENDEDOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El nombre de un producto, su descripción, el nombre de una tienda: texto
 * libre que carga cualquiera que abra una cuenta.
 *
 * Un producto llamado `</title><script>…</script>` en una página armada con
 * concatenación es un XSS servido desde nuestro dominio. Y como estas páginas
 * están hechas para compartirse, el ataque llega solo a donde quiera ir.
 */

const BASE = {
  titulo: 'Zapatillas',
  descripcion: 'Muy lindas',
  imagen: null,
  url: 'https://vendox.com.ar/p/prd_1',
  rutaEnLaApp: '/producto/prd_1',
};

describe('Escapado', () => {
  it('⛔ el ampersand se escapa PRIMERO', () => {
    /**
     * El orden importa y es la parte que se equivoca sola.
     *
     * Si `&` se escapara al final, escaparía las entidades que acaban de
     * generar los otros reemplazos: `<` se convierte en `&lt;` y después ese
     * `&` se vuelve `&amp;`, dando `&amp;lt;` — que en pantalla se lee
     * literalmente «&lt;» en vez de «<».
     */
    expect(escapar('a & b')).toBe('a &amp; b');
    expect(escapar('<b>')).toBe('&lt;b&gt;');
    expect(escapar('& <')).toBe('&amp; &lt;');
  });

  it('⛔ las comillas también, que es lo que se olvida', () => {
    // En el cuerpo del documento parecen inofensivas. Dentro de
    // `content="…"` de un `<meta>` cierran el atributo.
    expect(escapar('dice "hola"')).toBe('dice &quot;hola&quot;');
    expect(escapar("l'agent")).toBe('l&#39;agent');
  });
});

describe('La página', () => {
  it('⛔ un nombre de producto con HTML no puede romper la página', () => {
    const html = paginaDeLanding({
      ...BASE,
      titulo: '</title><script>alert(1)</script>',
    });

    // Ni una sola etiqueta script viva.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</title><script>');
    // Y el texto sí está, escapado.
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
  });

  it('⛔ tampoco puede escaparse de un atributo de meta', () => {
    /**
     * El vector menos evidente: el título va dentro de
     * `content="…"`. Con una comilla sin escapar, se cierra el atributo y lo
     * que sigue se interpreta como más atributos de la etiqueta.
     */
    const html = paginaDeLanding({
      ...BASE,
      titulo: 'x" onload="alert(1)',
    });

    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot; onload=&quot;');
  });

  it('⛔ la descripción tampoco', () => {
    const html = paginaDeLanding({
      ...BASE,
      descripcion: '<img src=x onerror=alert(1)>',
    });

    expect(html).not.toContain('<img src=x');
  });

  it('⛔ ni la URL de la imagen, que también viene de afuera', () => {
    // La URL sale del almacenamiento, pero pasa por la base y la base la
    // escribió una petición.
    const html = paginaDeLanding({
      ...BASE,
      imagen: 'https://x/y.jpg" onerror="alert(1)',
    });

    expect(html).not.toContain('onerror="alert(1)"');
  });

  it('lleva las etiquetas que arman la previsualización', () => {
    // Es lo que hace útil a un enlace compartido: la foto y el precio
    // apareciendo en el chat antes de que nadie toque nada.
    const html = paginaDeLanding({
      ...BASE,
      imagen: 'https://cdn.vendox.com.ar/p.jpg',
      precio: '$ 12.500',
    });

    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('property="og:url"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('sin imagen, la tarjeta es chica y no promete una foto que no hay', () => {
    const html = paginaDeLanding(BASE);
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).not.toContain('og:image');
  });

  it('⛔ el deep link apunta al paquete definitivo', () => {
    const html = paginaDeLanding(BASE);
    expect(html).toContain('com.vendox.app');
    expect(html).not.toContain('livesell');
  });

  it('la descripción se recorta antes de que la corten mal', () => {
    // Los previsualizadores cortan alrededor de los 160 caracteres y lo hacen
    // a mitad de palabra.
    const largo = 'palabra '.repeat(60);
    expect(recortar(largo).length).toBeLessThanOrEqual(156);
    expect(recortar(largo)).toMatch(/…$/);
    // Y no corta en el medio de una palabra.
    expect(recortar(largo)).not.toMatch(/pala…$/);
  });

  it('un texto corto no se toca', () => {
    expect(recortar('Zapatillas negras')).toBe('Zapatillas negras');
  });
});

describe('Cuando ya no está', () => {
  it('⛔ no dice POR QUÉ no está', () => {
    /**
     * «Este producto fue despublicado» filtra una decisión del vendedor —o una
     * sanción nuestra— a cualquiera que tenga el enlace.
     */
    const html = paginaNoEncontrada('https://vendox.com.ar/p/prd_1');

    expect(html).toContain('ya no está disponible');
    for (const filtracion of ['despublicado', 'suspendido', 'oculto', 'moderación', 'borrado']) {
      expect(html.toLowerCase()).not.toContain(filtracion);
    }
  });

  it('sigue siendo una página, no un error del servidor', () => {
    // Un enlace compartido sobrevive a lo que enlaza. Que un enlace viejo
    // muestre una pantalla rota es un final peor que el que ya tiene.
    const html = paginaNoEncontrada('https://vendox.com.ar/p/prd_1');
    expect(html).toContain('VendoX');
    expect(html).toContain('<!doctype html>');
  });
});
