/**
 * Página de tokenización de tarjeta.
 *
 * ─── Por qué existe esta página y no un formulario en Flutter ───
 *
 * Es la respuesta al riesgo R1 del proyecto. Si el número de tarjeta pasara por
 * campos nuestros —un `TextField` de Flutter, o inputs en nuestro HTML— el
 * sistema entero entraría en alcance **PCI DSS SAQ-D**: auditoría anual,
 * escaneos trimestrales, segmentación de red. Para un equipo de esta escala,
 * eso no es caro: es inviable.
 *
 * Con `iframe: true`, los campos sensibles son iframes servidos por Mercado
 * Pago. El número de tarjeta y el código de seguridad **nunca tocan nuestro
 * DOM, nuestro JavaScript ni nuestro servidor**. Lo único que cruza de vuelta
 * es un token de un solo uso. Eso deja el alcance en **SAQ-A**, que es un
 * cuestionario y nada más.
 *
 * No es una optimización. Es la diferencia entre poder cobrar y no poder.
 *
 * ─── El monto que se muestra NO es el que se cobra ───
 *
 * `amount` llega por query string y sirve sólo para que la persona vea qué
 * está pagando. El cobro usa `order.amountCents` leído de la base en
 * `payOrder()`. Manipular la URL cambia lo que se muestra y nada más.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CheckoutPageParams {
  publicKey: string;
  orderId: string;
  /** Sólo para mostrar. En unidades de moneda, no centavos. */
  amount: number;
  buyerEmail: string;
  description: string;
}

export function renderCheckoutPage(p: CheckoutPageParams): string {
  // Todo lo que viene de afuera se escapa antes de entrar al HTML.
  const orderId = escapeHtml(p.orderId);
  const email = escapeHtml(p.buyerEmail);
  const description = escapeHtml(p.description);
  const publicKey = escapeHtml(p.publicKey);
  const amount = Number.isFinite(p.amount) ? p.amount.toFixed(2) : '0.00';

  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Pagar</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #16181d;
  }
  .resumen {
    background: #fff; border-radius: 14px; padding: 16px 18px; margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  .resumen .desc { font-size: 15px; color: #555; }
  .resumen .monto { font-size: 30px; font-weight: 700; margin-top: 4px; letter-spacing: -.5px; }
  form { background: #fff; border-radius: 14px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  label { display: block; font-size: 12px; font-weight: 600; color: #666; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
  label:first-of-type { margin-top: 0; }
  /* Con iframe:true, Mercado Pago monta un iframe dentro de estos contenedores.
     La altura fija evita el salto de layout al montarse. */
  .campo-mp { height: 42px; border: 1px solid #d5d7dd; border-radius: 9px; padding: 0 10px; background: #fff; }
  select, input {
    width: 100%; height: 42px; border: 1px solid #d5d7dd; border-radius: 9px;
    padding: 0 10px; font-size: 16px; background: #fff; color: #16181d;
  }
  .fila { display: flex; gap: 12px; }
  .fila > div { flex: 1; }
  button {
    width: 100%; height: 50px; margin-top: 20px; border: 0; border-radius: 11px;
    background: #009ee3; color: #fff; font-size: 17px; font-weight: 600;
  }
  button:disabled { background: #b9c0ca; }
  .estado { margin-top: 14px; font-size: 14px; min-height: 20px; text-align: center; }
  .estado.error { color: #c22929; }
  .pie { margin-top: 16px; font-size: 12px; color: #7a7f8a; text-align: center; line-height: 1.5; }
</style>
</head>
<body>

<div class="resumen">
  <div class="desc">${description}</div>
  <div class="monto">$ ${amount}</div>
</div>

<form id="form-checkout">
  <label>Número de tarjeta</label>
  <div id="form-checkout__cardNumber" class="campo-mp"></div>

  <div class="fila">
    <div>
      <label>Vencimiento</label>
      <div id="form-checkout__expirationDate" class="campo-mp"></div>
    </div>
    <div>
      <label>Código</label>
      <div id="form-checkout__securityCode" class="campo-mp"></div>
    </div>
  </div>

  <label>Titular, como figura en la tarjeta</label>
  <input type="text" id="form-checkout__cardholderName" autocomplete="cc-name">

  <div class="fila">
    <div>
      <label>Documento</label>
      <select id="form-checkout__identificationType"></select>
    </div>
    <div>
      <label>Número</label>
      <input type="text" id="form-checkout__identificationNumber" inputmode="numeric">
    </div>
  </div>

  <label>Banco emisor</label>
  <select id="form-checkout__issuer"></select>

  <label>Cuotas</label>
  <select id="form-checkout__installments"></select>

  <input type="hidden" id="form-checkout__cardholderEmail" value="${email}">

  <button type="submit" id="boton-pagar" disabled>Cargando…</button>
  <div class="estado" id="estado"></div>
</form>

<div class="pie">
  Los datos de tu tarjeta viajan directo a Mercado Pago.<br>
  Esta aplicación no los recibe ni los guarda.
</div>

<script src="https://sdk.mercadopago.com/js/v2"></script>
<script>
(function () {
  var boton = document.getElementById('boton-pagar');
  var estado = document.getElementById('estado');

  function mostrar(texto, esError) {
    estado.textContent = texto;
    estado.className = esError ? 'estado error' : 'estado';
  }

  /**
   * Único canal de salida hacia la app.
   *
   * Lo que se manda es el TOKEN, nunca los datos de la tarjeta: el token es de
   * un solo uso y no sirve para nada fuera de este cobro.
   */
  function avisarApp(mensaje) {
    if (window.MpBridge && window.MpBridge.postMessage) {
      window.MpBridge.postMessage(JSON.stringify(mensaje));
    }
  }

  if (typeof MercadoPago === 'undefined') {
    mostrar('No se pudo cargar Mercado Pago. Revisá la conexión.', true);
    avisarApp({ tipo: 'error', motivo: 'sdk_no_cargo' });
    return;
  }

  var mp = new MercadoPago('${publicKey}', { locale: 'es-AR' });

  mp.cardForm({
    amount: '${amount}',
    // iframe: true es LA línea que mantiene el alcance PCI en SAQ-A.
    // Sin ella, los campos serían inputs nuestros y el número de tarjeta
    // pasaría por nuestro JavaScript.
    iframe: true,
    form: {
      id: 'form-checkout',
      cardNumber: { id: 'form-checkout__cardNumber', placeholder: '0000 0000 0000 0000' },
      expirationDate: { id: 'form-checkout__expirationDate', placeholder: 'MM/AA' },
      securityCode: { id: 'form-checkout__securityCode', placeholder: '123' },
      cardholderName: { id: 'form-checkout__cardholderName', placeholder: 'Como figura en la tarjeta' },
      issuer: { id: 'form-checkout__issuer' },
      installments: { id: 'form-checkout__installments' },
      identificationType: { id: 'form-checkout__identificationType' },
      identificationNumber: { id: 'form-checkout__identificationNumber', placeholder: '12345678' },
      cardholderEmail: { id: 'form-checkout__cardholderEmail' }
    },
    callbacks: {
      onFormMounted: function (error) {
        if (error) {
          mostrar('No se pudo preparar el formulario.', true);
          avisarApp({ tipo: 'error', motivo: 'form_no_monto', detalle: String(error) });
          return;
        }
        boton.disabled = false;
        boton.textContent = 'Pagar $ ${amount}';
        avisarApp({ tipo: 'listo' });
      },

      onSubmit: function (event) {
        event.preventDefault();
        boton.disabled = true;
        boton.textContent = 'Procesando…';
        mostrar('');

        var datos = this.getCardFormData();

        if (!datos.token) {
          boton.disabled = false;
          boton.textContent = 'Pagar $ ${amount}';
          mostrar('Revisá los datos de la tarjeta.', true);
          return;
        }

        // A partir de acá la app toma el control: llama al backend, que es el
        // único que puede cobrar. La página no sabe nada del resultado.
        avisarApp({
          tipo: 'token',
          orderId: '${orderId}',
          token: datos.token,
          paymentMethodId: datos.paymentMethodId,
          issuerId: datos.issuerId,
          installments: Number(datos.installments || 1)
        });
      },

      onError: function (errores) {
        boton.disabled = false;
        boton.textContent = 'Pagar $ ${amount}';
        var texto = (errores && errores.length && errores[0].message)
          ? errores[0].message
          : 'No se pudo validar la tarjeta.';
        mostrar(texto, true);
      }
    }
  });
})();
</script>
</body>
</html>`;
}
