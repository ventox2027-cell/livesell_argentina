import { describe, expect, it } from 'vitest';

import {
  DIAS_DE_ARREPENTIMIENTO_LEGALES,
  diasEfectivos,
  resumenParaElComprador,
  validarPolitica,
  vencimientoDelArrepentimiento,
  type PoliticaDeCambios,
} from '@/modules/commerce/politicas';

/**
 * El piso legal de cambios y devoluciones.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO ES UNA VALIDACIÓN DE FORMULARIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una tienda que publica "no se aceptan devoluciones" está publicando una
 * cláusula nula, y quien aloja esa publicación responde junto con ella. El
 * daño de un bug acá no es un número mal guardado: es una promesa ilegal
 * publicada con nuestro nombre.
 *
 * Por eso el piso se prueba desde los dos lados: que no se pueda configurar por
 * debajo, y que se aplique igual si de alguna forma quedó por debajo.
 */
describe('Políticas de cambio y devolución', () => {
  const soloLegal: PoliticaDeCambios = {
    modo: 'SOLO_LEGAL',
    diasParaCambiar: 10,
    quienPagaElEnvio: 'VENDEDOR',
    nota: null,
  };

  describe('El piso de diez días', () => {
    it('es el que fija la ley 24.240', () => {
      expect(DIAS_DE_ARREPENTIMIENTO_LEGALES).toBe(10);
    });

    it('⛔ no se puede publicar menos', () => {
      for (const dias of [0, 1, 3, 7, 9]) {
        const r = validarPolitica({ ...soloLegal, diasParaCambiar: dias });
        expect(r.ok, `${dias} días`).toBe(false);
        if (!r.ok) {
          // El motivo tiene que explicar POR QUÉ, no decir "mínimo 10". Si
          // parece un capricho nuestro, el vendedor busca cómo esquivarlo.
          expect(r.motivo).toContain('arrepentirse');
        }
      }
    });

    it('sí se puede ofrecer más', () => {
      for (const dias of [10, 15, 30, 90, 365]) {
        expect(validarPolitica({ ...soloLegal, diasParaCambiar: dias }).ok, `${dias} días`).toBe(
          true,
        );
      }
    });

    it('se aplica igual si el dato quedó por debajo', () => {
      /**
       * Defensa de lectura, no de escritura. Aunque una fila vieja o un UPDATE
       * a mano hayan dejado tres días guardados, lo que vale son diez: es el
       * derecho del comprador, no una configuración de la tienda.
       */
      expect(diasEfectivos(3)).toBe(10);
      expect(diasEfectivos(0)).toBe(10);
      expect(diasEfectivos(-5)).toBe(10);
    });

    it('lo que el vendedor ofrece de más se respeta', () => {
      expect(diasEfectivos(30)).toBe(30);
    });

    it('un número absurdo se rechaza: es un cero de más', () => {
      const r = validarPolitica({ ...soloLegal, diasParaCambiar: 3_650 });
      expect(r.ok).toBe(false);
    });

    it('los días fraccionados se rechazan', () => {
      // "10,5 días" no significa nada y la columna es entera.
      expect(validarPolitica({ ...soloLegal, diasParaCambiar: 10.5 }).ok).toBe(false);
    });
  });

  describe('Quién paga el envío de vuelta', () => {
    it('⛔ el arrepentimiento puro NO puede cobrarle el envío al comprador', () => {
      /**
       * Art. 34 de la ley 24.240: la revocación es "sin costo alguno". Cobrarle
       * el envío convierte el derecho en algo que cuesta plata ejercer, que es
       * exactamente lo que la norma impide.
       */
      const r = validarPolitica({ ...soloLegal, quienPagaElEnvio: 'COMPRADOR' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('sin costo');
    });

    it('un cambio voluntario sí puede pedir que lo pague quien cambia', () => {
      // Ya no es arrepentimiento: es un servicio adicional que el vendedor está
      // regalando, y puede poner sus condiciones.
      expect(
        validarPolitica({
          ...soloLegal,
          modo: 'CAMBIO_SIN_CAUSA',
          quienPagaElEnvio: 'COMPRADOR',
        }).ok,
      ).toBe(true);
    });
  });

  describe('El texto que ve el comprador', () => {
    it('el derecho de arrepentimiento aparece SIEMPRE', () => {
      // Aunque el vendedor elija el mínimo, aunque no escriba ninguna nota:
      // es un derecho que le da la ley y no depende de él.
      for (const modo of ['SOLO_LEGAL', 'CAMBIO_SIN_CAUSA', 'DEVOLUCION_SIN_CAUSA'] as const) {
        const resumen = resumenParaElComprador({ ...soloLegal, modo });
        expect(resumen.derechoDeArrepentimiento, modo).toContain('10 días corridos');
        expect(resumen.derechoDeArrepentimiento, modo).toContain('no depende del vendedor');
      }
    });

    it('los días que se muestran son los efectivos, no los guardados', () => {
      const resumen = resumenParaElComprador({
        ...soloLegal,
        modo: 'DEVOLUCION_SIN_CAUSA',
        diasParaCambiar: 3,
      });
      // Nunca se le puede mostrar a alguien un plazo menor al que tiene.
      expect(resumen.lineas.join(' ')).toContain('10 días');
      expect(resumen.lineas.join(' ')).not.toContain('3 días');
    });

    it('la nota del vendedor se suma, no reemplaza', () => {
      const resumen = resumenParaElComprador({
        ...soloLegal,
        modo: 'CAMBIO_SIN_CAUSA',
        nota: 'Los cambios se coordinan por el chat.',
      });
      expect(resumen.lineas).toContain('Los cambios se coordinan por el chat.');
      expect(resumen.lineas.length).toBeGreaterThan(1);
    });
  });

  describe('Cuándo vence el plazo de un pedido', () => {
    it('se cuenta desde la ENTREGA, no desde la compra', () => {
      /**
       * Alguien que compró algo que tarda dos semanas en llegar no puede haber
       * gastado su plazo esperando. Además es lo que dice la ley.
       */
      const entregado = new Date('2026-08-14T10:00:00.000Z');
      const vence = vencimientoDelArrepentimiento(entregado, 10);

      expect(vence?.toISOString().slice(0, 10)).toBe('2026-08-24');
    });

    it('sin entrega todavía no hay fecha límite', () => {
      expect(vencimientoDelArrepentimiento(null, 10)).toBeNull();
    });

    it('usa los días efectivos, no los guardados', () => {
      const entregado = new Date('2026-08-14T10:00:00.000Z');
      // Guardados 2, valen 10.
      expect(vencimientoDelArrepentimiento(entregado, 2)?.toISOString().slice(0, 10)).toBe(
        '2026-08-24',
      );
    });

    it('cruza el fin de mes sin romperse', () => {
      // `setDate` con desborde lo resuelve solo; el test existe para que nadie
      // lo "arregle" con aritmética de milisegundos, que rompe con el cambio de
      // horario.
      const entregado = new Date('2026-08-28T10:00:00.000Z');
      expect(vencimientoDelArrepentimiento(entregado, 10)?.toISOString().slice(0, 10)).toBe(
        '2026-09-07',
      );
    });
  });
});
