import { describe, expect, it } from 'vitest';

import {
  EDAD_MAXIMA_RAZONABLE,
  edadEn,
  esMayorDeEdad,
  exigirMayoriaDeEdad,
  FaltaLaFechaDeNacimientoError,
  fechaDeNacimientoInvalida,
  FechaDeNacimientoInvalidaError,
  MAYORIA_DE_EDAD,
  MenorDeEdadError,
  mismaFecha,
  parsearFechaDeNacimiento,
} from '@/modules/users/edad';

/**
 * La mayoría de edad.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO SE PRUEBA CON TANTO DETALLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es aritmética de fechas, que es donde viven los errores de borde: el que
 * cumple hoy, el 29 de febrero, el mes que empieza en cero, el huso horario que
 * corre la fecha un día.
 *
 * Y lo que está en juego no es cosmético. Un error de un día para el lado
 * equivocado deja comprar a alguien que legalmente no puede contratar; para el
 * otro lado, le niega la app a alguien que cumplió 18 esta mañana.
 */

/** Un día cualquiera, fijo. Los tests no pueden depender del reloj. */
const HOY = new Date(Date.UTC(2026, 7, 15)); // 15 de agosto de 2026

describe('Cuántos años tiene', () => {
  it('cuenta los años cumplidos', () => {
    expect(edadEn(new Date(Date.UTC(1990, 4, 20)), HOY)).toBe(36);
    expect(edadEn(new Date(Date.UTC(2000, 0, 1)), HOY)).toBe(26);
  });

  it('el día del cumpleaños ya cuenta', () => {
    /**
     * Alguien que cumple 18 hoy es mayor HOY, no mañana. Es la diferencia entre
     * que la app le funcione el día de su cumpleaños o que le diga que es menor
     * mientras sopla las velitas.
     */
    const cumpleHoy = new Date(Date.UTC(2008, 7, 15));

    expect(edadEn(cumpleHoy, HOY)).toBe(18);
    expect(esMayorDeEdad(cumpleHoy, HOY)).toBe(true);
  });

  it('⛔ un día antes del cumpleaños todavía no', () => {
    const cumpleManiana = new Date(Date.UTC(2008, 7, 16));

    expect(edadEn(cumpleManiana, HOY)).toBe(17);
    expect(esMayorDeEdad(cumpleManiana, HOY)).toBe(false);
  });

  it('⛔ el mismo año no alcanza: se compara mes y día', () => {
    /**
     * El error clásico es `hoy.getFullYear() - nacimiento.getFullYear()`. Con
     * eso, alguien nacido en diciembre de 2008 sería mayor desde el 1 de enero
     * de 2026 — once meses antes de cumplirlos.
     */
    const naceEnDiciembre = new Date(Date.UTC(2008, 11, 31));

    expect(edadEn(naceEnDiciembre, HOY)).toBe(17);
    expect(esMayorDeEdad(naceEnDiciembre, HOY)).toBe(false);
  });

  it('el 29 de febrero cumple el 1 de marzo en los años no bisiestos', () => {
    /**
     * 2026 no es bisiesto. Es la lectura conservadora y coincide con la
     * práctica registral argentina: si el día no existe, se cumple al
     * siguiente.
     */
    const bisiesto = new Date(Date.UTC(2008, 1, 29));

    expect(esMayorDeEdad(bisiesto, new Date(Date.UTC(2026, 1, 28)))).toBe(false);
    expect(esMayorDeEdad(bisiesto, new Date(Date.UTC(2026, 2, 1)))).toBe(true);
  });

  it('la constante dice 18', () => {
    // Si alguien la cambia, este test lo hace visible en la revisión en vez de
    // que se cuele.
    expect(MAYORIA_DE_EDAD).toBe(18);
  });
});

describe('Si la fecha es posible', () => {
  it('acepta una fecha normal', () => {
    expect(fechaDeNacimientoInvalida(new Date(Date.UTC(1990, 4, 20)), HOY)).toBeNull();
  });

  it('⛔ rechaza el futuro', () => {
    expect(fechaDeNacimientoInvalida(new Date(Date.UTC(2027, 0, 1)), HOY)).toBe('FUTURO');
  });

  it('⛔ rechaza un año absurdo', () => {
    // Un `1899` tipeado de más, o un año de cuatro dígitos al azar.
    expect(fechaDeNacimientoInvalida(new Date(Date.UTC(1800, 0, 1)), HOY)).toBe(
      'DEMASIADO_VIEJA',
    );
  });

  it('acepta a alguien muy viejo pero posible', () => {
    // La persona más vieja documentada vivió 122 años. El límite es 130.
    const anio = HOY.getUTCFullYear() - (EDAD_MAXIMA_RAZONABLE - 5);
    expect(fechaDeNacimientoInvalida(new Date(Date.UTC(anio, 0, 1)), HOY)).toBeNull();
  });

  it('⛔ una fecha inválida no se confunde con una válida', () => {
    expect(fechaDeNacimientoInvalida(new Date(NaN), HOY)).toBe('NO_ES_FECHA');
  });
});

describe('Leer AAAA-MM-DD', () => {
  it('lee una fecha bien escrita', () => {
    const f = parsearFechaDeNacimiento('2008-03-15');

    expect(f.getUTCFullYear()).toBe(2008);
    expect(f.getUTCMonth()).toBe(2);
    expect(f.getUTCDate()).toBe(15);
  });

  it('⛔ el 31 de febrero no se convierte en marzo', () => {
    /**
     * `Date.UTC(2008, 1, 31)` no falla: devuelve el 2 de marzo. Sin la
     * comprobación de ida y vuelta, la persona vería guardada una fecha que no
     * escribió.
     */
    expect(Number.isNaN(parsearFechaDeNacimiento('2008-02-31').getTime())).toBe(true);
  });

  it('⛔ rechaza formatos que no son AAAA-MM-DD', () => {
    for (const malo of ['15/03/2008', '2008-3-15', '2008-03', 'ayer', '', '20080315']) {
      expect(
        Number.isNaN(parsearFechaDeNacimiento(malo).getTime()),
        `debería rechazar ${JSON.stringify(malo)}`,
      ).toBe(true);
    }
  });

  it('⛔ el mes 13 y el día 0 no existen', () => {
    expect(Number.isNaN(parsearFechaDeNacimiento('2008-13-01').getTime())).toBe(true);
    expect(Number.isNaN(parsearFechaDeNacimiento('2008-01-00').getTime())).toBe(true);
    expect(Number.isNaN(parsearFechaDeNacimiento('2008-00-10').getTime())).toBe(true);
  });

  it('no se corre un día por el huso horario', () => {
    /**
     * Es el bug que este parseo existe para impedir. En Buenos Aires, UTC-3, una
     * fecha construida en hora local y leída en UTC —o al revés— cae en el día
     * anterior. Toda la aritmética usa `getUTC*` y el parseo construye con
     * `Date.UTC`, así que el día que entra es el día que sale.
     */
    const f = parsearFechaDeNacimiento('2008-01-01');
    expect(f.toISOString().slice(0, 10)).toBe('2008-01-01');
  });

  it('compara dos fechas ignorando la hora', () => {
    const a = parsearFechaDeNacimiento('1990-05-20');
    const b = new Date(Date.UTC(1990, 4, 20, 13, 45, 0));

    expect(mismaFecha(a, b)).toBe(true);
    expect(mismaFecha(a, parsearFechaDeNacimiento('1990-05-21'))).toBe(false);
  });
});

describe('El bloqueo', () => {
  it('⛔ sin fecha cargada, no se puede comprar', () => {
    expect(() => exigirMayoriaDeEdad(null, 'comprar', HOY)).toThrow(
      FaltaLaFechaDeNacimientoError,
    );
  });

  it('⛔ un menor no puede comprar ni vender', () => {
    const menor = new Date(Date.UTC(2012, 0, 1));

    expect(() => exigirMayoriaDeEdad(menor, 'comprar', HOY)).toThrow(MenorDeEdadError);
    expect(() => exigirMayoriaDeEdad(menor, 'vender', HOY)).toThrow(MenorDeEdadError);
  });

  it('un mayor pasa', () => {
    expect(() =>
      exigirMayoriaDeEdad(new Date(Date.UTC(1990, 4, 20)), 'comprar', HOY),
    ).not.toThrow();
  });

  it('⛔ una fecha imposible se rechaza como tal, no como menor de edad', () => {
    /**
     * Son dos rechazos distintos y la persona necesita mensajes distintos.
     * Alguien que se equivocó de año no tiene que leer que la app lo está
     * tratando de menor.
     */
    expect(() => exigirMayoriaDeEdad(new Date(Date.UTC(2030, 0, 1)), 'comprar', HOY)).toThrow(
      FechaDeNacimientoInvalidaError,
    );
  });

  it('los mensajes le hablan a quien los lee', () => {
    /**
     * El de "menor" lo lee alguien de dieciséis que no hizo nada malo. No lo
     * trata de infractor y dice por qué existe la regla.
     */
    const menor = new Date(Date.UTC(2012, 0, 1));

    let mensajeComprar = '';
    try {
      exigirMayoriaDeEdad(menor, 'comprar', HOY);
    } catch (e) {
      mensajeComprar = (e as Error).message;
    }

    expect(mensajeComprar).toContain('18');
    expect(mensajeComprar).toContain('requisito legal');
    // Y no lo acusa de nada.
    expect(mensajeComprar.toLowerCase()).not.toContain('no cumplís con nuestros términos');

    let mensajeVender = '';
    try {
      exigirMayoriaDeEdad(menor, 'vender', HOY);
    } catch (e) {
      mensajeVender = (e as Error).message;
    }
    // El texto distingue comprar de vender: quien lo lee tiene que reconocer
    // qué estaba intentando hacer.
    expect(mensajeVender).toContain('vender');
    expect(mensajeVender).not.toBe(mensajeComprar);
  });

  it('el error de falta de fecha dice para qué se pide', () => {
    let mensaje = '';
    try {
      exigirMayoriaDeEdad(null, 'vender', HOY);
    } catch (e) {
      mensaje = (e as Error).message;
    }

    expect(mensaje).toContain('tienda');
    expect(mensaje).toContain('18');
  });
});
