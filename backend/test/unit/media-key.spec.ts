import { describe, expect, it } from 'vitest';

import { validarClave } from '@/shared/storage/media.controller';

/**
 * Validación de la clave que llega por `/media/<clave>`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE ESTÁ PREVINIENDO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Esa clave viene de la URL, o sea de quien pida. Y lo que se hace con ella es
 * **firmar una URL de R2**: una llave temporal que deja bajar ese objeto sin
 * autenticarse.
 *
 * Sin validar, `/media/../../otro/algo` conseguiría una firma para un objeto
 * que no le corresponde. Es el salto de directorio de toda la vida, con la
 * diferencia de que acá el que resuelve la ruta es Cloudflare y no nuestro
 * sistema de archivos, así que ninguna protección del sistema operativo ayuda.
 *
 * ─── Por qué una lista blanca de forma y no un saneador ───
 *
 * Sanear rutas es un juego que se pierde: `..%2f`, `....//`, codificaciones
 * dobles, separadores de Windows. Cada vez que se tapa un caso aparece otro.
 *
 * Las claves que genera el backend tienen una forma conocida y estrecha —
 * `products/<id>/<uuid>.<ext>`— así que se exige exactamente esa. Lo que no
 * encaje se rechaza sin intentar arreglarlo.
 */

const VALIDA = 'products/prd_01ABCDEF/4ca42b31-3aba-4f7d-b04f-22901f7da689.png';

describe('validarClave', () => {
  it('acepta las claves que genera el backend', () => {
    expect(validarClave(VALIDA)).toBe(VALIDA);

    for (const ext of ['jpg', 'png', 'webp']) {
      const clave = `products/prd_01X/4ca42b31-3aba-4f7d-b04f-22901f7da689.${ext}`;
      expect(validarClave(clave)).toBe(clave);
    }
  });

  it('tolera la barra inicial que agrega el enrutador', () => {
    expect(validarClave(`/${VALIDA}`)).toBe(VALIDA);
  });

  describe('⛔ rechaza los intentos de salir de products/', () => {
    const ataques = [
      '../../../etc/passwd',
      'products/../../../etc/passwd',
      'products/p1/../../../secreto.png',
      '....//....//secreto.png',
      'products/p1/..%2f..%2fsecreto.png',
      '/etc/passwd',
      'C:\\Windows\\System32\\config\\sam',
      'products\\p1\\abc.png',
      'otro-bucket/algo.png',
      'backups/base.sql',
    ];

    for (const ataque of ataques) {
      it(ataque, () => {
        expect(() => validarClave(ataque)).toThrowError();
      });
    }
  });

  describe('⛔ rechaza lo que no tiene la forma correcta', () => {
    const invalidas: Array<[string, string]> = [
      ['sin prefijo products', '4ca42b31-3aba-4f7d-b04f-22901f7da689.png'],
      ['sin uuid', 'products/p1/foto.png'],
      ['extensión no permitida', 'products/p1/4ca42b31-3aba-4f7d-b04f-22901f7da689.svg'],
      ['ejecutable disfrazado', 'products/p1/4ca42b31-3aba-4f7d-b04f-22901f7da689.php'],
      ['sin extensión', 'products/p1/4ca42b31-3aba-4f7d-b04f-22901f7da689'],
      ['nivel de más', 'products/p1/sub/4ca42b31-3aba-4f7d-b04f-22901f7da689.png'],
      ['vacía', ''],
      ['sólo el prefijo', 'products/'],
      ['id con caracteres raros', 'products/p1;rm -rf/4ca42b31-3aba-4f7d-b04f-22901f7da689.png'],
      ['salto de línea', 'products/p1/4ca42b31-3aba-4f7d-b04f-22901f7da689.png\n'],
      ['byte nulo', 'products/p1/4ca42b31-3aba-4f7d-b04f-22901f7da689.png\0'],
    ];

    for (const [nombre, clave] of invalidas) {
      it(nombre, () => {
        expect(() => validarClave(clave)).toThrowError();
      });
    }
  });

  it('el rechazo es siempre 404, sin decir por qué', () => {
    /**
     * Un mensaje distinto para "clave mal formada" y para "no existe" le
     * confirmaría a quien está probando cuándo acertó la forma — que es
     * exactamente la mitad del trabajo de encontrar un objeto ajeno.
     */
    for (const mala of ['../../etc/passwd', 'products/p1/foto.png', '']) {
      expect(() => validarClave(mala)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' }) as Error,
      );
    }
  });

  it('un id largo no pasa: la longitud también es parte de la forma', () => {
    // Sin tope, una clave de un megabyte llegaría hasta el firmador.
    const largo = 'a'.repeat(200);
    expect(() =>
      validarClave(`products/${largo}/4ca42b31-3aba-4f7d-b04f-22901f7da689.png`),
    ).toThrowError();
  });
});
