import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { METODO_DE_DESAFIO, desafioDe, generarPkce } from '@/modules/payments/pkce';
import {
  RequiereMercadoPagoError,
  exigirMercadoPago,
  puedeVender,
} from '@/modules/payments/puede-vender';

/**
 * El requisito para vender.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE PROTEGE ES QUE NO ACUMULEMOS PLATA AJENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Si un vendedor puede publicar sin conectar su cuenta, el cobro entra en la de
 * VendoX. Cada venta así es plata que le debemos a alguien y que hay que girar a
 * mano, una por una — y legalmente nos convierte en intermediarios del dinero de
 * terceros.
 *
 * Pero la regla tiene dos escapes deliberados, y son tan importantes como la
 * regla: si el OAuth se cae o no está configurado, exigir conectar algo que no
 * se puede conectar deja la app inservible para TODOS.
 */
describe('Puede vender', () => {
  const conectada = { reglaActiva: true, oauthDisponible: true, cuentaConectada: true };

  it('con la cuenta conectada, sí', () => {
    expect(puedeVender(conectada)).toBe(true);
  });

  it('⛔ sin cuenta conectada, no', () => {
    expect(puedeVender({ ...conectada, cuentaConectada: false })).toBe(false);
  });

  describe('Los dos escapes', () => {
    it('con la regla apagada, sí puede', () => {
      /**
       * Es el interruptor de incidente. Si el OAuth de Mercado Pago se cae,
       * poder apagarlo sin desplegar es la diferencia entre una tarde mala y un
       * día perdido.
       */
      expect(
        puedeVender({ reglaActiva: false, oauthDisponible: true, cuentaConectada: false }),
      ).toBe(true);
    });

    it('sin OAuth configurado en el servidor, sí puede', () => {
      // Exigir conectar algo que no se puede conectar dejaría la app
      // inservible, y no es culpa del vendedor.
      expect(
        puedeVender({ reglaActiva: true, oauthDisponible: false, cuentaConectada: false }),
      ).toBe(true);
    });
  });

  describe('El mensaje', () => {
    it('dice QUÉ acción se frenó', () => {
      /**
       * Un mensaje genérico deja a la persona sin saber qué estaba haciendo,
       * sobre todo si tocó "publicar" en una lista de veinte productos.
       */
      try {
        exigirMercadoPago('publicar', { ...conectada, cuentaConectada: false });
        expect.fail('tendría que haber lanzado');
      } catch (err) {
        expect((err as Error).message).toContain('publicar un producto');
      }

      try {
        exigirMercadoPago('transmitir', { ...conectada, cuentaConectada: false });
        expect.fail('tendría que haber lanzado');
      } catch (err) {
        expect((err as Error).message).toContain('hacer un vivo');
      }
    });

    it('explica POR QUÉ y que es una sola vez', () => {
      // "Conectá Mercado Pago" a secas se lee como un trámite nuestro. Decir
      // que ahí entra su plata lo convierte en algo que le conviene hacer.
      const err = new RequiereMercadoPagoError('publicar');
      expect(err.message).toContain('dinero de tus ventas');
      expect(err.message).toContain('una sola vez');
    });

    it('no lanza cuando sí puede', () => {
      expect(() => exigirMercadoPago('publicar', conectada)).not.toThrow();
    });
  });
});

/**
 * PKCE.
 *
 * Ata el CÓDIGO de autorización a la petición que lo pidió, que es distinto de
 * lo que hace el `state` —ese ata el callback a la persona—. Las dos defensas
 * hacen falta.
 */
describe('PKCE', () => {
  it('el desafío es el SHA-256 del verificador, en base64url', () => {
    const { verifier, challenge } = generarPkce();
    const esperado = createHash('sha256').update(verifier).digest('base64url');

    expect(challenge).toBe(esperado);
  });

  it('⛔ el desafío NO es el verificador', () => {
    /**
     * El RFC permite mandar el verificador tal cual como desafío (`plain`), y
     * eso anula PKCE por completo: quien vea la URL de autorización ve el
     * verificador y puede canjear el código.
     */
    const { verifier, challenge } = generarPkce();
    expect(challenge).not.toBe(verifier);
    expect(METODO_DE_DESAFIO).toBe('S256');
  });

  it('del desafío no se puede volver al verificador', () => {
    // Es lo único que hace que sea seguro publicarlo en una URL. Se comprueba
    // de la única forma posible: dos verificadores distintos dan desafíos
    // distintos y no hay relación visible.
    const a = generarPkce();
    const b = generarPkce();

    expect(a.challenge).not.toBe(b.challenge);
    expect(desafioDe(a.verifier)).toBe(a.challenge);
    expect(desafioDe(b.verifier)).not.toBe(a.challenge);
  });

  it('cada par es distinto', () => {
    // Un verificador reutilizado entre autorizaciones haría que interceptar uno
    // sirva para todas.
    const verificadores = new Set(Array.from({ length: 100 }, () => generarPkce().verifier));
    expect(verificadores.size).toBe(100);
  });

  it('el verificador cumple el largo que pide el RFC', () => {
    // Entre 43 y 128 caracteres. 32 bytes en base64url dan 43 exactos.
    const { verifier } = generarPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('es base64url: sin +, / ni =', () => {
    // Van en una URL. Con base64 común, el `+` se lee como espacio y el `/`
    // parte la ruta.
    for (let i = 0; i < 50; i += 1) {
      const { verifier, challenge } = generarPkce();
      expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });
});
