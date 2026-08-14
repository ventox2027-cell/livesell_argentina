import { describe, expect, it } from 'vitest';

import { comoHora, estaAbierta, minutosLocales, type Franja } from '@/modules/stores/horario';

/**
 * Horarios de tienda.
 *
 * Todos los errores de horarios están en los bordes: la medianoche, el cruce de
 * día, el domingo a las 23:59, la zona horaria del servidor. Como el cálculo es
 * puro, probar cada uno cuesta tres líneas.
 */

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';

/** Un instante concreto en Buenos Aires, para no depender del reloj. */
function enBuenosAires(iso: string): Date {
  // Buenos Aires es UTC-3 todo el año desde 2009.
  return new Date(`${iso}-03:00`);
}

const LUNES_10 = enBuenosAires('2026-08-17T10:00:00');
const LUNES_23 = enBuenosAires('2026-08-17T23:00:00');
const MARTES_01 = enBuenosAires('2026-08-18T01:00:00');
const DOMINGO_12 = enBuenosAires('2026-08-16T12:00:00');

const NUEVE_A_DIECIOCHO = (dia: number): Franja => ({
  weekday: dia,
  opensAtMinutes: 9 * 60,
  closesAtMinutes: 18 * 60,
});

describe('minutosLocales', () => {
  it('usa la zona de la TIENDA, no la del servidor', () => {
    /**
     * El bug que esto previene es silencioso: con el backend en São Paulo
     * —una hora adelante— una tienda que cierra a las 20:00 cerraría a las
     * 19:00 para sus clientes, todos los días, sin que nada falle.
     */
    const instante = new Date('2026-08-17T13:00:00Z'); // 10:00 en Buenos Aires

    expect(minutosLocales(instante, BUENOS_AIRES).minutos).toBe(10 * 60);
    expect(minutosLocales(instante, 'America/Sao_Paulo').minutos).toBe(10 * 60); // igual huso
    expect(minutosLocales(instante, 'Europe/Madrid').minutos).toBe(15 * 60);
  });

  it('el domingo es 0 y el sábado es 6', () => {
    expect(minutosLocales(DOMINGO_12, BUENOS_AIRES).dia).toBe(0);
    expect(minutosLocales(LUNES_10, BUENOS_AIRES).dia).toBe(1);
    expect(minutosLocales(enBuenosAires('2026-08-22T12:00:00'), BUENOS_AIRES).dia).toBe(6);
  });

  it('la medianoche es 0, no 1440', () => {
    // `hour12: false` devuelve "24" en algunos motores. Sin normalizar, la
    // medianoche daría 1440 y quedaría fuera de toda franja.
    const medianoche = enBuenosAires('2026-08-17T00:00:00');
    expect(minutosLocales(medianoche, BUENOS_AIRES).minutos).toBe(0);
  });
});

describe('siempre abierta', () => {
  it('abre a cualquier hora, sin franjas', () => {
    const r = estaAbierta({
      modo: 'ALWAYS_OPEN',
      zona: BUENOS_AIRES,
      franjas: [],
      hayLive: false,
      ahora: enBuenosAires('2026-08-17T03:00:00'),
    });
    expect(r.abierta).toBe(true);
  });
});

describe('sólo en vivo', () => {
  it('abierta mientras transmite', () => {
    const r = estaAbierta({
      modo: 'LIVE_ONLY',
      zona: BUENOS_AIRES,
      franjas: [],
      hayLive: true,
      ahora: LUNES_10,
    });
    expect(r.abierta).toBe(true);
  });

  it('cerrada cuando no', () => {
    const r = estaAbierta({
      modo: 'LIVE_ONLY',
      zona: BUENOS_AIRES,
      franjas: [],
      hayLive: false,
      ahora: LUNES_10,
    });
    expect(r.abierta).toBe(false);
    expect(r.motivo).toContain('sólo en vivo');
  });

  it('no inventa cuándo vuelve a abrir', () => {
    // No se puede saber cuándo va a transmitir. Una hora inventada sería peor
    // que no decir nada.
    const r = estaAbierta({
      modo: 'LIVE_ONLY',
      zona: BUENOS_AIRES,
      franjas: [],
      hayLive: false,
      ahora: LUNES_10,
    });
    expect(r.abreEl).toBeNull();
  });
});

describe('por horarios', () => {
  it('abierta dentro de la franja', () => {
    const r = estaAbierta({
      modo: 'SCHEDULED',
      zona: BUENOS_AIRES,
      franjas: [NUEVE_A_DIECIOCHO(1)],
      hayLive: false,
      ahora: LUNES_10,
    });
    expect(r.abierta).toBe(true);
  });

  it('cerrada fuera de la franja', () => {
    const r = estaAbierta({
      modo: 'SCHEDULED',
      zona: BUENOS_AIRES,
      franjas: [NUEVE_A_DIECIOCHO(1)],
      hayLive: false,
      ahora: LUNES_23,
    });
    expect(r.abierta).toBe(false);
    expect(r.motivo).toBe('Cerrada por horario');
  });

  it('el minuto de apertura cuenta, el de cierre no', () => {
    /**
     * Una franja de 9 a 18 abre a las 9:00 en punto y cierra a las 18:00 en
     * punto. Si el cierre fuera inclusivo, dos franjas contiguas —de 9 a 13 y
     * de 13 a 18— se solaparían un minuto, y ese minuto es exactamente donde
     * aparecen los errores raros.
     */
    const base = {
      modo: 'SCHEDULED' as const,
      zona: BUENOS_AIRES,
      franjas: [NUEVE_A_DIECIOCHO(1)],
      hayLive: false,
    };

    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T09:00:00') }).abierta).toBe(true);
    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T17:59:00') }).abierta).toBe(true);
    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T18:00:00') }).abierta).toBe(false);
    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T08:59:00') }).abierta).toBe(false);
  });

  it('sin franjas cargadas queda CERRADA, no abierta', () => {
    /**
     * La interpretación segura. Quien eligió "por horarios" y no cargó ninguno
     * no dijo "abierta siempre": dijo que quiere horarios. Abrirla por omisión
     * la dejaría vendiendo a las cuatro de la mañana sin que nadie lo decidiera.
     */
    const r = estaAbierta({
      modo: 'SCHEDULED',
      zona: BUENOS_AIRES,
      franjas: [],
      hayLive: false,
      ahora: LUNES_10,
    });
    expect(r.abierta).toBe(false);
    expect(r.motivo).toContain('todavía no configuró');
  });

  it('el corte del mediodía son dos franjas, no un campo aparte', () => {
    const franjas: Franja[] = [
      { weekday: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 13 * 60 },
      { weekday: 1, opensAtMinutes: 16 * 60, closesAtMinutes: 20 * 60 },
    ];
    const base = { modo: 'SCHEDULED' as const, zona: BUENOS_AIRES, franjas, hayLive: false };

    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T10:00:00') }).abierta).toBe(true);
    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T14:00:00') }).abierta).toBe(false);
    expect(estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T17:00:00') }).abierta).toBe(true);
  });

  describe('franjas que cruzan la medianoche', () => {
    /**
     * "Sábado de 22:00 a 02:00" cubre dos días. Tratarla como un solo día
     * dejaría a quien vende de noche cerrado justo en su mejor horario.
     */
    const NOCTURNA: Franja = { weekday: 1, opensAtMinutes: 22 * 60, closesAtMinutes: 2 * 60 };
    const base = {
      modo: 'SCHEDULED' as const,
      zona: BUENOS_AIRES,
      franjas: [NOCTURNA],
      hayLive: false,
    };

    it('abierta el lunes a las 23', () => {
      expect(estaAbierta({ ...base, ahora: LUNES_23 }).abierta).toBe(true);
    });

    it('sigue abierta el martes a la 1', () => {
      expect(estaAbierta({ ...base, ahora: MARTES_01 }).abierta).toBe(true);
    });

    it('cerrada el martes a las 3', () => {
      expect(
        estaAbierta({ ...base, ahora: enBuenosAires('2026-08-18T03:00:00') }).abierta,
      ).toBe(false);
    });

    it('cerrada el lunes a las 21', () => {
      expect(
        estaAbierta({ ...base, ahora: enBuenosAires('2026-08-17T21:00:00') }).abierta,
      ).toBe(false);
    });

    it('y funciona en el borde domingo → lunes', () => {
      // El caso que rompe un `weekday - 1` sin módulo: el día anterior al
      // domingo es el sábado, no el -1.
      const DOMINGO_NOCTURNA: Franja = {
        weekday: 6,
        opensAtMinutes: 22 * 60,
        closesAtMinutes: 2 * 60,
      };
      const r = estaAbierta({
        modo: 'SCHEDULED',
        zona: BUENOS_AIRES,
        franjas: [DOMINGO_NOCTURNA],
        hayLive: false,
        ahora: enBuenosAires('2026-08-23T01:00:00'), // domingo 1 AM
      });
      expect(r.abierta).toBe(true);
    });
  });

  describe('próxima apertura', () => {
    it('dice cuándo abre hoy si todavía no abrió', () => {
      const r = estaAbierta({
        modo: 'SCHEDULED',
        zona: BUENOS_AIRES,
        franjas: [NUEVE_A_DIECIOCHO(1)],
        hayLive: false,
        ahora: enBuenosAires('2026-08-17T07:00:00'),
      });

      expect(r.abierta).toBe(false);
      expect(r.abreEl).not.toBeNull();
      // Dos horas después.
      expect(r.abreEl!.getTime() - enBuenosAires('2026-08-17T07:00:00').getTime()).toBe(
        2 * 3600 * 1000,
      );
    });

    it('salta al día siguiente si ya cerró', () => {
      const r = estaAbierta({
        modo: 'SCHEDULED',
        zona: BUENOS_AIRES,
        franjas: [NUEVE_A_DIECIOCHO(1), NUEVE_A_DIECIOCHO(2)],
        hayLive: false,
        ahora: LUNES_23,
      });

      expect(r.abreEl).not.toBeNull();
      // Martes a las 9: diez horas después de las 23 del lunes.
      expect(r.abreEl!.getTime() - LUNES_23.getTime()).toBe(10 * 3600 * 1000);
    });

    it('da la vuelta a la semana', () => {
      // Abre sólo los lunes; estamos el martes. Tiene que encontrar el lunes
      // que viene, no rendirse.
      const r = estaAbierta({
        modo: 'SCHEDULED',
        zona: BUENOS_AIRES,
        franjas: [NUEVE_A_DIECIOCHO(1)],
        hayLive: false,
        ahora: enBuenosAires('2026-08-18T12:00:00'),
      });
      expect(r.abreEl).not.toBeNull();
    });

    it('elige la franja MÁS CERCANA, no la primera cargada', () => {
      const franjas: Franja[] = [
        { weekday: 1, opensAtMinutes: 16 * 60, closesAtMinutes: 20 * 60 },
        { weekday: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 13 * 60 },
      ];
      const r = estaAbierta({
        modo: 'SCHEDULED',
        zona: BUENOS_AIRES,
        franjas,
        hayLive: false,
        ahora: enBuenosAires('2026-08-17T07:00:00'),
      });

      // Las 9, no las 16.
      expect(r.abreEl!.getTime() - enBuenosAires('2026-08-17T07:00:00').getTime()).toBe(
        2 * 3600 * 1000,
      );
    });
  });
});

describe('comoHora', () => {
  it('formatea con dos dígitos', () => {
    expect(comoHora(0)).toBe('00:00');
    expect(comoHora(9 * 60)).toBe('09:00');
    expect(comoHora(13 * 60 + 30)).toBe('13:30');
    expect(comoHora(23 * 60 + 59)).toBe('23:59');
  });
});
