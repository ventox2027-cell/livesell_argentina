import { describe, expect, it } from 'vitest';

import { textoDeVuelta } from '@/modules/orders/vuelta-del-pago.controller';

/**
 * La página a la que vuelve alguien después de pagar en Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CASI NUNCA SE VE, Y TIENE QUE ESTAR BIEN IGUAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vendox.com.ar` es un App Link verificado sin prefijo de ruta: cuando Mercado
 * Pago redirige acá, Android abre VendoX y esta página no se dibuja.
 *
 * Se dibuja en los bordes —se pagó desde una computadora, se desinstaló la app,
 * la verificación del App Link falló— y ahí lo que no puede pasar es una
 * pantalla en blanco justo después de haber pagado.
 *
 * ⚠️ Ningún test de este archivo habla con Mercado Pago ni cobra nada.
 */
describe('Qué se le dice a alguien que vuelve de pagar', () => {
  it('aprobado: dice que pagó', () => {
    expect(textoDeVuelta('aprobado').titulo).toBe('Listo, pagaste');
  });

  /**
   * ⛔ PENDIENTE NO ES PAGADO, Y NO ES FALLADO.
   *
   * Un pago pendiente se acredita más tarde. Decir «listo» sería mentir, y
   * decir «falló» haría que alguien pague dos veces.
   */
  it('⛔ pendiente no dice ni que pagó ni que falló', () => {
    const { titulo, detalle } = textoDeVuelta('pendiente');

    expect(titulo).toContain('en camino');
    expect(detalle).not.toContain('no se te cobró');
    expect(titulo).not.toContain('Listo');
  });

  /**
   * ⛔ RECHAZADO TIENE QUE DECIR QUE NO SE COBRÓ NADA.
   *
   * Es lo primero que se pregunta cualquiera al ver un error en un checkout.
   * Sin esa frase, la persona no sabe si tiene que revisar su resumen.
   */
  it('⛔ rechazado aclara que no se cobró nada', () => {
    const { titulo, detalle } = textoDeVuelta('rechazado');

    expect(titulo).toContain('no se hizo');
    expect(detalle).toContain('No se te cobró nada');
  });

  /**
   * ⛔ SIN ESTADO NO SE INVENTA NINGUNO.
   *
   * Pasa cuando alguien toca «Volver» antes de terminar. No sabemos qué pasó, y
   * las dos afirmaciones —«pagaste» y «falló»— son peores que admitirlo.
   */
  it('⛔ sin estado, no afirma nada sobre el pago', () => {
    const { titulo, detalle } = textoDeVuelta(undefined);

    expect(titulo).not.toContain('pagaste');
    expect(titulo).not.toContain('no se hizo');
    expect(detalle).toContain('Abrí la app');
  });

  /**
   * ⛔ Y un estado inventado se trata como «no sé».
   *
   * El estado viene en la URL y lo puede escribir cualquiera. Un `?estado=x`
   * desconocido no puede caer por accidente en la rama de «pagaste».
   */
  it('⛔ un estado desconocido no se toma por bueno', () => {
    expect(textoDeVuelta('aprobadísimo').titulo).toBe(textoDeVuelta(undefined).titulo);
    expect(textoDeVuelta('').titulo).toBe(textoDeVuelta(undefined).titulo);
  });
});
