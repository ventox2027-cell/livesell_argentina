import { describe, expect, it } from 'vitest';

import { tasaPara, tramosDeBusiness } from '@/modules/sellers/comision-por-volumen';
import { superaElUmbral, type MedicionDeVolumen } from '@/modules/sellers/volumen';

/**
 * La comisión por volumen de Business.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ACÁ SE DECIDE CUÁNTA PLATA SE LE COBRA A CADA VENDEDOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Medio punto de comisión sobre tres millones semanales son quince mil pesos
 * por semana, por vendedor. Un `>=` mal puesto no rompe nada visible: cobra mal
 * en silencio, para siempre, y el error queda congelado en cada orden.
 *
 * Por eso todo esto se prueba como tabla y no montando vendedores: la decisión
 * es pura y los bordes se pueden recorrer uno por uno.
 */

const BASE = 400;
const UMBRAL = 1_000;

/** Una medición con el promedio pedido y sin devoluciones. */
function medicion(promedioSemanal: number, devuelto = 0): MedicionDeVolumen {
  const brutoConfirmado = promedioSemanal * 4 + devuelto;
  return {
    brutoConfirmado,
    devuelto,
    volumenElegible: promedioSemanal * 4,
    promedioSemanal,
    tasaDeDevolucionBps:
      brutoConfirmado === 0 ? 0 : Math.floor((devuelto * 10_000) / brutoConfirmado),
  };
}

function tasa(plan: 'FREE' | 'PRO' | 'BUSINESS', promedio: number, devuelto = 0) {
  return tasaPara({
    plan,
    bpsBase: BASE,
    medicion: medicion(promedio, devuelto),
    umbralDeDevolucionesBps: UMBRAL,
  });
}

describe('Los tramos son sólo de Business', () => {
  it('un Free paga la tasa base aunque venda mucho', () => {
    const r = tasa('FREE', 900_000_000);

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('PLAN_SIN_TRAMOS');
  });

  /**
   * Que Pro NO acceda es la razón de existir de Business. Si un Pro con volumen
   * pagara 3 %, nadie tendría motivo para pagar el plan caro.
   */
  it('⛔ un Pro tampoco, por mucho que venda', () => {
    const r = tasa('PRO', 900_000_000);

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('PLAN_SIN_TRAMOS');
  });
});

describe('Los tramos de Business', () => {
  it('sin volumen suficiente paga la base', () => {
    const r = tasa('BUSINESS', 100_000_000);

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('VOLUMEN_INSUFICIENTE');
  });

  /**
   * EL BORDE DE ABAJO. Exactamente $3.000.000 semanales alcanzan el tramo: la
   * regla dice «a partir de», y un `>` en vez de un `>=` deja afuera justo a
   * quien llegó al número redondo.
   */
  it('justo en $3.000.000 semanales, 3,5 %', () => {
    const r = tasa('BUSINESS', 300_000_000);

    expect(r.bps).toBe(350);
    expect(r.motivo).toBe('VOLUMEN_BUSINESS');
  });

  it('⛔ un centavo por debajo de $3.000.000, todavía 4 %', () => {
    const r = tasa('BUSINESS', 299_999_999);

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('VOLUMEN_INSUFICIENTE');
  });

  it('entre $3.000.000 y $5.000.000, 3,5 %', () => {
    expect(tasa('BUSINESS', 400_000_000).bps).toBe(350);
    expect(tasa('BUSINESS', 499_999_999).bps).toBe(350);
  });

  it('justo en $5.000.000 semanales, 3 %', () => {
    const r = tasa('BUSINESS', 500_000_000);

    expect(r.bps).toBe(300);
    expect(r.motivo).toBe('VOLUMEN_BUSINESS');
  });

  it('por encima de $5.000.000 sigue en 3 %: no hay un cuarto tramo', () => {
    expect(tasa('BUSINESS', 50_000_000_000).bps).toBe(300);
  });

  /**
   * Los tramos se recorren de mayor a menor y se toma el primero que alcanza.
   * Escritos al revés, todo el mundo con volumen caería en el primer tramo y
   * nadie llegaría nunca al 3 %.
   */
  it('los tramos están de mayor a menor exigencia', () => {
    const tramos = tramosDeBusiness();

    for (let i = 1; i < tramos.length; i += 1) {
      expect(tramos[i]!.desde).toBeLessThan(tramos[i - 1]!.desde);
      expect(tramos[i]!.bps).toBeGreaterThan(tramos[i - 1]!.bps);
    }
  });

  /**
   * ⚠️ Un tramo nunca SUBE la comisión.
   *
   * Si alguien bajara `VENDOX_PLATFORM_FEE_BPS` por debajo de un tramo, el
   * vendedor con volumen no puede terminar pagando más que el que no vende.
   * Bajarle la comisión a alguien es una decisión comercial; subírsela sin
   * avisar es otra cosa.
   */
  it('⛔ si la base fuera más barata que el tramo, gana la base', () => {
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: 250,
      medicion: medicion(900_000_000),
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.bps).toBe(250);
    expect(r.motivo).toBe('VOLUMEN_INSUFICIENTE');
  });
});

describe('La salvaguarda por devoluciones', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * QUÉ PROBLEMA RESUELVE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Sin esto, el descuento por volumen se puede fabricar: alcanza con inflar la
   * ventana de 28 días con órdenes que después se devuelven. La orden inflada
   * vuelve; el descuento que consiguió queda congelado en las órdenes reales de
   * esa misma ventana.
   */
  it('con devoluciones por debajo del umbral, el tramo se conserva', () => {
    // $12.000.000 de bruto, $1.000.000 devueltos: 8,33 %.
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 1_200_000_000,
        devuelto: 100_000_000,
        volumenElegible: 1_100_000_000,
        promedioSemanal: 300_000_000,
        tasaDeDevolucionBps: 833,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.bps).toBe(350);
    expect(r.motivo).toBe('VOLUMEN_BUSINESS');
  });

  /**
   * EL BORDE EXACTO. La regla dice «si SUPERA el 10 %», y el 10 % clavado no
   * supera nada. En un umbral, el empate va para el vendedor.
   */
  it('justo en el 10 % NO pierde el tramo', () => {
    // $20.000.000 de bruto, $2.000.000 devueltos: exactamente 10 %.
    // Quedan $18.000.000 en cuatro semanas = $4.500.000 semanales, tramo 3,5 %.
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 2_000_000_000,
        devuelto: 200_000_000,
        volumenElegible: 1_800_000_000,
        promedioSemanal: 450_000_000,
        tasaDeDevolucionBps: 1_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.bps).toBe(350);
    expect(r.motivo).toBe('VOLUMEN_BUSINESS');
  });

  it('⛔ un centavo por encima del 10 % sí lo pierde', () => {
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 2_000_000_000,
        devuelto: 200_000_001,
        volumenElegible: 1_799_999_999,
        promedioSemanal: 449_999_999,
        tasaDeDevolucionBps: 1_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('DEVOLUCIONES_ALTAS');
    expect(r.bpsQueHabriaTenido).toBe(350);
  });

  /**
   * ⚠️ Nótese que en el test de arriba `tasaDeDevolucionBps` dice 1000 —porque
   * se trunca— y aun así se aplica la salvaguarda.
   *
   * Es a propósito: el número redondeado es para mostrarle al vendedor, y la
   * comparación se hace con enteros sin dividir. Si la decisión mirara el bps
   * truncado, todo lo que va del 10,00 % al 10,009 % se escaparía.
   */
  it('la comparación no usa el bps redondeado', () => {
    expect(superaElUmbral({ brutoConfirmado: 1_000_000_000, devuelto: 100_000_001 }, 1_000)).toBe(
      true,
    );
    expect(superaElUmbral({ brutoConfirmado: 1_000_000_000, devuelto: 100_000_000 }, 1_000)).toBe(
      false,
    );
  });

  /**
   * Guardar a qué tramo habría llegado es lo que hace la diferencia entre un
   * registro contable y «no accediste al descuento». Cuando el vendedor
   * pregunte, la respuesta tiene que ser «tenías 3 % y quedaste en 4 % porque
   * devolviste el 15 %».
   */
  it('registra a qué tramo habría llegado', () => {
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 3_000_000_000,
        devuelto: 600_000_000,
        volumenElegible: 2_400_000_000,
        promedioSemanal: 600_000_000,
        tasaDeDevolucionBps: 2_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.motivo).toBe('DEVOLUCIONES_ALTAS');
    expect(r.bps).toBe(400);
    // Habría estado en el tramo de 3 %: son 100 bps de diferencia.
    expect(r.bpsQueHabriaTenido).toBe(300);
    expect(r.tasaDeDevolucionBps).toBe(2_000);
  });

  /**
   * La salvaguarda sólo quita lo que el volumen daba. A un Business sin volumen
   * suficiente, devolver mucho no le cambia nada — ya pagaba la base — y el
   * motivo registrado tiene que decir la verdad sobre por qué.
   */
  it('⛔ sin volumen suficiente el motivo sigue siendo el volumen, no las devoluciones', () => {
    const r = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 100_000_000,
        devuelto: 50_000_000,
        volumenElegible: 50_000_000,
        promedioSemanal: 12_500_000,
        tasaDeDevolucionBps: 5_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('VOLUMEN_INSUFICIENTE');
    expect(r.bpsQueHabriaTenido).toBeNull();
  });

  it('⛔ un Free o un Pro con devoluciones altas no cambia de motivo', () => {
    const r = tasaPara({
      plan: 'PRO',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 1_000_000_000,
        devuelto: 900_000_000,
        volumenElegible: 100_000_000,
        promedioSemanal: 25_000_000,
        tasaDeDevolucionBps: 9_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });

    expect(r.motivo).toBe('PLAN_SIN_TRAMOS');
  });

  /**
   * No es una sanción permanente ni hace falta que nadie intervenga: la ventana
   * es móvil, así que en cuanto las devoluciones salen de los 28 días el tramo
   * vuelve solo.
   */
  it('cuando la tasa vuelve por debajo, el tramo vuelve', () => {
    const conDevoluciones = tasaPara({
      plan: 'BUSINESS',
      bpsBase: BASE,
      medicion: {
        brutoConfirmado: 1_000_000_000,
        devuelto: 300_000_000,
        volumenElegible: 700_000_000,
        promedioSemanal: 300_000_000,
        tasaDeDevolucionBps: 3_000,
      },
      umbralDeDevolucionesBps: UMBRAL,
    });
    expect(conDevoluciones.motivo).toBe('DEVOLUCIONES_ALTAS');

    const yaLimpio = tasa('BUSINESS', 300_000_000);
    expect(yaLimpio.motivo).toBe('VOLUMEN_BUSINESS');
    expect(yaLimpio.bps).toBe(350);
  });

  /**
   * El umbral entra por parámetro y no se lee de la configuración acá adentro.
   * Es lo que permite ajustarlo por variable de entorno sin tocar código — y lo
   * que hace que estos tests no dependan de qué diga el `.env` de quien corre.
   */
  it('el umbral es configurable, no una constante escondida', () => {
    const medida = {
      brutoConfirmado: 1_000_000_000,
      devuelto: 150_000_000,
      volumenElegible: 850_000_000,
      promedioSemanal: 212_500_000 + 87_500_000,
      tasaDeDevolucionBps: 1_500,
    };

    // Con el umbral en 10 %, el 15 % lo pierde.
    expect(
      tasaPara({ plan: 'BUSINESS', bpsBase: BASE, medicion: medida, umbralDeDevolucionesBps: 1_000 })
        .motivo,
    ).toBe('DEVOLUCIONES_ALTAS');

    // Con el umbral en 20 %, el mismo vendedor lo conserva.
    expect(
      tasaPara({ plan: 'BUSINESS', bpsBase: BASE, medicion: medida, umbralDeDevolucionesBps: 2_000 })
        .motivo,
    ).toBe('VOLUMEN_BUSINESS');
  });
});

describe('Sin historial no se castiga a nadie', () => {
  it('un vendedor sin ventas no supera ningún umbral', () => {
    expect(superaElUmbral({ brutoConfirmado: 0, devuelto: 0 }, 1_000)).toBe(false);
  });

  it('un Business recién llegado paga la base por volumen, no por devoluciones', () => {
    const r = tasa('BUSINESS', 0);

    expect(r.bps).toBe(400);
    expect(r.motivo).toBe('VOLUMEN_INSUFICIENTE');
    expect(r.tasaDeDevolucionBps).toBe(0);
  });
});
