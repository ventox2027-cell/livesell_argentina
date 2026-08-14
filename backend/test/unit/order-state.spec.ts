import { describe, expect, it } from 'vitest';
import type { OrderStatus, PaymentAttemptStatus } from '@prisma/client';

import {
  admiteCancelacionDelComprador,
  admitePago,
  debeAplicarse,
  esFinal,
  esTransicionDelVendedor,
  estadoDeOrdenPara,
  intentoResuelto,
  mapearEstadoMp,
  necesitaConciliacion,
  puedeVencer,
  transicionDeIntentoValida,
  transicionValida,
} from '@/modules/orders/order-state';

/**
 * Las dos máquinas de estados.
 *
 * Cada caso de acá se traduce en plata: una transición de más deja a alguien
 * cobrado sin producto, y una de menos deja una venta trabada para siempre.
 */

describe('Transiciones de la orden', () => {
  it('el camino feliz completo', () => {
    const camino: OrderStatus[] = [
      'PENDING_PAYMENT',
      'PROCESSING_PAYMENT',
      'PAID',
      'CONFIRMED',
      'PREPARING',
      'READY_TO_SHIP',
      'SHIPPED',
      'DELIVERED',
    ];

    for (let i = 0; i < camino.length - 1; i += 1) {
      expect(
        transicionValida(camino[i]!, camino[i + 1]!),
        `${camino[i]} → ${camino[i + 1]}`,
      ).toBe(true);
    }
  });

  it('⛔ una orden pagada NO puede volver a fallar', () => {
    /**
     * La guarda que evita despagar una orden.
     *
     * Los webhooks de Mercado Pago llegan desordenados: puede llegar
     * `approved` y después `pending` del MISMO pago, porque el reintento del
     * primero se demoró más que el segundo envío. Sin esto, el segundo aviso
     * dejaría como impaga una orden que tiene plata.
     */
    expect(transicionValida('PAID', 'PAYMENT_FAILED')).toBe(false);
    expect(transicionValida('PAID', 'PENDING_PAYMENT')).toBe(false);
    expect(transicionValida('PAID', 'PROCESSING_PAYMENT')).toBe(false);
    expect(transicionValida('PAID', 'EXPIRED')).toBe(false);
    expect(transicionValida('CONFIRMED', 'PAID')).toBe(false);
  });

  it('⛔ una orden con un cobro en vuelo NO puede vencer', () => {
    /**
     * Si ese cobro se aprobó y todavía no nos enteramos, marcarla vencida
     * sería quedarse con la plata de alguien. El conciliador la resuelve
     * primero.
     */
    expect(transicionValida('PROCESSING_PAYMENT', 'EXPIRED')).toBe(false);
    expect(puedeVencer('PROCESSING_PAYMENT')).toBe(false);
    expect(puedeVencer('PAID')).toBe(false);
    expect(puedeVencer('PENDING_PAYMENT')).toBe(true);
    expect(puedeVencer('PAYMENT_FAILED')).toBe(true);
  });

  it('desde PAID sólo hay dos salidas, y las dos son honestas', () => {
    // O se confirma la venta, o se devuelve la plata. No hay tercera.
    expect(transicionValida('PAID', 'CONFIRMED')).toBe(true);
    expect(transicionValida('PAID', 'PAYMENT_REQUIRES_REFUND')).toBe(true);
    expect(transicionValida('PAID', 'CANCELLED')).toBe(false);
    expect(transicionValida('PAID', 'REFUNDED')).toBe(false);
  });

  it('el camino de la devolución', () => {
    expect(transicionValida('PAYMENT_REQUIRES_REFUND', 'REFUND_PENDING')).toBe(true);
    expect(transicionValida('REFUND_PENDING', 'REFUNDED')).toBe(true);
    // Si la devolución falla técnicamente, vuelve a pendiente de devolver.
    expect(transicionValida('REFUND_PENDING', 'PAYMENT_REQUIRES_REFUND')).toBe(true);
  });

  it('un cobro rechazado se puede reintentar', () => {
    expect(transicionValida('PAYMENT_FAILED', 'PROCESSING_PAYMENT')).toBe(true);
    expect(admitePago('PAYMENT_FAILED')).toBe(true);
  });

  it('⛔ no se puede pagar una orden con un cobro en vuelo', () => {
    // Lanzar otro cobro sin saber cómo terminó el primero es cobrar dos veces.
    expect(admitePago('PROCESSING_PAYMENT')).toBe(false);
    expect(admitePago('PAID')).toBe(false);
    expect(admitePago('CONFIRMED')).toBe(false);
    expect(admitePago('EXPIRED')).toBe(false);
    expect(admitePago('CANCELLED')).toBe(false);
  });

  it('los estados finales no tienen salida', () => {
    expect(esFinal('DELIVERED')).toBe(true);
    expect(esFinal('REFUNDED')).toBe(true);
    expect(esFinal('EXPIRED')).toBe(true);
    expect(esFinal('CANCELLED')).toBe(true);
    expect(esFinal('PENDING_PAYMENT')).toBe(false);
  });
});

describe('Quién puede mover qué', () => {
  it('el vendedor avanza la preparación', () => {
    expect(esTransicionDelVendedor('CONFIRMED', 'PREPARING')).toBe(true);
    expect(esTransicionDelVendedor('PREPARING', 'READY_TO_SHIP')).toBe(true);
    expect(esTransicionDelVendedor('READY_TO_SHIP', 'SHIPPED')).toBe(true);
  });

  it('⛔ el vendedor NO puede saltarse pasos', () => {
    expect(esTransicionDelVendedor('CONFIRMED', 'SHIPPED')).toBe(false);
    expect(esTransicionDelVendedor('CONFIRMED', 'READY_TO_SHIP')).toBe(false);
  });

  it('⛔ el vendedor no toca estados de plata', () => {
    // No puede declarar pagada ni devuelta una orden. Eso lo decide el backend
    // preguntándole a Mercado Pago.
    expect(esTransicionDelVendedor('PENDING_PAYMENT', 'PAID')).toBe(false);
    expect(esTransicionDelVendedor('PAID', 'CONFIRMED')).toBe(false);
    expect(esTransicionDelVendedor('PAID', 'REFUNDED')).toBe(false);
  });

  it('⛔ no se puede preparar algo que no está confirmado', () => {
    // Confirmado significa que hay plata Y que el stock se consumió.
    expect(esTransicionDelVendedor('PAID', 'PREPARING')).toBe(false);
    expect(esTransicionDelVendedor('PENDING_PAYMENT', 'PREPARING')).toBe(false);
  });

  it('el comprador cancela sólo antes de pagar', () => {
    expect(admiteCancelacionDelComprador('PENDING_PAYMENT')).toBe(true);
    expect(admiteCancelacionDelComprador('PAYMENT_FAILED')).toBe(true);
    expect(admiteCancelacionDelComprador('PROCESSING_PAYMENT')).toBe(false);
    expect(admiteCancelacionDelComprador('PAID')).toBe(false);
    expect(admiteCancelacionDelComprador('CONFIRMED')).toBe(false);
  });
});

describe('Estados de Mercado Pago', () => {
  it.each([
    ['approved', 'APPROVED'],
    ['rejected', 'REJECTED'],
    ['cancelled', 'CANCELLED'],
    ['canceled', 'CANCELLED'],
    ['refunded', 'REFUNDED'],
    ['charged_back', 'REFUNDED'],
    ['pending', 'PROCESSING'],
    ['in_process', 'PROCESSING'],
    ['in_mediation', 'PROCESSING'],
    ['authorized', 'PROCESSING'],
  ])('%s → %s', (mp, esperado) => {
    expect(mapearEstadoMp(mp)).toBe(esperado);
  });

  it('⛔ un estado desconocido NO se adivina', () => {
    /**
     * La línea más importante del mapeo.
     *
     * Mapear lo desconocido a `REJECTED` sería decirle a alguien que no le
     * cobraron cuando quizá sí, y dejarlo pagar de nuevo. Lo desconocido se
     * marca para conciliar.
     */
    expect(mapearEstadoMp('un_estado_nuevo_de_mp')).toBe('UNKNOWN_PENDING_RECONCILIATION');
    expect(mapearEstadoMp(undefined)).toBe('UNKNOWN_PENDING_RECONCILIATION');
    expect(mapearEstadoMp('')).toBe('UNKNOWN_PENDING_RECONCILIATION');
  });

  it('no distingue mayúsculas', () => {
    expect(mapearEstadoMp('APPROVED')).toBe('APPROVED');
    expect(mapearEstadoMp('Approved')).toBe('APPROVED');
  });
});

describe('Transiciones del intento de cobro', () => {
  it('⛔ un cobro aprobado no se desaprueba', () => {
    expect(transicionDeIntentoValida('APPROVED', 'REJECTED')).toBe(false);
    expect(transicionDeIntentoValida('APPROVED', 'PROCESSING')).toBe(false);
    // Sólo hacia la devolución.
    expect(transicionDeIntentoValida('APPROVED', 'REFUNDED')).toBe(true);
  });

  it('desde "no sabemos" se puede ir a cualquier desenlace', () => {
    // Cuando el conciliador finalmente pregunta, la respuesta puede ser
    // cualquiera. Ese es el punto de este estado.
    expect(transicionDeIntentoValida('UNKNOWN_PENDING_RECONCILIATION', 'APPROVED')).toBe(true);
    expect(transicionDeIntentoValida('UNKNOWN_PENDING_RECONCILIATION', 'REJECTED')).toBe(true);
    expect(transicionDeIntentoValida('UNKNOWN_PENDING_RECONCILIATION', 'CANCELLED')).toBe(true);
  });

  it('un rechazo es definitivo', () => {
    expect(transicionDeIntentoValida('REJECTED', 'APPROVED')).toBe(false);
    expect(intentoResuelto('REJECTED')).toBe(true);
  });

  it('el conciliador mira los inciertos', () => {
    expect(necesitaConciliacion('PROCESSING')).toBe(true);
    expect(necesitaConciliacion('UNKNOWN_PENDING_RECONCILIATION')).toBe(true);
    expect(necesitaConciliacion('APPROVED')).toBe(false);
    expect(necesitaConciliacion('REJECTED')).toBe(false);
  });
});

describe('Del intento a la orden', () => {
  it.each([
    ['APPROVED', 'PAID'],
    ['REJECTED', 'PAYMENT_FAILED'],
    ['PROCESSING', 'PROCESSING_PAYMENT'],
    ['CREATED', 'PROCESSING_PAYMENT'],
    ['CANCELLED', 'CANCELLED'],
    ['REFUNDED', 'REFUNDED'],
  ] as [PaymentAttemptStatus, OrderStatus][])('%s → %s', (intento, orden) => {
    expect(estadoDeOrdenPara(intento)).toBe(orden);
  });

  it('⛔ un cobro incierto deja la orden trabada, no la libera', () => {
    /**
     * `PROCESSING_PAYMENT` es un estado que NO admite otro intento. Es
     * deliberado: mientras no se sepa si el primer cobro salió, permitir otro
     * es la forma más directa de cobrar dos veces.
     */
    expect(estadoDeOrdenPara('UNKNOWN_PENDING_RECONCILIATION')).toBe('PROCESSING_PAYMENT');
    expect(admitePago('PROCESSING_PAYMENT')).toBe(false);
  });
});

describe('La guarda de monotonía', () => {
  it('⛔ el segundo aviso del mismo pago no hace nada', () => {
    /**
     * Medido en la primera compra real del spike:
     *
     *     07:46:12.307  respuesta directa   PROCESSING → PAID
     *     07:46:12.988  webhook             PAID       → PAID
     *
     * 681 ms. Sin esta guarda, dos caminos de confirmación habrían acreditado
     * el mismo pago dos veces, y habría pasado sin que nadie lo provocara.
     */
    expect(debeAplicarse('PAID', 'PAID')).toBe(false);
    expect(debeAplicarse('CONFIRMED', 'PAID')).toBe(false);
    expect(debeAplicarse('PAID', 'PAYMENT_FAILED')).toBe(false);
  });

  it('sí aplica una transición legítima hacia adelante', () => {
    expect(debeAplicarse('PROCESSING_PAYMENT', 'PAID')).toBe(true);
    expect(debeAplicarse('PAID', 'CONFIRMED')).toBe(true);
  });
});
