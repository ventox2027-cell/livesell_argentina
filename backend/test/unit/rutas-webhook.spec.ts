import { describe, expect, it } from 'vitest';

import {
  RUTA_WEBHOOK_LIVEKIT,
  RUTA_WEBHOOK_MERCADOPAGO,
  RUTA_WEBHOOK_SPIKE,
} from '@/shared/http/rutas-webhook';

/**
 * Las rutas de webhook, como contrato.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTE ARCHIVO CLAVA LA URL QUE SE CARGA EN EL PANEL DE MERCADO PAGO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un webhook no es un endpoint más. Su URL la escribe una persona, una sola
 * vez, en el formulario de un proveedor externo, y a partir de ahí nadie la
 * vuelve a mirar. Cambiarla del lado del código no rompe ningún test ni ningún
 * despliegue: rompe los pagos, en silencio, semanas después.
 *
 * Por eso el valor exacto está escrito acá como literal. Si alguien lo cambia,
 * este test falla y lo obliga a preguntarse si además va a entrar al panel de
 * Mercado Pago a actualizarlo.
 */
describe('Rutas de webhook', () => {
  it('la ruta productiva de Mercado Pago es exactamente la que está en el panel', () => {
    expect(RUTA_WEBHOOK_MERCADOPAGO).toBe('webhooks/orders/mercadopago');
  });

  it('no lleva /api ni /v1', () => {
    // El día que salga /api/v2/, nadie va a ir al panel a actualizar la URL.
    expect(RUTA_WEBHOOK_MERCADOPAGO).not.toContain('api');
    expect(RUTA_WEBHOOK_MERCADOPAGO).not.toMatch(/\bv\d+\b/);
  });

  it('ninguna ruta arranca con barra', () => {
    // `setGlobalPrefix({ exclude })` y `@Controller({ path })` las esperan sin
    // barra inicial. Con barra, la exclusión no coincide y la ruta se sirve
    // bajo /api sin que nada falle: es el defecto que originó este archivo.
    for (const ruta of [RUTA_WEBHOOK_MERCADOPAGO, RUTA_WEBHOOK_SPIKE, RUTA_WEBHOOK_LIVEKIT]) {
      expect(ruta.startsWith('/')).toBe(false);
    }
  });

  it('la del spike es distinta y se anuncia como tal', () => {
    expect(RUTA_WEBHOOK_SPIKE).not.toBe(RUTA_WEBHOOK_MERCADOPAGO);
    // El segmento tiene que estar en la URL: es lo que evita que alguien pegue
    // la del spike en el panel creyendo que es la buena.
    expect(RUTA_WEBHOOK_SPIKE).toContain('spike');
  });

  it('⛔ nadie ocupa la ruta genérica "webhooks/mercadopago"', () => {
    /**
     * Era la del spike, y era la más creíble de las dos.
     *
     * Queda deliberadamente libre. Si mañana alguien la vuelve a usar para algo,
     * este test falla: esa URL es la que un humano apurado escribe de memoria en
     * el panel, y tiene que dar 404 en vez de acreditar pagos contra la tabla
     * equivocada.
     */
    expect(RUTA_WEBHOOK_MERCADOPAGO).not.toBe('webhooks/mercadopago');
    expect(RUTA_WEBHOOK_SPIKE).not.toBe('webhooks/mercadopago');
  });
});
