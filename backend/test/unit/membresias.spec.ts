import { describe, expect, it } from 'vitest';

import {
  DIAS_DE_AVISO_ANTES_DE_VENCER,
  puedePublicarUnoMas,
  beneficiosDe,
  calcularVencimiento,
  diasRestantes,
  limitesDe,
  planVigente,
  tieneBeneficio,
  tocaAvisarQueVence,
} from '@/modules/sellers/membresias';

/**
 * VendoX Pro.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE ESTOS TESTS PROTEGEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un vendedor le paga a VendoX por herramientas. Dos cosas tienen que ser
 * ciertas siempre:
 *
 *   1. Si pagó y no venció, las tiene.
 *   2. Si venció, no las tiene — aunque la fila de la base todavía diga `PRO`.
 *
 * La segunda es la que se rompe sola. Nadie escribe un bug que le saque
 * beneficios a quien pagó; el bug que aparece es el contrario, y sale gratis:
 * alcanza con leer `plan` de la base sin mirar la fecha.
 */

const AHORA = new Date('2026-08-15T21:00:00.000Z');
const enDias = (d: number) => new Date(AHORA.getTime() + d * 24 * 60 * 60 * 1000);

const FREE = { plan: 'FREE' as const, vigenteHasta: null };
const PRO_VIGENTE = { plan: 'PRO' as const, vigenteHasta: enDias(20) };
const PRO_VENCIDO = { plan: 'PRO' as const, vigenteHasta: enDias(-1) };

describe('Qué plan tiene de verdad', () => {
  it('sin membresía, Free', () => {
    // Es el estado de la enorme mayoría: no hay fila hasta que se otorga algo.
    expect(planVigente(null, AHORA)).toBe('FREE');
  });

  it('Pro dentro de la vigencia, Pro', () => {
    expect(planVigente(PRO_VIGENTE, AHORA)).toBe('PRO');
  });

  it('⛔ Pro vencido es Free, aunque la fila diga PRO', () => {
    /**
     * EL TEST QUE IMPORTA.
     *
     * La fila sigue diciendo `PRO` hasta que algo la actualice, y ese algo
     * puede tardar: una tarea que se cayó, un despliegue en el medio, o
     * simplemente que decidimos no tener tarea. Leer `plan` sin mirar la fecha
     * le da herramientas de pago a quien no pagó.
     */
    expect(planVigente(PRO_VENCIDO, AHORA)).toBe('FREE');
  });

  it('⛔ justo en el instante del vencimiento, ya no', () => {
    // Un `>=` acá regala un momento de gracia arbitrario. La fecha es el final.
    expect(planVigente({ plan: 'PRO', vigenteHasta: AHORA }, AHORA)).toBe('FREE');
  });

  it('⛔ Pro sin fecha se trata como vencido, no como eterno', () => {
    /**
     * No se otorga así. Pero si una fila quedara en ese estado —una migración a
     * medias, un `update` sin la fecha— la lectura permisiva daría Pro para
     * siempre y nadie se enteraría.
     */
    expect(planVigente({ plan: 'PRO', vigenteHasta: null }, AHORA)).toBe('FREE');
  });
});

describe('Beneficios', () => {
  it('Free no tiene ninguno', () => {
    expect(beneficiosDe(FREE, AHORA)).toEqual([]);
  });

  it('⛔ Free NO puede usar cupones', () => {
    // Es la regla que el producto define explícitamente: los cupones son Pro.
    expect(tieneBeneficio(FREE, 'CUPONES', AHORA)).toBe(false);
    expect(tieneBeneficio(null, 'CUPONES', AHORA)).toBe(false);
  });

  it('Pro vigente sí', () => {
    expect(tieneBeneficio(PRO_VIGENTE, 'CUPONES', AHORA)).toBe(true);
    expect(tieneBeneficio(PRO_VIGENTE, 'ANALITICA_AVANZADA', AHORA)).toBe(true);
  });

  it('⛔ Pro vencido pierde los cupones', () => {
    expect(tieneBeneficio(PRO_VENCIDO, 'CUPONES', AHORA)).toBe(false);
  });

  it('⛔ la insignia Pro no es el sello de identidad', () => {
    /**
     * Este módulo no sabe nada de verificación, y esa es la garantía: no hay
     * ninguna función acá que pueda leer ni escribir `verificationStatus`.
     *
     * `INSIGNIA_PRO` dice "contrató herramientas". El sello de identidad dice
     * "VendoX comprobó quién es". Venderlo sería exactamente lo que hizo
     * Twitter, y lo que hace que un sello deje de significar algo.
     */
    const beneficios = beneficiosDe(PRO_VIGENTE, AHORA);
    expect(beneficios).toContain('INSIGNIA_PRO');
    expect(JSON.stringify(beneficios).toLowerCase()).not.toContain('verific');
  });
});

describe('Límites', () => {
  it('Free tiene cero cupones activos, no cupones apagados', () => {
    // La diferencia importa para el mensaje: "llegaste al límite de 0" se puede
    // explicar; "función no disponible" no dice qué hacer.
    expect(limitesDe(FREE, AHORA).cuponesActivos).toBe(0);
  });

  it('Pro tiene más historial', () => {
    expect(limitesDe(PRO_VIGENTE, AHORA).diasDeHistorial).toBeGreaterThan(
      limitesDe(FREE, AHORA).diasDeHistorial,
    );
  });

  it('⛔ Pro vencido vuelve a los límites de Free', () => {
    expect(limitesDe(PRO_VENCIDO, AHORA)).toEqual(limitesDe(FREE, AHORA));
  });
});

describe('Cuándo vence lo que se otorga', () => {
  it('sin nada previo, un mes son 30 días', () => {
    expect(calcularVencimiento('MENSUAL', null, AHORA)).toEqual(enDias(30));
  });

  it('un año son 365', () => {
    expect(calcularVencimiento('ANUAL', null, AHORA)).toEqual(enDias(365));
  });

  it('⛔ renovar temprano NO pierde lo que queda', () => {
    /**
     * Alguien con veinte días por delante que renueva tiene que terminar con
     * cincuenta, no con treinta. Reemplazar la fecha en vez de sumar le cobra
     * un mes y le saca veinte días.
     */
    expect(calcularVencimiento('MENSUAL', enDias(20), AHORA)).toEqual(enDias(50));
  });

  it('⛔ pero una membresía vencida no arrastra el saldo negativo', () => {
    // Si venció hace cien días, renovar da treinta desde hoy — no menos setenta.
    expect(calcularVencimiento('MENSUAL', enDias(-100), AHORA)).toEqual(enDias(30));
  });
});

describe('Cuánto le queda', () => {
  it('Free no tiene cuenta regresiva', () => {
    expect(diasRestantes(FREE, AHORA)).toBeNull();
    expect(diasRestantes(null, AHORA)).toBeNull();
  });

  it('⛔ redondea HACIA ARRIBA', () => {
    // Con veinte horas por delante, "te queda 1 día" es cierto y "te quedan 0"
    // no lo es.
    const veinteHoras = new Date(AHORA.getTime() + 20 * 60 * 60 * 1000);
    expect(diasRestantes({ plan: 'PRO', vigenteHasta: veinteHoras }, AHORA)).toBe(1);
  });

  it('vencido no devuelve un número negativo', () => {
    expect(diasRestantes(PRO_VENCIDO, AHORA)).toBeNull();
  });
});

describe('El aviso de que vence', () => {
  it('⛔ con más margen que el umbral, todavía no se avisa', () => {
    const lejos = { plan: 'PRO' as const, vigenteHasta: enDias(DIAS_DE_AVISO_ANTES_DE_VENCER + 3) };
    expect(tocaAvisarQueVence(lejos, AHORA)).toBe(false);
  });

  it('dentro del umbral, sí', () => {
    /**
     * Sin aviso, los cupones del vendedor dejan de funcionar en medio de un
     * vivo y se entera por los compradores.
     */
    const cerca = { plan: 'PRO' as const, vigenteHasta: enDias(2) };
    expect(tocaAvisarQueVence(cerca, AHORA)).toBe(true);
  });

  it('⛔ a un vencido ya no se le avisa que va a vencer', () => {
    // Ya pasó. El aviso correcto es otro, y decirle "vence pronto" a alguien
    // que ya perdió el plan es peor que no decir nada.
    expect(tocaAvisarQueVence(PRO_VENCIDO, AHORA)).toBe(false);
  });

  it('⛔ a un Free tampoco', () => {
    expect(tocaAvisarQueVence(FREE, AHORA)).toBe(false);
  });
});

/**
 * VendoX Business.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ESTOS TESTS EXISTEN PARA EVITAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `planVigente` devolvía `'PRO'` literal. Con dos planes daba lo mismo; con
 * tres, esa línea le habría dado Pro a todos los Business, sin error, sin log y
 * sin que nadie lo notara — salvo el vendedor que paga el plan caro y no
 * recibe su comisión por volumen.
 *
 * Es el tipo de bug que no rompe nada: simplemente cobra de más, todos los
 * días, en silencio.
 */
const BUSINESS_VIGENTE = { plan: 'BUSINESS' as const, vigenteHasta: enDias(20) };
const BUSINESS_VENCIDO = { plan: 'BUSINESS' as const, vigenteHasta: enDias(-1) };

describe('El plan Business', () => {
  it('un Business vigente es BUSINESS, no PRO', () => {
    expect(planVigente(BUSINESS_VIGENTE, AHORA)).toBe('BUSINESS');
  });

  it('⛔ un Business vencido cae a FREE, no a PRO', () => {
    expect(planVigente(BUSINESS_VENCIDO, AHORA)).toBe('FREE');
  });

  it('⛔ un Business sin fecha se trata como vencido', () => {
    expect(planVigente({ plan: 'BUSINESS' as const, vigenteHasta: null }, AHORA)).toBe('FREE');
  });

  it('un Pro vigente sigue siendo PRO', () => {
    expect(planVigente(PRO_VIGENTE, AHORA)).toBe('PRO');
  });
});

describe('Los beneficios de Business', () => {
  it('incluye todo lo de Pro', () => {
    const business = beneficiosDe(BUSINESS_VIGENTE, AHORA);
    for (const beneficio of beneficiosDe(PRO_VIGENTE, AHORA)) {
      expect(business).toContain(beneficio);
    }
  });

  it('agrega soporte prioritario y comisión por volumen', () => {
    expect(tieneBeneficio(BUSINESS_VIGENTE, 'SOPORTE_PRIORITARIO', AHORA)).toBe(true);
    expect(tieneBeneficio(BUSINESS_VIGENTE, 'COMISION_POR_VOLUMEN', AHORA)).toBe(true);
  });

  /**
   * Que Pro NO los tenga es la mitad del valor de Business. Si Pro los tuviera,
   * nadie tendría razón para pagar más.
   */
  it('⛔ Pro NO tiene soporte prioritario ni comisión por volumen', () => {
    expect(tieneBeneficio(PRO_VIGENTE, 'SOPORTE_PRIORITARIO', AHORA)).toBe(false);
    expect(tieneBeneficio(PRO_VIGENTE, 'COMISION_POR_VOLUMEN', AHORA)).toBe(false);
  });

  it('⛔ un Business vencido no conserva ningún beneficio', () => {
    expect(beneficiosDe(BUSINESS_VENCIDO, AHORA)).toEqual([]);
    expect(tieneBeneficio(BUSINESS_VENCIDO, 'COMISION_POR_VOLUMEN', AHORA)).toBe(false);
  });

  it('⛔ un Free no tiene nada', () => {
    expect(beneficiosDe(FREE, AHORA)).toEqual([]);
  });
});

describe('Los límites de Business', () => {
  it('más cupones y más historial que Pro', () => {
    const business = limitesDe(BUSINESS_VIGENTE, AHORA);
    const pro = limitesDe(PRO_VIGENTE, AHORA);

    expect(business.cuponesActivos).toBeGreaterThan(pro.cuponesActivos);
    expect(business.diasDeHistorial).toBeGreaterThan(pro.diasDeHistorial);
  });

  /**
   * El historial es un número concreto, no «infinito». Ver el comentario en
   * `LIMITES_POR_PLAN`: «todo» hace que la pantalla de métricas se ponga más
   * lenta cada mes, y el vendedor que más paga es el primero que lo nota.
   */
  it('el historial es finito y conocido', () => {
    expect(limitesDe(BUSINESS_VIGENTE, AHORA).diasDeHistorial).toBe(730);
  });

  it('⛔ un Business vencido vuelve a los límites de Free', () => {
    expect(limitesDe(BUSINESS_VENCIDO, AHORA)).toEqual(limitesDe(FREE, AHORA));
  });
});

describe('El aviso de vencimiento también alcanza a Business', () => {
  /**
   * `diasRestantes` preguntaba `planVigente() !== 'PRO'`. Con esa condición un
   * Business vigente devolvía `null`, y nunca se le habría avisado que estaba
   * por vencer: se le habrían cortado los cupones en medio de un vivo sin un
   * solo aviso previo.
   */
  it('un Business vigente informa cuántos días le quedan', () => {
    expect(diasRestantes(BUSINESS_VIGENTE, AHORA)).toBe(20);
  });

  it('a un Business por vencer se le avisa', () => {
    const porVencer = {
      plan: 'BUSINESS' as const,
      vigenteHasta: enDias(DIAS_DE_AVISO_ANTES_DE_VENCER - 1),
    };

    expect(tocaAvisarQueVence(porVencer, AHORA)).toBe(true);
  });

  it('⛔ a un Business con tiempo de sobra no se le avisa', () => {
    expect(tocaAvisarQueVence(BUSINESS_VIGENTE, AHORA)).toBe(false);
  });
});

describe('El tope de productos publicados', () => {
  it('Free tiene tres', () => {
    expect(limitesDe(FREE, AHORA).productosPublicados).toBe(3);
  });

  it('Pro y Business no tienen tope', () => {
    expect(limitesDe(PRO_VIGENTE, AHORA).productosPublicados).toBeNull();
    expect(limitesDe(BUSINESS_VIGENTE, AHORA).productosPublicados).toBeNull();
  });

  it('un Pro vencido vuelve al tope de Free', () => {
    expect(limitesDe(PRO_VENCIDO, AHORA).productosPublicados).toBe(3);
  });

  it('con cero publicados y tope tres, puede', () => {
    expect(puedePublicarUnoMas(3, 0)).toBe(true);
  });

  it('con dos publicados y tope tres, todavía puede', () => {
    expect(puedePublicarUnoMas(3, 2)).toBe(true);
  });

  /**
   * El borde. Un `<=` en vez de un `<` deja publicar cuatro, y nadie lo nota
   * hasta contar los productos de una tienda Free.
   */
  it('en el tope exacto, ya no', () => {
    expect(puedePublicarUnoMas(3, 3)).toBe(false);
  });

  /**
   * El caso de quien ya tenía más de tres cuando se introdujo el límite. No se
   * le saca nada: simplemente no puede sumar.
   */
  it('por encima del tope tampoco, pero es un no-podés-sumar, no un tenés-que-borrar', () => {
    expect(puedePublicarUnoMas(3, 10)).toBe(false);
  });

  it('sin tope, siempre puede', () => {
    expect(puedePublicarUnoMas(null, 0)).toBe(true);
    expect(puedePublicarUnoMas(null, 5_000)).toBe(true);
  });
});
