import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registrarApagadoOrdenado } from '@/shutdown';

/**
 * Apagado ordenado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO TIENE TESTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es código que sólo corre cuando la plataforma manda SIGTERM. En desarrollo
 * eso pasa con un Ctrl+C, donde nadie mira si cerró bien; en producción pasa en
 * cada despliegue, donde el precio de que esté mal es cortar peticiones a la
 * mitad. Y si la que se corta era un cobro, el resultado de ese pago queda
 * indeterminado — el caso más caro que maneja este sistema.
 *
 * Es exactamente el perfil de código que se rompe sin que nadie se entere.
 */

type Manejador = () => void;

describe('registrarApagadoOrdenado', () => {
  let manejadores: Map<string, Manejador>;
  let salidas: number[];
  let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    manejadores = new Map();
    salidas = [];

    vi.spyOn(process, 'on').mockImplementation(((senal: string, fn: Manejador) => {
      manejadores.set(senal, fn);
      return process;
    }) as never);

    vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
      salidas.push(codigo ?? 0);
      return undefined as never;
    }) as never);

    logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Deja correr los temporizadores falsos y las microtareas pendientes. */
  async function avanzar(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('escucha SIGTERM y SIGINT', () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 100, topeMs: 5_000 });

    expect(manejadores.has('SIGTERM')).toBe(true);
    expect(manejadores.has('SIGINT')).toBe(true);
  });

  it('drena ANTES de cerrar', async () => {
    /**
     * El orden es lo que se está probando, y no es un detalle.
     *
     * El balanceador tarda en enterarse de que esta instancia se va, y durante
     * esos segundos le sigue mandando tráfico. Cerrar primero convierte cada
     * petición de esa ventana en un error; esperar primero hace que las reciba
     * y las conteste normalmente.
     */
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 5_000, topeMs: 30_000 });

    manejadores.get('SIGTERM')!();

    await avanzar(4_999);
    expect(app.close).not.toHaveBeenCalled();

    await avanzar(2);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('sale con 0 cuando cerró bien', async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 0, topeMs: 30_000 });

    manejadores.get('SIGTERM')!();
    await avanzar(10);

    expect(salidas).toEqual([0]);
  });

  it('una segunda señal no arranca un segundo apagado', async () => {
    /**
     * Sin la guarda, un Ctrl+C repetido —o un SIGTERM seguido de SIGINT, que
     * algunos orquestadores mandan— dispara dos cierres en paralelo sobre las
     * mismas conexiones.
     */
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 1_000, topeMs: 30_000 });

    manejadores.get('SIGTERM')!();
    manejadores.get('SIGTERM')!();
    manejadores.get('SIGINT')!();

    await avanzar(2_000);

    expect(app.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('si el cierre se cuelga, sale por el tope en vez de esperar el SIGKILL', async () => {
    /**
     * El caso que justifica que exista un tope.
     *
     * Una consulta eterna o un socket que no responde dejarían el proceso
     * esperando hasta que la plataforma mande SIGKILL — que no ejecuta ningún
     * cierre y deja las conexiones colgadas del otro lado. Salir por las
     * nuestras es estrictamente mejor.
     *
     * El código de salida es 1 a propósito: un apagado que no pudo cerrar no es
     * un apagado exitoso, y la diferencia se ve en los registros de la
     * plataforma.
     */
    const app = { close: vi.fn().mockReturnValue(new Promise(() => {})) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 0, topeMs: 10_000 });

    manejadores.get('SIGTERM')!();

    await avanzar(9_999);
    expect(salidas).toEqual([]);

    await avanzar(2);
    expect(salidas).toEqual([1]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('el tope cubre el apagado ENTERO, drenaje incluido', async () => {
    /**
     * Si el tope arrancara recién después del drenaje, un drenaje largo se
     * comería el presupuesto y el SIGKILL llegaría igual. El reloj es uno solo
     * para todo el apagado, que es como lo mide la plataforma.
     */
    const app = { close: vi.fn().mockReturnValue(new Promise(() => {})) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 8_000, topeMs: 10_000 });

    manejadores.get('SIGTERM')!();

    await avanzar(10_001);

    expect(salidas).toEqual([1]);
  });

  it('con drenaje en 0 cierra de inmediato (el worker, que no tiene balanceador)', async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    registrarApagadoOrdenado(app as never, logger as never, { drenajeMs: 0, topeMs: 30_000 });

    manejadores.get('SIGTERM')!();
    await avanzar(1);

    expect(app.close).toHaveBeenCalledOnce();
  });
});
