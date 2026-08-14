import { describe, expect, it, vi } from 'vitest';

import { servidorDe } from '@/modules/live/live.gateway';

/**
 * Cómo se resuelve el `Server` de Socket.IO para colgarle el adaptador.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL FALLO QUE ESTO CLAVA NO SE VEÍA EN NINGÚN LADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El gateway declara `namespace: '/live'`, y con un namespace Nest inyecta un
 * `Namespace` en `@WebSocketServer()`, no un `Server`. En `Server`, `adapter`
 * es un **método**; en `Namespace` es una **propiedad**. Llamarlo tiraba:
 *
 *     TypeError: this.server.adapter is not a function
 *
 * El arranque del adaptador está envuelto en un `try` —a propósito: Redis es
 * precisión, no una dependencia— así que el error se registraba como "sin
 * adaptador de Redis" y todo seguía. Con una instancia no se nota. Con dos, un
 * mensaje emitido desde A no le llega a quien está en B: media sala se queda
 * sin chat y sin producto destacado, y no hay ni un error en los logs.
 *
 * Se detectó leyendo los logs de arranque, no por un test. Este es el test.
 */
describe('El servidor de Socket.IO para el adaptador', () => {
  it('un Server se usa tal cual', () => {
    const server = { adapter: vi.fn() };
    expect(servidorDe(server as never)).toBe(server);
  });

  it('⛔ de un Namespace se saca el Server de adentro', () => {
    // Esto es lo que inyecta Nest cuando el gateway tiene `namespace`.
    const server = { adapter: vi.fn() };
    const namespace = { adapter: { rooms: new Map() }, server };

    // Sin esto se llamaría `adapter(...)` sobre un objeto, no sobre la función.
    expect(servidorDe(namespace as never)).toBe(server);
  });

  it('si no hay Server adentro, devuelve lo que le dieron', () => {
    // Nunca debería pasar, pero devolver `undefined` convertiría un aviso en
    // una excepción durante el arranque.
    const raro = { adapter: {} };
    expect(servidorDe(raro as never)).toBe(raro);
  });

  it('lo devuelto tiene `adapter` como función, que es lo único que importa', () => {
    const server = { adapter: vi.fn() };
    for (const entrada of [server, { adapter: {}, server }]) {
      expect(typeof servidorDe(entrada as never).adapter).toBe('function');
    }
  });
});
