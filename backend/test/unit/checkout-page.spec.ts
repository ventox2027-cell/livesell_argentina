import { describe, expect, it } from 'vitest';

import { renderCheckoutPage } from '../../src/modules/payments/checkout-page';

const BASE = {
  publicKey: 'TEST-public-key-123',
  orderId: 'ord_01ABC',
  amount: 15499,
  buyerEmail: 'comprador@test.com',
  description: 'Remera oversize',
};

describe('página de checkout', () => {
  const html = renderCheckoutPage(BASE);

  it('inyecta la public key y el monto', () => {
    expect(html).toContain("new MercadoPago('TEST-public-key-123'");
    expect(html).toContain('15499.00');
    expect(html).toContain('comprador@test.com');
  });

  it('⛔ mantiene el alcance PCI en SAQ-A: los campos sensibles son iframes de Mercado Pago', () => {
    // Ésta es LA prueba de este archivo. `iframe: true` hace que el número de
    // tarjeta y el código de seguridad vivan en iframes servidos por Mercado
    // Pago, fuera de nuestro DOM.
    //
    // Si alguien lo saca "para que se vea mejor", los campos pasan a ser
    // nuestros, el PAN entra en nuestro alcance y el proyecto salta de SAQ-A a
    // SAQ-D: auditoría anual, escaneos trimestrales y segmentación de red.
    expect(html).toContain('iframe: true');
  });

  it('⛔ no declara ningún input propio para datos de tarjeta', () => {
    // Los contenedores de Mercado Pago son <div>. Un <input> con estos ids
    // significaría que el dato pasa por nosotros.
    for (const campo of ['cardNumber', 'securityCode', 'expirationDate']) {
      const inputPropio = new RegExp(`<input[^>]*id="form-checkout__${campo}"`, 'i');
      expect(html).not.toMatch(inputPropio);
      expect(html).toContain(`<div id="form-checkout__${campo}"`);
    }
  });

  it('⛔ escapa lo que viene de la query string', () => {
    // El monto y la descripción llegan por URL. Sin escapar, cualquiera arma
    // un enlace que inyecta script en una página que muestra un formulario de
    // pago, que es el peor lugar posible para un XSS.
    const conAtaque = renderCheckoutPage({
      ...BASE,
      description: '<script>alert(1)</script>',
      buyerEmail: '"><script>robar()</script>',
      orderId: "'; window.MpBridge.postMessage('robado'); //",
    });

    expect(conAtaque).not.toContain('<script>alert(1)</script>');
    expect(conAtaque).not.toContain('<script>robar()</script>');
    expect(conAtaque).toContain('&lt;script&gt;');
    expect(conAtaque).not.toContain("'; window.MpBridge");
  });

  it('⛔ lee el formulario por la instancia guardada, no por `this`', () => {
    // Costó una prueba de campo entera: dentro de los callbacks del SDK, `this`
    // no es el cardForm. `this.getCardFormData()` lanza un TypeError que muere
    // adentro del SDK, el botón queda en "Procesando…" para siempre y no llega
    // ni un pedido al backend. Sin ningún mensaje de error.
    // Se comprueba la ASIGNACIÓN, no la mención: el comentario del código
    // nombra la llamada incorrecta a propósito, para que quede explicado.
    expect(html).toContain('datos = cardForm.getCardFormData()');
    expect(html).not.toMatch(/=\s*this\.getCardFormData\(\)/);
  });

  it('reporta a la app cualquier error de JavaScript', () => {
    // La contramedida general contra fallos silenciosos en el WebView.
    expect(html).toContain('window.onerror');
    expect(html).toContain("motivo: 'js_error'");
  });

  it('muestra el monto en formato argentino', () => {
    // "$ 15499.00" se lee como precio de otro país. En una pantalla de pago,
    // cualquier cosa que genere desconfianza cuesta ventas.
    expect(html).toMatch(/15\.499,00/);
    // Pero al SDK se le pasa el formato que espera: punto decimal, sin miles.
    expect(html).toContain("amount: '15499.00'");
  });

  it('un monto no numérico no rompe la página', () => {
    const html = renderCheckoutPage({ ...BASE, amount: Number.NaN });
    expect(html).toContain('0.00');
  });

  it('el mensaje hacia la app lleva el token y nada sensible', () => {
    expect(html).toContain('window.MpBridge.postMessage');

    // Se inspecciona el CONTENIDO del mensaje, no el archivo entero:
    // `cardNumber` aparece de forma legítima en la config del CardForm, donde
    // sólo nombra el div contenedor del iframe.
    const envio = /avisarApp\(\{\s*\n\s*tipo:\s*'token'[\s\S]*?\}\);/.exec(html);
    expect(envio, 'no se encontró el envío del token').not.toBeNull();

    const cuerpo = envio![0];
    for (const prohibido of [
      'cardNumber',
      'securityCode',
      'expirationDate',
      'cardholderName',
      'identificationNumber',
    ]) {
      expect(cuerpo, `el mensaje no puede incluir ${prohibido}`).not.toContain(prohibido);
    }
    expect(cuerpo).toContain('token:');
  });
});
