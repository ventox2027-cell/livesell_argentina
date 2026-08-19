import { describe, expect, it } from 'vitest';

import {
  DIAS_DE_LA_VENTANA,
  ESTADOS_CON_VENTA_CONFIRMADA,
  inicioDeLaVentana,
  promedioSemanal,
  SEMANAS_DE_LA_VENTANA,
  ventasConfirmadasDe,
  ventasDe,
} from '@/modules/sellers/volumen';

/**
 * La definición de «venta», probada como tabla.
 *
 * Estos tests son sobre el filtro y la aritmética. Que la consulta contra
 * PostgreSQL excluya de verdad envío, recargo, canceladas y devueltas se prueba
 * aparte en `test/integration/volumen-flow.spec.ts`, contra la base real — que
 * es donde vive el `GREATEST(...)`.
 */
describe('qué cuenta como venta', () => {
  it('incluye los cinco estados posteriores a la confirmación', () => {
    expect([...ESTADOS_CON_VENTA_CONFIRMADA]).toEqual([
      'CONFIRMED',
      'PREPARING',
      'READY_TO_SHIP',
      'SHIPPED',
      'DELIVERED',
    ]);
  });

  /**
   * Este test es el que impide que alguien "unifique" la lista con la de
   * analítica sin darse cuenta de que son dos preguntas distintas.
   *
   * `PAID` es plata cobrada cuyo inventario todavía no se confirmó: puede
   * terminar en devolución. Meterla acá le daría al vendedor volumen —y
   * eventualmente un tramo de comisión más barato— por órdenes que quizá nunca
   * se concreten.
   */
  it('NO incluye PAID: cobrada no es confirmada', () => {
    expect(ESTADOS_CON_VENTA_CONFIRMADA).not.toContain('PAID');
  });

  it('NO incluye ningún estado de devolución', () => {
    for (const estado of ['PAYMENT_REQUIRES_REFUND', 'REFUND_PENDING', 'REFUNDED']) {
      expect(ESTADOS_CON_VENTA_CONFIRMADA).not.toContain(estado);
    }
  });

  it('NO incluye canceladas, vencidas ni pagos fallidos', () => {
    for (const estado of ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED']) {
      expect(ESTADOS_CON_VENTA_CONFIRMADA).not.toContain(estado);
    }
  });

  it('NO incluye lo que todavía no se cobró', () => {
    for (const estado of ['PENDING_PAYMENT', 'PROCESSING_PAYMENT']) {
      expect(ESTADOS_CON_VENTA_CONFIRMADA).not.toContain(estado);
    }
  });
});

describe('el filtro de Prisma', () => {
  it('filtra por vendedor y por los estados de venta', () => {
    expect(ventasConfirmadasDe('vendedor-1')).toEqual({
      sellerId: 'vendedor-1',
      status: { in: [...ESTADOS_CON_VENTA_CONFIRMADA] },
    });
  });

  it('con ventana agrega el corte por createdAt sin perder lo anterior', () => {
    const desde = new Date('2026-07-01T00:00:00.000Z');
    const filtro = ventasDe('vendedor-1', desde);

    expect(filtro.sellerId).toBe('vendedor-1');
    expect(filtro.status).toEqual({ in: [...ESTADOS_CON_VENTA_CONFIRMADA] });
    expect(filtro.createdAt).toEqual({ gte: desde });
  });

  /**
   * Se corta por `createdAt`, no por `confirmedAt`.
   *
   * Con `confirmedAt` el mismo pedido entraría o saldría de la ventana según
   * cuánto tardó el vendedor en prepararlo, que no mide volumen.
   */
  it('la ventana se corta por createdAt', () => {
    const filtro = ventasDe('v1', new Date('2026-07-01T00:00:00.000Z'));

    expect(filtro).not.toHaveProperty('confirmedAt');
    expect(filtro).not.toHaveProperty('paidAt');
  });
});

describe('la ventana móvil', () => {
  it('son 28 días, o sea 4 semanas', () => {
    expect(DIAS_DE_LA_VENTANA).toBe(28);
    expect(SEMANAS_DE_LA_VENTANA).toBe(4);
    expect(DIAS_DE_LA_VENTANA).toBe(SEMANAS_DE_LA_VENTANA * 7);
  });

  it('el inicio está exactamente 28 días atrás', () => {
    const ahora = new Date('2026-08-19T15:30:00.000Z');

    expect(inicioDeLaVentana(ahora).toISOString()).toBe('2026-07-22T15:30:00.000Z');
  });

  it('no rompe cruzando un cambio de año', () => {
    const ahora = new Date('2027-01-10T00:00:00.000Z');

    expect(inicioDeLaVentana(ahora).toISOString()).toBe('2026-12-13T00:00:00.000Z');
  });
});

describe('el promedio semanal', () => {
  it('divide el total de la ventana por cuatro', () => {
    expect(promedioSemanal(400_000_000)).toBe(100_000_000);
  });

  /**
   * Se trunca, no se redondea. Un centavo de más podría cruzar un umbral de
   * tramo: truncar deja siempre al vendedor del lado que ya alcanzó de verdad.
   */
  it('trunca hacia abajo y nunca inventa un centavo', () => {
    expect(promedioSemanal(3)).toBe(0);
    expect(promedioSemanal(7)).toBe(1);
    expect(promedioSemanal(1_200_000_003)).toBe(300_000_000);
  });

  it('sin ventas el promedio es cero, no NaN', () => {
    expect(promedioSemanal(0)).toBe(0);
  });

  /**
   * Cuatro semanas de $3.000.000 dan justo el umbral del segundo tramo. Este
   * número aparece a mano en los tests de comisión: si la ventana cambiara de
   * tamaño, este test avisa antes que aquéllos.
   */
  it('cuatro semanas de $3.000.000 promedian $3.000.000', () => {
    expect(promedioSemanal(300_000_000 * 4)).toBe(300_000_000);
  });
});
