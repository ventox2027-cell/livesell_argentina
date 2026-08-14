import { describe, expect, it } from 'vitest';

import {
  enmascararEmail,
  enmascararTelefono,
  verAuditoria,
  verDevolucion,
  verIntentoDePago,
  verOrden,
  verProducto,
  verUsuario,
  verVendedor,
  verWebhook,
} from '@/modules/admin/admin.view';

/**
 * Nada sensible sale del panel de administración.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE TEST EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque el modo en que esto se rompe no es escribiendo mal una función de
 * vista: es agregando una columna al esquema.
 *
 * El día que `Seller` tenga el token de OAuth de Mercado Pago, o `User` un
 * documento de identidad, quien lo agregue va a estar pensando en el modelo de
 * datos, no en qué devuelve el panel. Si alguna de estas funciones hiciera
 * `...fila`, la columna nueva saldría por la API sin que nadie lo decida.
 *
 * Este test le pasa a cada función un objeto **contaminado** con todos los
 * campos prohibidos que existen o podrían existir, y falla si alguno aparece en
 * la salida. No comprueba el código: comprueba el resultado.
 *
 * ─── Sobre la lista ───
 *
 * Incluye campos que hoy no están en el esquema (`docNumber`, `oauthToken`).
 * Es a propósito: el test tiene que estar listo antes que la columna.
 */

/** Valores centinela: si aparecen en la salida, algo se filtró. */
const CENTINELA = 'FUGA-DE-DATOS-NO-DEBE-APARECER';

const CAMPOS_PROHIBIDOS = {
  // Autenticación
  password: CENTINELA,
  passwordHash: CENTINELA,
  tokenHash: CENTINELA,
  refreshToken: CENTINELA,
  accessToken: CENTINELA,
  sessionToken: CENTINELA,

  // Pagos
  cardToken: CENTINELA,
  cardNumber: CENTINELA,
  cvv: CENTINELA,
  securityCode: CENTINELA,
  idempotencyKey: CENTINELA,

  // Proveedores
  oauthToken: CENTINELA,
  providerAccessToken: CENTINELA,
  providerRefreshToken: CENTINELA,
  secretAccessKey: CENTINELA,
  apiKey: CENTINELA,

  // Identidad (todavía no en el esquema; el test se adelanta)
  docNumber: CENTINELA,
  docNumberEnc: CENTINELA,
  cuit: CENTINELA,
  taxId: CENTINELA,
};

/** Todo lo que devuelve el panel, con entradas contaminadas. */
const SALIDAS: Array<[string, unknown]> = [
  [
    'usuario',
    verUsuario({
      ...CAMPOS_PROHIBIDOS,
      id: 'usr_1',
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan.perez@ejemplo.com',
      phoneE164: '+5491122334455',
      role: 'buyer',
      status: 'active',
      createdAt: new Date(),
    }),
  ],
  [
    'vendedor',
    verVendedor({
      ...CAMPOS_PROHIBIDOS,
      id: 'sel_1',
      userId: 'usr_1',
      displayName: 'Velas del Sur',
      slug: 'velas-del-sur',
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      createdAt: new Date(),
    }),
  ],
  [
    'producto',
    verProducto({
      ...CAMPOS_PROHIBIDOS,
      id: 'prd_1',
      storeId: 'sto_1',
      name: 'Vela de soja',
      slug: 'vela-de-soja',
      status: 'ACTIVE',
      currency: 'ARS',
      basePriceCents: 890000,
      createdAt: new Date(),
    }),
  ],
  [
    'orden',
    verOrden({
      ...CAMPOS_PROHIBIDOS,
      id: 'ord_1',
      reference: 'VX-0001',
      status: 'CONFIRMED',
      buyerId: 'usr_1',
      sellerId: 'sel_1',
      storeId: 'sto_1',
      currency: 'ARS',
      itemsSubtotal: 890000,
      shippingAmount: 0,
      discountAmount: 0,
      grossAmount: 890000,
      platformFeeBps: 600,
      platformFeeAmount: 53400,
      sellerNetAmount: 836600,
      createdAt: new Date(),
    }),
  ],
  [
    'intento de pago',
    verIntentoDePago({
      ...CAMPOS_PROHIBIDOS,
      id: 'pay_1',
      orderId: 'ord_1',
      provider: 'MERCADOPAGO',
      providerPaymentId: '1350331981',
      status: 'APPROVED',
      amount: 890000,
      currency: 'ARS',
      brand: 'visa',
      lastFour: '3704',
      createdAt: new Date(),
    }),
  ],
  [
    'devolución',
    verDevolucion({
      ...CAMPOS_PROHIBIDOS,
      id: 'ref_1',
      orderId: 'ord_1',
      paymentAttemptId: 'pay_1',
      provider: 'MERCADOPAGO',
      status: 'FAILED',
      amount: 890000,
      reason: 'sin stock tras pago tardío',
      attempts: 2,
      createdAt: new Date(),
    }),
  ],
  [
    'webhook',
    verWebhook({
      ...CAMPOS_PROHIBIDOS,
      id: 'whk_1',
      notificationId: '123',
      topic: 'payment',
      signatureValid: true,
      receivedAt: new Date(),
      // Los dos campos que un webhook trae y que NO deben salir.
      headers: { 'x-signature': CENTINELA, authorization: CENTINELA },
      payload: { card: { number: CENTINELA }, payer: { identification: CENTINELA } },
    } as never),
  ],
  [
    'auditoría',
    verAuditoria({
      ...CAMPOS_PROHIBIDOS,
      id: 'aud_1',
      actorType: 'admin',
      actorId: 'usr_admin',
      action: 'admin.user_suspended',
      entityType: 'user',
      entityId: 'usr_1',
      reason: 'fraude reportado',
      createdAt: new Date(),
    }),
  ],
];

describe('el panel de administración no filtra datos sensibles', () => {
  for (const [nombre, salida] of SALIDAS) {
    it(`⛔ ${nombre}`, () => {
      const serializado = JSON.stringify(salida);

      expect(serializado).not.toContain(CENTINELA);

      // Y ninguna CLAVE prohibida, aunque su valor fuera inocente.
      for (const clave of Object.keys(CAMPOS_PROHIBIDOS)) {
        expect(serializado, `apareció el campo "${clave}"`).not.toContain(`"${clave}"`);
      }
    });
  }

  it('⛔ el webhook no expone ni las cabeceras ni el cuerpo', () => {
    /**
     * Las cabeceras traen la firma del proveedor. El cuerpo de un webhook de
     * Mercado Pago trae el objeto de pago completo, con datos del pagador.
     *
     * Para operar alcanza con saber si la firma era válida, si se procesó y
     * con qué recurso.
     */
    const salida = JSON.stringify(
      verWebhook({
        id: 'whk_1',
        notificationId: '123',
        topic: 'payment',
        signatureValid: true,
        receivedAt: new Date(),
        headers: { 'x-signature': 'ts=1,v1=abc' },
        payload: { data: { id: '999' } },
      } as never),
    );

    expect(salida).not.toContain('headers');
    expect(salida).not.toContain('payload');
    expect(salida).not.toContain('x-signature');
  });
});

describe('enmascarado', () => {
  it('el email deja reconocer sin permitir escribir', () => {
    const salida = enmascararEmail('juan.perez@ejemplo.com');

    expect(salida).not.toBe('juan.perez@ejemplo.com');
    expect(salida).toContain('@ejemplo.com');
    expect(salida?.startsWith('ju')).toBe(true);
    // Y no revela el largo exacto de forma que se pueda reconstruir.
    expect(salida).toContain('*');
  });

  it('emails cortos y raros no revientan ni se filtran enteros', () => {
    expect(enmascararEmail('a@b.com')).toContain('@b.com');
    expect(enmascararEmail('a@b.com')).not.toBe('a@b.com');
    expect(enmascararEmail('sin-arroba')).toBe('***');
    expect(enmascararEmail('')).toBeNull();
    expect(enmascararEmail(null)).toBeNull();
    // Un email con varias arrobas: se parte por la última, que es la real.
    expect(enmascararEmail('raro@cosa@dominio.com')).toContain('@dominio.com');
  });

  it('el teléfono muestra sólo los últimos cuatro', () => {
    const salida = enmascararTelefono('+5491122334455');

    expect(salida).toBe('**********4455');
    expect(salida).not.toContain('549112233');
  });

  it('teléfonos cortos o ausentes no se filtran', () => {
    expect(enmascararTelefono('123')).toBe('****');
    expect(enmascararTelefono(null)).toBeNull();
    expect(enmascararTelefono(undefined)).toBeNull();
  });
});
