import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { paginasDelSitio, raizDelSitio } from '@/config/sitio-publico';
import { crearAdaptador, registrarSitioPublico } from '@/http-setup';

/**
 * Las páginas del sitio, pedidas por HTTP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ESTO CIERRA, Y POR QUÉ NINGÚN TEST LO VIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En producción, al mismo tiempo:
 *
 *     GET https://api.vendox.com.ar/eliminar-cuenta/index.html  →  200
 *     GET https://api.vendox.com.ar/eliminar-cuenta             →  404
 *
 * Es una URL que Google Play abre para revisar la app.
 *
 * `sitio-publico.spec.ts` —el test que ya existía— comprobaba que los archivos
 * estuvieran en el disco. Estaban. La pregunta no era ésa: era si el servidor
 * los sirve en la URL que la gente escribe, y eso sólo se puede contestar
 * pidiéndosela a un servidor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE TEST NO NECESITA BASE DE DATOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque `registrarSitioPublico` ya no vive en `main.ts`. Toma una instancia
 * de Fastify y nada más, así que acá se levanta una con las MISMAS opciones de
 * producción —`crearAdaptador()`— y se le inyectan peticiones.
 *
 * Que el sitio conviva con las rutas de Nest lo cubren los tests de
 * integración, que desde ahora también lo montan.
 */
describe('El sitio público contesta en las URLs que la gente escribe', () => {
  let servidor: FastifyInstance;

  beforeAll(async () => {
    servidor = crearAdaptador().getInstance();

    await registrarSitioPublico(servidor);

    /**
     * Las rutas de la aplicación se registran DESPUÉS del sitio.
     *
     * Ese orden no es un detalle del test: es el de `main.ts`, donde el
     * estático se monta antes de `app.init()` y Nest agrega las suyas ahí. Un
     * test que las registrara primero probaría un servidor que no existe.
     *
     * `/p/:id` es la previsualización que lee el robot de WhatsApp. Se imita
     * acá para no arrastrar Nest ni la base.
     */
    servidor.get('/p/:id', (peticion) => ({
      soy: 'nest',
      id: (peticion.params as { id: string }).id,
    }));
    servidor.get('/api/v1/categories', () => ({ soy: 'nest' }));

    /**
     * El 404 de la aplicación, en el formato que la app sabe leer.
     *
     * En producción lo arma el filtro de excepciones de Nest. Acá se imita
     * porque es lo que distingue de verdad `wildcard: false`: con el comodín
     * encendido, el estático se queda con TODA ruta que no exista y contesta su
     * propio 404 — y el teléfono, que espera `{ error: { code } }`, recibe otra
     * cosa.
     */
    servidor.setNotFoundHandler(async (_peticion, respuesta) =>
      respuesta.code(404).send({ error: { code: 'NOT_FOUND' } }),
    );

    await servidor.ready();
  });

  afterAll(async () => {
    await servidor.close();
  });

  const paginas = paginasDelSitio(raizDelSitio()!);

  /// Que la lista se descubra sola no sirve si descubre cero.
  it('encuentra las páginas del sitio', () => {
    expect(paginas).toEqual(['/descargar', '/eliminar-cuenta', '/privacidad', '/soporte']);
  });

  it('sirve la portada', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('VendoX');
  });

  describe.each(paginas)('%s', (pagina) => {
    /**
     * ⛔ EL TEST DEL BUG.
     *
     * Sin barra final. Es la forma que alguien escribe a mano, la que se pega
     * en un formulario de Google Play, y la única que estaba rota.
     */
    it(`⛔ ${pagina} contesta sin barra final`, async () => {
      const res = await servidor.inject({ method: 'GET', url: pagina });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<!doctype html>');
    });

    it(`${pagina}/ contesta con barra final`, async () => {
      const res = await servidor.inject({ method: 'GET', url: `${pagina}/` });

      expect(res.statusCode).toBe(200);
    });

    it(`${pagina}/index.html sigue contestando`, async () => {
      const res = await servidor.inject({ method: 'GET', url: `${pagina}/index.html` });

      expect(res.statusCode).toBe(200);
    });

    /**
     * ⛔ Y LAS TRES FORMAS DEVUELVEN LA MISMA PÁGINA.
     *
     * Un 200 no alcanza: una ruta explícita mal armada podría contestar la
     * portada para todo y este test pasaría igual con el sitio roto.
     */
    it(`⛔ ${pagina} y ${pagina}/index.html devuelven lo mismo`, async () => {
      const [sinBarra, explicito] = await Promise.all([
        servidor.inject({ method: 'GET', url: pagina }),
        servidor.inject({ method: 'GET', url: `${pagina}/index.html` }),
      ]);

      expect(sinBarra.body).toBe(explicito.body);
    });
  });

  /**
   * ⛔ NADA DE ESTO PUEDE TAPAR LAS RUTAS DE LA API.
   *
   * `/p/:id` es la previsualización que lee el robot de WhatsApp: las etiquetas
   * `og:` tienen que venir escritas en el HTML que responde el servidor.
   */
  it('⛔ una ruta con parámetro sigue llegando a la aplicación', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/p/abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ soy: 'nest', id: 'abc123' });
  });

  it('⛔ las rutas de la API siguen llegando', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/api/v1/categories' });

    expect(res.statusCode).toBe(200);
  });

  /**
   * ⛔ EL 404 SIGUE SIENDO EL DE LA APLICACIÓN.
   *
   * El teléfono espera `{ error: { code } }` y decide con el código. Un 404 en
   * otro formato no se ve como un error: se ve como un mensaje genérico donde
   * tenía que haber uno del dominio.
   */
  it('⛔ lo que no existe lo contesta la aplicación, no el estático', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/api/v1/no-existe' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  it('⛔ una página inventada tampoco la sirve el estático', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/no-existe-esta-pagina' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  /// El HTML se revalida seguido: es lo que hace que una corrección se vea.
  it('el HTML no se cachea por mucho tiempo', async () => {
    const res = await servidor.inject({ method: 'GET', url: '/privacidad' });

    expect(res.headers['cache-control']).toContain('max-age=600');
  });
});
