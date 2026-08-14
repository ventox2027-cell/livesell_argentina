import { describe, expect, it } from 'vitest';

import { MAX_INTENTOS, proximoIntento, seAgoto } from '@/modules/notifications/reintentos';

/**
 * La política de reintentos de los avisos.
 *
 * Se prueba entera porque define dos cosas que se notan: cuánto tarda un aviso
 * en salir cuando el proveedor tuvo un mal momento, y cuándo se deja de gastar
 * cuota en un envío que no va a funcionar.
 */
describe('Reintentos de envío', () => {
  const AHORA = new Date('2026-08-14T12:00:00.000Z');

  it('la espera crece entre intentos', () => {
    /**
     * Reintentar cada diez segundos con miles de avisos pendientes es lo que el
     * límite de tasa de Firebase castiga: cuando vuelva, nos encuentra con la
     * cuota agotada.
     */
    const esperas = [1, 2, 3, 4].map((n) => {
      const proximo = proximoIntento(n, AHORA);
      return proximo === null ? null : (proximo.getTime() - AHORA.getTime()) / 1000;
    });

    expect(esperas).toEqual([30, 120, 300, 900]);

    // Y cada una es mayor que la anterior, que es lo que importa de verdad.
    for (let i = 1; i < esperas.length; i += 1) {
      expect(esperas[i]!).toBeGreaterThan(esperas[i - 1]!);
    }
  });

  it('al quinto intento se deja de intentar', () => {
    expect(proximoIntento(MAX_INTENTOS, AHORA)).toBeNull();
    expect(seAgoto(MAX_INTENTOS)).toBe(true);
  });

  it('antes del quinto NO se rinde', () => {
    for (let n = 1; n < MAX_INTENTOS; n += 1) {
      expect(seAgoto(n), `intento ${n}`).toBe(false);
      expect(proximoIntento(n, AHORA), `intento ${n}`).not.toBeNull();
    }
  });

  it('nunca devuelve una fecha en el pasado', () => {
    // Un `nextAttemptAt` anterior a ahora hace que el barrido lo tome de nuevo
    // inmediatamente, y eso es un bucle cerrado a toda velocidad.
    for (let n = 1; n < MAX_INTENTOS; n += 1) {
      expect(proximoIntento(n, AHORA)!.getTime()).toBeGreaterThan(AHORA.getTime());
    }
  });

  it('un número de intento absurdo no revienta ni devuelve NaN', () => {
    // No debería pasar nunca. Si pasa, tiene que rendirse, no calcular una
    // fecha inválida que la base rechaza con un error incomprensible.
    expect(proximoIntento(999, AHORA)).toBeNull();
    expect(seAgoto(999)).toBe(true);
  });

  it('no depende del reloj del sistema', () => {
    // La fecha entra por parámetro: dos corridas del mismo caso dan lo mismo.
    const otro = new Date('2027-01-01T00:00:00.000Z');
    expect(proximoIntento(1, otro)!.toISOString()).toBe('2027-01-01T00:00:30.000Z');
  });
});
