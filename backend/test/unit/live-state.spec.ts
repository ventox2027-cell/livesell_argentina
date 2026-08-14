import { describe, expect, it } from 'vitest';

import {
  admiteCompra,
  esTerminal,
  puedeTransicionar,
  tieneVideo,
  type EstadoDeVivo,
} from '@/modules/live/live-state';

/**
 * La máquina de estados del vivo.
 *
 * Lo que se prueba acá son las transiciones que **no** existen. Que
 * `SCHEDULED → LIVE` funcione es lo obvio; que `ENDED → LIVE` esté cerrado es
 * lo que evita que un vivo terminado se reabra y su resumen termine
 * describiendo dos transmisiones distintas como si fueran una.
 */

const TODOS: EstadoDeVivo[] = [
  'SCHEDULED',
  'STARTING',
  'LIVE',
  'RECONNECTING',
  'ENDING',
  'ENDED',
  'FAILED',
];

describe('transiciones', () => {
  it('el camino normal', () => {
    expect(puedeTransicionar('SCHEDULED', 'STARTING')).toBe(true);
    expect(puedeTransicionar('STARTING', 'LIVE')).toBe(true);
    expect(puedeTransicionar('LIVE', 'ENDING')).toBe(true);
    expect(puedeTransicionar('ENDING', 'ENDED')).toBe(true);
  });

  it('⛔ un vivo terminado no se reabre', () => {
    /**
     * Reabrir uno cerrado dejaría el resumen —espectadores, ventas, duración—
     * describiendo dos transmisiones como si fueran una, y las órdenes de la
     * segunda quedarían atribuidas a la primera.
     *
     * Si el vendedor quiere seguir, arranca uno nuevo.
     */
    for (const destino of TODOS) {
      expect(puedeTransicionar('ENDED', destino), `ENDED → ${destino}`).toBe(false);
    }
  });

  it('⛔ FAILED también es terminal', () => {
    for (const destino of TODOS) {
      expect(puedeTransicionar('FAILED', destino), `FAILED → ${destino}`).toBe(false);
    }
  });

  it('⛔ no se salta el paso de preparación', () => {
    // Tocar "iniciar" no puede encender la cámara en público de una. Ver el
    // comentario de `preparar()` en el servicio.
    expect(puedeTransicionar('SCHEDULED', 'LIVE')).toBe(false);
  });

  it('la reconexión va y vuelve', () => {
    expect(puedeTransicionar('LIVE', 'RECONNECTING')).toBe(true);
    expect(puedeTransicionar('RECONNECTING', 'LIVE')).toBe(true);
  });

  it('desde RECONNECTING se puede cerrar', () => {
    /**
     * Sin esta transición, una sesión con la conexión perdida quedaría abierta
     * para siempre: el vendedor no puede cerrarla porque no tiene conexión, y
     * nadie más puede.
     */
    expect(puedeTransicionar('RECONNECTING', 'ENDING')).toBe(true);
  });

  it('preparar y arrepentirse antes de salir al aire es válido', () => {
    expect(puedeTransicionar('SCHEDULED', 'ENDED')).toBe(true);
  });

  it('esTerminal coincide con no tener salidas', () => {
    for (const estado of TODOS) {
      const sinSalidas = TODOS.every((d) => !puedeTransicionar(estado, d));
      expect(esTerminal(estado), estado).toBe(sinSalidas);
    }
  });
});

describe('admiteCompra', () => {
  it('⛔ RECONNECTING SÍ permite comprar', () => {
    /**
     * La decisión menos obvia del archivo.
     *
     * Que al vendedor se le haya caído el wifi no invalida el stock ni la orden
     * que alguien está por confirmar. Bloquear la compra ahí convertiría un
     * problema de red de una persona en ventas perdidas para todos los que
     * estaban mirando — justo en el momento de más intención de compra, que es
     * cuando el producto está en pantalla.
     */
    expect(admiteCompra('RECONNECTING')).toBe(true);
  });

  it('ENDING también: quien ya tocó comprar merece terminar', () => {
    expect(admiteCompra('ENDING')).toBe(true);
  });

  it('⛔ antes de salir al aire, no', () => {
    expect(admiteCompra('SCHEDULED')).toBe(false);
    expect(admiteCompra('STARTING')).toBe(false);
  });

  it('⛔ terminado, tampoco desde el vivo', () => {
    // Después el comprador sigue por la tienda, que es otro camino.
    expect(admiteCompra('ENDED')).toBe(false);
    expect(admiteCompra('FAILED')).toBe(false);
  });
});

describe('tieneVideo', () => {
  it('sólo LIVE y RECONNECTING', () => {
    // En RECONNECTING la app conserva el último cuadro y muestra el aviso, en
    // vez de una pantalla negra.
    expect(tieneVideo('LIVE')).toBe(true);
    expect(tieneVideo('RECONNECTING')).toBe(true);

    for (const e of ['SCHEDULED', 'STARTING', 'ENDING', 'ENDED', 'FAILED'] as EstadoDeVivo[]) {
      expect(tieneVideo(e), e).toBe(false);
    }
  });
});
