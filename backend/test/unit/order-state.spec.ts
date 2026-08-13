import { describe, expect, it } from 'vitest';

import {
  amountToCents,
  canAttemptPayment,
  centsToAmount,
  mapMpStatus,
  needsReconciliation,
  nextOrderStatus,
} from '../../src/modules/payments/order-state';

describe('mapMpStatus', () => {
  it('traduce los estados conocidos', () => {
    expect(mapMpStatus('approved')).toBe('APPROVED');
    expect(mapMpStatus('in_process')).toBe('IN_PROCESS');
    expect(mapMpStatus('charged_back')).toBe('CHARGED_BACK');
  });

  it('acepta las dos grafías de cancelado', () => {
    expect(mapMpStatus('cancelled')).toBe('CANCELLED');
    expect(mapMpStatus('canceled')).toBe('CANCELLED');
  });

  it('no adivina ante un estado desconocido', () => {
    // Si Mercado Pago agrega un estado, la orden queda quieta y visible en el
    // panel. Adivinar sería peor que no hacer nada.
    expect(mapMpStatus('algo_nuevo')).toBe('UNKNOWN');
    expect(mapMpStatus(undefined)).toBe('UNKNOWN');
  });
});

describe('nextOrderStatus · avance normal', () => {
  it('pendiente → procesando cuando el pago queda en proceso', () => {
    const r = nextOrderStatus('PENDING_PAYMENT', 'IN_PROCESS');
    expect(r).toEqual({ status: 'PROCESSING', changed: true });
  });

  it('procesando → pagada cuando se aprueba', () => {
    expect(nextOrderStatus('PROCESSING', 'APPROVED')).toEqual({ status: 'PAID', changed: true });
  });

  it('pendiente → pagada directo, sin pasar por procesando', () => {
    // Es el camino real de una tarjeta aprobada al instante.
    expect(nextOrderStatus('PENDING_PAYMENT', 'APPROVED')).toEqual({
      status: 'PAID',
      changed: true,
    });
  });

  it('procesando → fallida cuando se rechaza', () => {
    expect(nextOrderStatus('PROCESSING', 'REJECTED')).toEqual({ status: 'FAILED', changed: true });
  });

  it('permite reintentar con otra tarjeta después de un rechazo', () => {
    expect(nextOrderStatus('FAILED', 'APPROVED')).toEqual({ status: 'PAID', changed: true });
  });
});

describe('nextOrderStatus · monotonía (lo que evita despagar una orden)', () => {
  it('⛔ una orden pagada NO vuelve a procesando', () => {
    // Caso real: el reintento del webhook `pending` llega DESPUÉS del
    // `approved`. Sin esta guarda, la orden se despaga sola.
    const r = nextOrderStatus('PAID', 'PENDING');
    expect(r.status).toBe('PAID');
    expect(r.changed).toBe(false);
    expect(r.ignoredReason).toBe('MONOTONIC_GUARD');
  });

  it('⛔ una orden pagada NO pasa a fallida', () => {
    const r = nextOrderStatus('PAID', 'REJECTED');
    expect(r.status).toBe('PAID');
    expect(r.ignoredReason).toBe('MONOTONIC_GUARD');
  });

  it('⛔ una orden pagada NO pasa a cancelada', () => {
    expect(nextOrderStatus('PAID', 'CANCELLED').status).toBe('PAID');
  });

  it('una devolución SÍ mueve una orden pagada', () => {
    expect(nextOrderStatus('PAID', 'REFUNDED')).toEqual({ status: 'REFUNDED', changed: true });
  });

  it('un contracargo también', () => {
    expect(nextOrderStatus('PAID', 'CHARGED_BACK')).toEqual({ status: 'REFUNDED', changed: true });
  });

  it('⛔ una orden devuelta no vuelve a pagada', () => {
    expect(nextOrderStatus('REFUNDED', 'APPROVED').ignoredReason).toBe('MONOTONIC_GUARD');
  });

  it('el mismo estado repetido no es un cambio', () => {
    // Webhook duplicado: cuatro veces `approved`. Una sola acreditación.
    const r = nextOrderStatus('PAID', 'APPROVED');
    expect(r.changed).toBe(false);
    expect(r.ignoredReason).toBe('SAME_STATUS');
  });

  it('un estado desconocido no toca la orden', () => {
    const r = nextOrderStatus('PROCESSING', 'UNKNOWN');
    expect(r).toEqual({ status: 'PROCESSING', changed: false, ignoredReason: 'UNKNOWN_STATUS' });
  });

  it('aplicar cuatro veces el mismo webhook da el mismo resultado que una', () => {
    let status = nextOrderStatus('PENDING_PAYMENT', 'APPROVED').status;
    for (let i = 0; i < 3; i += 1) status = nextOrderStatus(status, 'APPROVED').status;
    expect(status).toBe('PAID');
  });

  it('el desorden completo termina igual que el orden correcto', () => {
    const enOrden = ['PENDING', 'IN_PROCESS', 'APPROVED'] as const;
    const alReves = ['APPROVED', 'IN_PROCESS', 'PENDING'] as const;

    const aplicar = (secuencia: readonly (typeof enOrden)[number][]) =>
      secuencia.reduce<ReturnType<typeof nextOrderStatus>['status']>(
        (acc, s) => nextOrderStatus(acc, s).status,
        'PENDING_PAYMENT',
      );

    expect(aplicar(enOrden)).toBe('PAID');
    expect(aplicar(alReves)).toBe('PAID');
  });
});

describe('canAttemptPayment', () => {
  it('permite cobrar sobre una orden nueva o rechazada', () => {
    expect(canAttemptPayment('PENDING_PAYMENT')).toBe(true);
    expect(canAttemptPayment('FAILED')).toBe(true);
  });

  it('⛔ NO permite cobrar sobre una orden con un pago en vuelo', () => {
    // Es la protección contra el doble cobro cuando no sabemos el resultado
    // del intento anterior.
    expect(canAttemptPayment('PROCESSING')).toBe(false);
  });

  it('⛔ NO permite cobrar dos veces una orden paga', () => {
    expect(canAttemptPayment('PAID')).toBe(false);
    expect(canAttemptPayment('REFUNDED')).toBe(false);
  });
});

describe('needsReconciliation', () => {
  it('sólo persigue las órdenes atascadas en procesando', () => {
    expect(needsReconciliation('PROCESSING')).toBe(true);
    expect(needsReconciliation('PAID')).toBe(false);
    expect(needsReconciliation('PENDING_PAYMENT')).toBe(false);
  });
});

describe('conversión de dinero', () => {
  it('ida y vuelta sin perder centavos', () => {
    expect(centsToAmount(150_000)).toBe(1500);
    expect(amountToCents(1500)).toBe(150_000);
    expect(amountToCents(centsToAmount(123_456))).toBe(123_456);
  });

  it('sobrevive al error de representación en punto flotante', () => {
    // 1499.9999999999998 es lo que puede volver de un JSON. Truncar daría
    // 149999 centavos: un peso menos, para siempre, en cada orden.
    expect(amountToCents(1499.9999999999998)).toBe(150_000);
    expect(amountToCents(0.1 + 0.2)).toBe(30);
  });

  it('maneja montos con centavos', () => {
    expect(centsToAmount(1)).toBe(0.01);
    expect(amountToCents(19.99)).toBe(1999);
  });
});
