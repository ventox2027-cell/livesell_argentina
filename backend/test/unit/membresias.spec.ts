import { describe, expect, it } from 'vitest';

import {
  DIAS_DE_AVISO_ANTES_DE_VENCER,
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
