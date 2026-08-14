import { describe, expect, it } from 'vitest';

import { evaluarRiesgo, UMBRALES, type SenalesDeRiesgo } from '@/modules/sellers/risk.rules';

/**
 * Las reglas de riesgo.
 *
 * ─── Por qué estos tests son baratos y valen ───
 *
 * `evaluarRiesgo` es una función pura: recibe señales, devuelve un veredicto.
 * No toca la base. Eso permite probar combinaciones que en PostgreSQL costarían
 * montar un vendedor con tres devoluciones, dos suspensiones y un documento
 * duplicado — y probarlas todas, no las dos que uno se acuerda de armar.
 *
 * Lo que se verifica no es "el código hace lo que dice el código", sino las
 * propiedades que tienen que valer:
 *
 *   · Un motivo grave gana sobre cualquier cantidad de motivos leves.
 *   · Un buen historial puede sacar a alguien de riesgo medio.
 *   · Nunca se devuelve un nivel sin explicación.
 */

/** Un vendedor recién creado: sin nada verificado y sin historial. */
const NUEVO: SenalesDeRiesgo = {
  identidadVerificada: false,
  telefonoVerificado: false,
  cuentaDeCobroConectada: false,
  antiguedadDias: 0,
  ordenesCompletadas: 0,
  cancelacionesRecientes: 0,
  devolucionesRecientes: 0,
  suspensionesHistoricas: 0,
  cambiosCriticosRecientes: 0,
  multiplicadorDeCrecimiento: null,
  documentoDuplicado: false,
};

/** Uno con trayectoria: verificado, cobrando y vendiendo bien. */
const CONSOLIDADO: SenalesDeRiesgo = {
  ...NUEVO,
  identidadVerificada: true,
  telefonoVerificado: true,
  cuentaDeCobroConectada: true,
  antiguedadDias: 180,
  ordenesCompletadas: 120,
};

describe('evaluarRiesgo', () => {
  it('siempre devuelve al menos un motivo', () => {
    /**
     * Un nivel sin explicación es inútil: quien lo lee no puede decidir nada, y
     * el vendedor no puede corregir nada. Esta propiedad tiene que valer para
     * cualquier entrada.
     */
    for (const s of [NUEVO, CONSOLIDADO, { ...NUEVO, documentoDuplicado: true }]) {
      const v = evaluarRiesgo(s);
      expect(v.motivos.length, JSON.stringify(v)).toBeGreaterThan(0);
    }
  });

  describe('riesgo alto', () => {
    it('documento duplicado, aunque todo lo demás esté impecable', () => {
      /**
       * La propiedad más importante del archivo: **la severidad no se promedia**.
       *
       * Un vendedor con 120 ventas, identidad verificada y cero devoluciones
       * cuyo DNI aparece en otra cuenta es riesgo alto. Si el nivel fuera un
       * promedio ponderado, esas 120 ventas diluirían la única señal que
       * importa.
       */
      const v = evaluarRiesgo({ ...CONSOLIDADO, documentoDuplicado: true });

      expect(v.nivel).toBe('HIGH');
      expect(v.motivos.join(' ')).toContain('documento_duplicado');
    });

    it('haber sido suspendido antes', () => {
      const v = evaluarRiesgo({ ...CONSOLIDADO, suspensionesHistoricas: 1 });
      expect(v.nivel).toBe('HIGH');
    });

    it('cambiar datos críticos hace poco', () => {
      // El patrón de una cuenta robada o comprada es entrar y cambiar dónde se
      // cobra.
      const v = evaluarRiesgo({ ...CONSOLIDADO, cambiosCriticosRecientes: 1 });
      expect(v.nivel).toBe('HIGH');
      expect(v.motivos.join(' ')).toContain('cambio_critico_reciente');
    });

    it('muchas devoluciones', () => {
      const v = evaluarRiesgo({
        ...CONSOLIDADO,
        devolucionesRecientes: UMBRALES.devolucionesGrave,
      });
      expect(v.nivel).toBe('HIGH');
    });
  });

  describe('riesgo medio', () => {
    it('un vendedor recién creado', () => {
      const v = evaluarRiesgo(NUEVO);
      expect(v.nivel).toBe('MEDIUM');
      expect(v.motivos.join(' ')).toContain('identidad_sin_verificar');
    });

    it('cinco señales leves NO llegan a alto', () => {
      // Acumular motivos intermedios no equivale a uno grave. Si lo hiciera,
      // todo vendedor nuevo sería riesgo alto el primer día.
      const v = evaluarRiesgo({ ...NUEVO, cancelacionesRecientes: UMBRALES.cancelacionesAlerta });
      expect(v.nivel).toBe('MEDIUM');
      expect(v.motivos.length).toBeGreaterThanOrEqual(4);
    });

    it('crecimiento anormal', () => {
      const v = evaluarRiesgo({
        ...CONSOLIDADO,
        multiplicadorDeCrecimiento: UMBRALES.crecimientoSospechoso,
      });
      expect(v.nivel).toBe('MEDIUM');
      expect(v.motivos.join(' ')).toContain('crecimiento_anormal');
    });

    it('sin historial previo, el crecimiento no se evalúa', () => {
      /**
       * Con `null`, la regla no aplica. Si se tratara como cero, la primera
       * venta de cualquier vendedor sería "crecimiento infinito" y todos
       * dispararían la alerta el día que empiezan.
       */
      const v = evaluarRiesgo({ ...CONSOLIDADO, multiplicadorDeCrecimiento: null });
      expect(v.motivos.join(' ')).not.toContain('crecimiento_anormal');
    });
  });

  describe('riesgo bajo', () => {
    it('trayectoria: verificado, cobrando y con ventas', () => {
      const v = evaluarRiesgo(CONSOLIDADO);
      expect(v.nivel).toBe('LOW');
      expect(v.motivos.join(' ')).toContain('trayectoria');
    });

    it('el historial pesa más que las condiciones iniciales', () => {
      /**
       * Sin esta salida, "cuenta nueva" mantendría a todo el mundo en medio
       * para siempre — nadie deja nunca de haber tenido las señales que tuvo.
       *
       * Un sistema que no premia portarse bien deja de clasificar: si todos
       * terminan en el mismo nivel, el nivel no significa nada.
       */
      const v = evaluarRiesgo({
        ...CONSOLIDADO,
        antiguedadDias: 3,
        telefonoVerificado: false,
      });
      expect(v.nivel).toBe('LOW');
    });

    it('pero no si hay devoluciones acumuladas', () => {
      const v = evaluarRiesgo({
        ...CONSOLIDADO,
        devolucionesRecientes: UMBRALES.devolucionesAlerta,
      });
      expect(v.nivel).toBe('MEDIUM');
    });

    it('ni si le falta la cuenta de cobro', () => {
      const v = evaluarRiesgo({ ...CONSOLIDADO, cuentaDeCobroConectada: false });
      expect(v.nivel).toBe('MEDIUM');
    });
  });

  describe('los motivos sirven para explicar', () => {
    it('llevan código y texto legible', () => {
      // El código permite filtrar y agrupar; el texto es lo que alguien lee en
      // el panel. Los dos hacen falta.
      const v = evaluarRiesgo({ ...NUEVO, devolucionesRecientes: 4 });
      const motivo = v.motivos.find((m) => m.startsWith('devoluciones_algunas'));

      expect(motivo).toBeDefined();
      expect(motivo).toContain('4 devoluciones');
    });

    it('el texto dice el número concreto, no una categoría', () => {
      const v = evaluarRiesgo({ ...CONSOLIDADO, suspensionesHistoricas: 3 });
      expect(v.motivos.join(' ')).toContain('3 veces');
    });

    it('singular y plural bien escritos', () => {
      expect(evaluarRiesgo({ ...CONSOLIDADO, suspensionesHistoricas: 1 }).motivos.join(' ')).toContain(
        '1 vez',
      );
      expect(evaluarRiesgo({ ...CONSOLIDADO, suspensionesHistoricas: 2 }).motivos.join(' ')).toContain(
        '2 veces',
      );
    });
  });
});
