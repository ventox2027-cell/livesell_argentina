import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Protección de `/metrics`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ HAY DEL OTRO LADO DE ESA URL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No hay datos personales, y por eso es fácil dejarla abierta sin pensarlo.
 * Pero sí está, en texto plano y sin autenticación:
 *
 *   · cuántas órdenes se crean por minuto — la facturación aproximada;
 *   · qué proporción de pagos se rechaza — si el proveedor está fallando;
 *   · cuántas devoluciones hay — si algo se rompió;
 *   · un contador por ruta, o sea el mapa completo de la API, incluidos los
 *     endpoints que no están documentados en ningún lado.
 *
 * Para un competidor es un informe de negocio actualizado cada quince
 * segundos. Para alguien buscando por dónde entrar, un índice.
 *
 * En local queda abierta a propósito: `METRICS_TOKEN` vacío. Fuera de local el
 * esquema de configuración la exige y el proceso no arranca sin ella.
 */

async function cargarControlador(metricsToken: string | undefined) {
  vi.resetModules();

  vi.doMock('@/config/env.schema', () => ({
    env: { METRICS_TOKEN: metricsToken, GIT_SHA: 'test', NODE_ENV: 'test' },
    isLocalEnv: () => true,
  }));

  const { HealthController } = await import('@/modules/health/health.controller');

  const metrics = { scrape: vi.fn().mockResolvedValue('vendox_orders_total 42') };
  const reply = { status: vi.fn().mockReturnThis() };

  const controller = new HealthController(
    {} as never,
    {} as never,
    metrics as never,
  );

  return { controller, metrics, reply };
}

describe('GET /metrics', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock('@/config/env.schema'));

  describe('sin METRICS_TOKEN configurado (local)', () => {
    it('responde sin pedir nada', async () => {
      const { controller, metrics, reply } = await cargarControlador(undefined);

      const salida = await controller.prometheus(undefined, reply as never);

      expect(salida).toBe('vendox_orders_total 42');
      expect(metrics.scrape).toHaveBeenCalled();
      expect(reply.status).not.toHaveBeenCalled();
    });
  });

  describe('con METRICS_TOKEN configurado (staging y producción)', () => {
    const TOKEN = 'a'.repeat(64);

    it('deja pasar con el token correcto', async () => {
      const { controller, metrics, reply } = await cargarControlador(TOKEN);

      const salida = await controller.prometheus(`Bearer ${TOKEN}`, reply as never);

      expect(salida).toBe('vendox_orders_total 42');
      expect(metrics.scrape).toHaveBeenCalled();
      expect(reply.status).not.toHaveBeenCalled();
    });

    it('rechaza sin cabecera', async () => {
      const { controller, metrics, reply } = await cargarControlador(TOKEN);

      const salida = await controller.prometheus(undefined, reply as never);

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(salida).toBe('');
      // Lo importante: ni siquiera se leen las métricas. Un 401 que igual las
      // calcula sigue dando una señal de tiempo aprovechable.
      expect(metrics.scrape).not.toHaveBeenCalled();
    });

    it('rechaza con el token equivocado', async () => {
      const { controller, metrics, reply } = await cargarControlador(TOKEN);

      const salida = await controller.prometheus(`Bearer ${'b'.repeat(64)}`, reply as never);

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(salida).toBe('');
      expect(metrics.scrape).not.toHaveBeenCalled();
    });

    it('rechaza un prefijo correcto del token', async () => {
      const { controller, reply } = await cargarControlador(TOKEN);

      // El caso que atrapa una comparación por prefijo mal escrita.
      await controller.prometheus(`Bearer ${'a'.repeat(32)}`, reply as never);

      expect(reply.status).toHaveBeenCalledWith(401);
    });

    it('rechaza el token sin el esquema Bearer', async () => {
      const { controller, reply } = await cargarControlador(TOKEN);

      await controller.prometheus(TOKEN, reply as never);

      expect(reply.status).toHaveBeenCalledWith(401);
    });

    it('no revela nada en el cuerpo del rechazo', async () => {
      const { controller, reply } = await cargarControlador(TOKEN);

      const salida = await controller.prometheus('Bearer nope', reply as never);

      // Un mensaje distinto según el motivo —"falta el token" contra "token
      // inválido"— le confirma a quien prueba que la URL existe y está
      // protegida, que es justo lo que quiere saber.
      expect(salida).toBe('');
    });
  });
});
