import { describe, expect, it } from 'vitest';

import { hayClavePublica, renderCheckoutPage } from '@/modules/payments/checkout-page';

/**
 * El formulario de tarjeta cuando no hay con qué armarlo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG DE QA, Y CÓMO SE ENCONTRÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reportado: al iniciar una compra aparecía el modal «Datos de la tarjeta» con
 * **«Error interno del formulario»** y sin ninguna opción de pagar.
 *
 * Se pidió la página real a producción y el HTML traía esto:
 *
 *     new MercadoPago('', { locale: 'es-AR' })
 *
 * La clave pública venía vacía. El SDK de Mercado Pago no puede montar sus
 * iframes sin ella, tira, y el `catch` de la página muestra el mensaje
 * genérico. No era un fallo del formulario: nunca hubo formulario.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE ESTOS TESTS PUEDEN Y NO PUEDEN CUBRIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La causa es de configuración —falta `MP_PUBLIC_KEY` en el entorno— y desde
 * el código no se arregla. Lo que sí se arregla, y es lo que se prueba acá, es
 * que la página deje de pretender que funciona.
 *
 * ⚠️ Ningún test de este archivo toca Mercado Pago ni cobra nada.
 */
describe('Cuándo se puede mostrar el formulario', () => {
  it('con una clave, sí', () => {
    expect(hayClavePublica('APP_USR-algo')).toBe(true);
  });

  /// ⛔ EL CASO DEL BUG.
  it('⛔ con la clave vacía, no', () => {
    expect(hayClavePublica('')).toBe(false);
  });

  /// Una variable de entorno mal puesta suele quedar con espacios.
  it('⛔ con espacios en blanco, tampoco', () => {
    expect(hayClavePublica('   ')).toBe(false);
  });
});

describe('La página sin clave pública', () => {
  const sinClave = () =>
    renderCheckoutPage({
      publicKey: '',
      orderId: 'ord_1',
      amount: 1500,
      buyerEmail: 'ana@test.com',
      description: 'Campera',
    });

  /**
   * ⛔ NO SE DIBUJA UN FORMULARIO QUE NO PUEDE ANDAR.
   *
   * Es todo el arreglo: sin esto, la persona queda frente a un formulario roto
   * con un mensaje que no explica nada y sin salida.
   */
  it('⛔ no monta el SDK de Mercado Pago', () => {
    const html = sinClave();

    expect(html).not.toContain('new MercadoPago');
    expect(html).not.toContain('form-checkout__cardNumber');
    expect(html).not.toContain('Error interno del formulario');
  });

  /// ⛔ Y dice algo que se puede leer.
  ///
  /// Lo que más importa de este texto: que el pedido NO se cobró. Una pantalla
  /// de error en un checkout deja a cualquiera preguntándose si le sacaron la
  /// plata.
  it('⛔ explica qué pasó y que no se cobró nada', () => {
    const html = sinClave();

    expect(html).toContain('No podemos cobrar con tarjeta ahora');
    expect(html).toContain('no se cobró');
  });

  /**
   * ⛔ Y NO cuenta cómo está armado el sistema.
   *
   * Quien lee esto quería comprar algo. El nombre de una variable de entorno
   * no le sirve para nada, y de paso le regala a cualquiera un detalle de la
   * configuración. Eso va al log del servidor.
   */
  it('⛔ no nombra la variable de entorno que falta', () => {
    const html = sinClave();

    expect(html).not.toContain('MP_PUBLIC_KEY');
    expect(html).not.toContain('env');
  });
});

describe('La página con clave pública', () => {
  const conClave = () =>
    renderCheckoutPage({
      publicKey: 'APP_USR-clave-de-prueba',
      orderId: 'ord_1',
      amount: 1500,
      buyerEmail: 'ana@test.com',
      description: 'Campera',
    });

  /// Con clave sí se arma el formulario. Es la otra mitad del test de arriba:
  /// sin esto, romper el renderizado entero pasaría desapercibido.
  it('monta el CardForm', () => {
    const html = conClave();

    expect(html).toContain('new MercadoPago');
    expect(html).toContain('form-checkout__cardNumber');
  });

  /**
   * ⛔ Los campos sensibles siguen siendo iframes de Mercado Pago.
   *
   * Es lo que mantiene el alcance PCI en SAQ-A. Si algún día alguien los
   * reemplaza por `<input>` propios, el número de tarjeta empieza a pasar por
   * nuestro DOM y el sistema entra en SAQ-D.
   */
  it('⛔ el número y el código de seguridad los monta Mercado Pago', () => {
    const html = conClave();

    expect(html).toContain('iframe: true');
    expect(html).not.toMatch(/<input[^>]*cardNumber/i);
    expect(html).not.toMatch(/<input[^>]*securityCode/i);
  });
});
