import { describe, expect, it } from 'vitest';

import {
  AVISO_ANTES_MINUTOS,
  cuandoEnCastellano,
  exigirFechaValida,
  MAXIMO_DE_ANTICIPACION_DIAS,
  MINIMO_DE_ANTICIPACION_MINUTOS,
  toca_avisar,
} from '@/modules/live/agenda';
import { AVISOS_QUE_NO_SE_APAGAN, estadoDeCategorias, tiposDe } from '@/modules/notifications/categorias';

/**
 * Las reglas de la agenda y de las categorías de aviso.
 *
 * Los dos son módulos puros: reglas de tiempo y de configuración que se pueden
 * probar con un reloj inventado, sin base y sin esperar quince minutos.
 */

const AHORA = new Date('2026-08-15T20:00:00.000Z');
const enMinutos = (m: number) => new Date(AHORA.getTime() + m * 60_000);

describe('Programar un vivo', () => {
  it('una fecha razonable se acepta', () => {
    expect(() => exigirFechaValida(enMinutos(120), AHORA)).not.toThrow();
  });

  it('⛔ demasiado cerca se rechaza', () => {
    /**
     * Con menos de quince minutos, el aviso previo se manda casi junto con el
     * vivo y la gente que lo recibe no tiene tiempo de acomodarse.
     *
     * Y hay un camino mejor para eso: si querés empezar ahora, tocás Iniciar
     * LIVE. El mensaje del error lo dice.
     */
    expect(() => exigirFechaValida(enMinutos(5), AHORA)).toThrow(/anticipación/);
    expect(() => exigirFechaValida(enMinutos(MINIMO_DE_ANTICIPACION_MINUTOS - 1), AHORA)).toThrow();
  });

  it('⛔ en el pasado, también', () => {
    expect(() => exigirFechaValida(enMinutos(-60), AHORA)).toThrow();
  });

  it('⛔ demasiado lejos se rechaza', () => {
    // Un vendedor que programa para dentro de tres meses casi seguro se
    // equivocó de año al elegir la fecha.
    const lejos = new Date(AHORA.getTime() + (MAXIMO_DE_ANTICIPACION_DIAS + 1) * 24 * 3_600_000);
    expect(() => exigirFechaValida(lejos, AHORA)).toThrow(/días/);
  });

  it('el borde exacto entra', () => {
    expect(() => exigirFechaValida(enMinutos(MINIMO_DE_ANTICIPACION_MINUTOS), AHORA)).not.toThrow();
  });
});

describe('Cuándo avisar', () => {
  it('dentro de la ventana, sí', () => {
    expect(toca_avisar(enMinutos(AVISO_ANTES_MINUTOS - 1), AHORA)).toBe(true);
    expect(toca_avisar(enMinutos(1), AHORA)).toBe(true);
  });

  it('⛔ todavía falta mucho, no', () => {
    // Con una hora de anticipación, para cuando empieza ya se olvidó.
    expect(toca_avisar(enMinutos(60), AHORA)).toBe(false);
  });

  it('⛔ un vivo cuya hora ya pasó hace rato NO entra en «está por empezar»', () => {
    /**
     * Sin un piso inferior, un vivo programado que nunca arrancó seguiría
     * entrando en la ventana del barrido para siempre y avisaría en cada
     * corrida.
     */
    expect(toca_avisar(enMinutos(-30), AHORA)).toBe(false);
  });

  it('pero uno que empezó recién sí, por si el barrido se demoró', () => {
    expect(toca_avisar(enMinutos(-2), AHORA)).toBe(true);
  });
});

describe('Cómo se dice cuándo es', () => {
  /**
   * Relativo y no una fecha absoluta. «En 2 horas» se entiende sin pensar;
   * «20:30» obliga a mirar el reloj y restar, y si además cae mañana, a mirar
   * el calendario.
   */
  it('minutos, horas, mañana y días', () => {
    expect(cuandoEnCastellano(enMinutos(20), AHORA)).toBe('En 20 min');
    expect(cuandoEnCastellano(enMinutos(120), AHORA)).toBe('En 2 horas');
    expect(cuandoEnCastellano(enMinutos(60), AHORA)).toBe('En 1 hora');
    expect(cuandoEnCastellano(enMinutos(60 * 24), AHORA)).toBe('Mañana');
    expect(cuandoEnCastellano(enMinutos(60 * 24 * 3), AHORA)).toBe('En 3 días');
  });

  it('ya empezó', () => {
    expect(cuandoEnCastellano(enMinutos(-1), AHORA)).toBe('Empieza ahora');
  });
});

describe('Categorías de aviso', () => {
  it('⛔ los avisos de plata NO se pueden apagar', () => {
    /**
     * Un pedido que cambia de estado y un pago rechazado no son novedades: son
     * cosas que le pasan a la plata de una persona. Una app que deja apagarlos
     * deja a alguien sin enterarse de que su compra se cayó, con el producto
     * sin reservar y sin saber por qué.
     */
    for (const tipo of ['ORDER_STATUS', 'PAYMENT_REJECTED', 'PAYMENT_APPROVED', 'ORDER_RECEIVED']) {
      expect(AVISOS_QUE_NO_SE_APAGAN.has(tipo as never), tipo).toBe(true);
    }
  });

  it('⛔ y ninguno de los que SÍ se apagan está en esa lista', () => {
    // Si un tipo estuviera en las dos, la pantalla mostraría un interruptor
    // que no hace nada.
    for (const clave of ['vivos', 'guardados', 'opiniones', 'tiendas']) {
      for (const tipo of tiposDe(clave)) {
        expect(AVISOS_QUE_NO_SE_APAGAN.has(tipo), `${clave}/${tipo}`).toBe(false);
      }
    }
  });

  it('sin nada apagado, todas encendidas', () => {
    // Quien nunca entró a esta pantalla recibe todo.
    const estado = estadoDeCategorias([]);
    expect(estado.every((c) => c.activa)).toBe(true);
  });

  it('⛔ una categoría nueva nace ENCENDIDA', () => {
    /**
     * Es la consecuencia de guardar lo apagado y no lo encendido.
     *
     * Con una lista de encendidos, agregar «opiniones» al sistema la dejaría
     * apagada para todos los que ya existían, y habría que acordarse de un
     * backfill en cada release.
     */
    const estado = estadoDeCategorias(['LIVE_STARTED', 'LIVE_SOON']);
    const opiniones = estado.find((c) => c.clave === 'opiniones');
    expect(opiniones?.activa).toBe(true);
  });

  it('apagar una categoría apaga todos sus tipos', () => {
    const estado = estadoDeCategorias(['LIVE_STARTED', 'LIVE_SOON']);
    expect(estado.find((c) => c.clave === 'vivos')?.activa).toBe(false);
  });

  it('con la mitad apagada, se muestra encendida', () => {
    /**
     * Pasa cuando agregamos un tipo nuevo a un grupo existente. Se muestra
     * encendida y volver a apagarla apaga todo: lo nuevo llega encendido y se
     * apaga con un toque, que es el comportamiento menos sorprendente.
     */
    const estado = estadoDeCategorias(['LIVE_STARTED']);
    expect(estado.find((c) => c.clave === 'vivos')?.activa).toBe(true);
  });

  it('los grupos tienen nombres de persona, no técnicos', () => {
    // Una pantalla con «REVIEW_ANSWERED» y «SAVED_BACK_IN_STOCK» es una que
    // nadie configura: hay que leer los ocho para entender cuál apagar.
    const estado = estadoDeCategorias([]);
    for (const c of estado) {
      expect(c.nombre).not.toMatch(/[A-Z]{3,}_/);
      expect(c.detalle.length).toBeGreaterThan(20);
    }
  });
});
