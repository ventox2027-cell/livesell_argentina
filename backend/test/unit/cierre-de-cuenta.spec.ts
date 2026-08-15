import type { OrderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  CuentaConOperacionesEnCursoError,
  ESTADOS_QUE_IMPIDEN_CERRAR,
  puedeCerrarCuenta,
} from '@/modules/users/cierre-de-cuenta';

/**
 * Cuándo se puede cerrar una cuenta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL AGUJERO QUE ESTOS TESTS FIJAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cerrar la cuenta era un `DELETE` sin condiciones: un vendedor podía cobrar
 * diez pedidos, tocar "eliminar cuenta" y desaparecer. No es hipotético, es la
 * forma más barata de estafar en una plataforma de venta.
 *
 * Del otro lado está la Ley 25.326, que da el derecho a irse. El equilibrio es
 * que el bloqueo sea temporal y explicado, no una retención.
 */
describe('Cierre de cuenta', () => {
  it('sin nada en curso, se puede cerrar', () => {
    expect(puedeCerrarCuenta({ comoComprador: 0, comoVendedor: 0 })).toBe(true);
  });

  it('⛔ con una venta sin entregar, no', () => {
    expect(puedeCerrarCuenta({ comoComprador: 0, comoVendedor: 1 })).toBe(false);
  });

  it('⛔ con una compra en curso, tampoco', () => {
    // Del lado del comprador el motivo es otro: si se va, no hay a quién
    // entregarle ni a quién devolverle la plata si algo sale mal.
    expect(puedeCerrarCuenta({ comoComprador: 1, comoVendedor: 0 })).toBe(false);
  });

  describe('Qué estados frenan', () => {
    it('los que tienen plata o producto en movimiento', () => {
      for (const estado of [
        'PAID',
        'CONFIRMED',
        'PREPARING',
        'READY_TO_SHIP',
        'SHIPPED',
        'REFUND_PENDING',
      ] as OrderStatus[]) {
        expect(ESTADOS_QUE_IMPIDEN_CERRAR, estado).toContain(estado);
      }
    });

    it('un carrito sin pagar NO frena', () => {
      /**
       * `PENDING_PAYMENT` es un carrito abandonado: nadie puso plata y nadie
       * espera nada, y vence solo en minutos. Bloquear por eso sería retener a
       * alguien por una compra que ni siquiera hizo.
       */
      expect(ESTADOS_QUE_IMPIDEN_CERRAR).not.toContain('PENDING_PAYMENT');
    });

    it('lo terminado NO frena', () => {
      // Entregado, cancelado, vencido, reembolsado: la operación se cerró y la
      // persona tiene derecho a irse.
      for (const estado of [
        'DELIVERED',
        'CANCELLED',
        'EXPIRED',
        'REFUNDED',
        'PAYMENT_FAILED',
      ] as OrderStatus[]) {
        expect(ESTADOS_QUE_IMPIDEN_CERRAR, estado).not.toContain(estado);
      }
    });

    it('la lista es positiva, no una exclusión', () => {
      /**
       * Se enumera qué bloquea en vez de excluir lo terminal. Con una lista
       * negativa, un estado nuevo en el enum entraría automáticamente en
       * "bloquea", y eso sería un cambio de comportamiento que nadie decidió.
       *
       * El test lo fija: si alguien la invierte, la cantidad cambia y esto
       * falla.
       */
      expect(ESTADOS_QUE_IMPIDEN_CERRAR).toHaveLength(8);
    });
  });

  describe('El mensaje', () => {
    function mensajeDe(comoComprador: number, comoVendedor: number): string {
      return new CuentaConOperacionesEnCursoError({ comoComprador, comoVendedor }).message;
    }

    it('dice cuántas son', () => {
      // "No podés cerrar tu cuenta" a secas deja a la persona sin saber si es un
      // error del sistema ni cuánto tiene que esperar.
      expect(mensajeDe(0, 3)).toContain('3');
      expect(mensajeDe(2, 0)).toContain('2');
    });

    it('al vendedor le dice que hay gente esperándolo', () => {
      /**
       * Es la diferencia entre "aguantá un poco" y "hay personas que te
       * pagaron". Del lado del vendedor no es él quien espera algo.
       */
      const m = mensajeDe(0, 1);
      expect(m).toContain('ya pagaron');
      expect(m).toContain('venta');
    });

    it('al comprador le dice qué puede hacer mientras tanto', () => {
      expect(mensajeDe(1, 0)).toContain('Mis pedidos');
    });

    it('con las dos cosas, las nombra a las dos', () => {
      const m = mensajeDe(2, 3);
      expect(m).toContain('3');
      expect(m).toContain('2');
    });

    it('el singular y el plural están bien', () => {
      // Un "1 ventas" en un mensaje que ya es una mala noticia se lee como
      // descuido.
      expect(mensajeDe(0, 1)).toContain('1 venta ');
      expect(mensajeDe(0, 2)).toContain('2 ventas');
      expect(mensajeDe(1, 0)).toContain('1 compra ');
      expect(mensajeDe(2, 0)).toContain('2 compras');
    });

    it('deja el conteo en los detalles, para la app', () => {
      const e = new CuentaConOperacionesEnCursoError({ comoComprador: 1, comoVendedor: 4 });

      expect(e.code).toBe('ACCOUNT_HAS_OPEN_ORDERS');
      expect(e.details).toEqual({ pedidosComoComprador: 1, ventasComoVendedor: 4 });
    });
  });
});
