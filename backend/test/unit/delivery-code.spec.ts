import { describe, expect, it } from 'vitest';

import {
  BLOQUEO_MINUTOS,
  codigoCoincide,
  finDelBloqueo,
  generarCodigoDeEntrega,
  LARGO_DEL_CODIGO,
  MAX_INTENTOS,
  verificarCodigo,
  type EstadoDelCodigo,
} from '@/modules/orders/delivery-code';

/**
 * El código de entrega.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE ESTÁ PROTEGIENDO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Entregado" es una afirmación sobre el mundo físico, y antes la hacía
 * unilateralmente quien tiene interés en que sea cierta: el vendedor. Un pedido
 * podía figurar entregado sin que nadie hubiera recibido nada.
 *
 * Estos tests fijan las reglas que hacen que eso no se pueda: sin el código no
 * hay entrega, los intentos se agotan, y el bloqueo aguanta.
 */
describe('Generación del código', () => {
  it('siempre son seis dígitos', () => {
    for (let i = 0; i < 500; i++) {
      expect(generarCodigoDeEntrega()).toMatch(/^[0-9]{6}$/);
    }
  });

  it('no descarta los que empiezan con cero', () => {
    /**
     * Filtrarlos reduciría el espacio de un millón a novecientos mil y sesgaría
     * los códigos hacia arriba. Es el tipo de "arreglo" cosmético que debilita
     * un secreto sin que nadie lo note.
     *
     * Con 500 muestras y 10% de probabilidad, ver cero es prácticamente
     * imposible si no se descartan.
     */
    const muestras = Array.from({ length: 500 }, generarCodigoDeEntrega);
    expect(muestras.some((c) => c.startsWith('0'))).toBe(true);
  });

  it('no repite de forma evidente', () => {
    // No prueba aleatoriedad criptográfica —para eso está `randomInt`— pero sí
    // detecta el error de generar una vez y cachear.
    const muestras = new Set(Array.from({ length: 200 }, generarCodigoDeEntrega));
    expect(muestras.size).toBeGreaterThan(150);
  });

  it('el largo declarado coincide con lo que genera', () => {
    expect(generarCodigoDeEntrega()).toHaveLength(LARGO_DEL_CODIGO);
  });
});

describe('Comparación', () => {
  it('acepta el código correcto', () => {
    expect(codigoCoincide('123456', '123456')).toBe(true);
  });

  it('tolera espacios de más al costado', () => {
    // El repartidor lo escribe apurado en la puerta.
    expect(codigoCoincide('  123456 ', '123456')).toBe(true);
  });

  it('rechaza uno distinto', () => {
    expect(codigoCoincide('123457', '123456')).toBe(false);
  });

  it('rechaza uno de otro largo sin reventar', () => {
    // `timingSafeEqual` tira si los buffers no miden lo mismo.
    expect(codigoCoincide('12345', '123456')).toBe(false);
    expect(codigoCoincide('1234567', '123456')).toBe(false);
    expect(codigoCoincide('', '123456')).toBe(false);
  });
});

describe('Verificación', () => {
  const base: EstadoDelCodigo = {
    codigo: '123456',
    intentos: 0,
    bloqueadoHasta: null,
    entregado: false,
    status: 'SHIPPED',
  };

  it('el código correcto confirma la entrega', () => {
    expect(verificarCodigo('123456', base).ok).toBe(true);
  });

  it('⛔ el código equivocado no confirma nada', () => {
    const v = verificarCodigo('000000', base);
    expect(v.ok).toBe(false);
    expect(v.motivo).toBe('NO_COINCIDE');
  });

  it('⛔ sin despachar no se puede confirmar', () => {
    // Marcar entregado algo que todavía se está preparando no significa nada.
    for (const status of ['CONFIRMED', 'PREPARING', 'READY_TO_SHIP']) {
      const v = verificarCodigo('123456', { ...base, status });
      expect(v.ok, status).toBe(false);
      expect(v.motivo).toBe('ESTADO_INVALIDO');
    }
  });

  it('⛔ sin código emitido no se puede confirmar', () => {
    const v = verificarCodigo('123456', { ...base, codigo: null });
    expect(v.ok).toBe(false);
    expect(v.motivo).toBe('SIN_CODIGO');
  });

  it('reconfirmar una entrega ya hecha es idempotente', () => {
    // El vendedor puede tocar dos veces con mala señal. No es un error suyo.
    const v = verificarCodigo('cualquiera', { ...base, entregado: true });
    expect(v.ok).toBe(true);
    expect(v.motivo).toBe('YA_ENTREGADO');
  });

  describe('Intentos', () => {
    it('descuenta uno por cada fallo', () => {
      expect(verificarCodigo('000000', { ...base, intentos: 0 }).intentosRestantes).toBe(
        MAX_INTENTOS - 1,
      );
      expect(verificarCodigo('000000', { ...base, intentos: 2 }).intentosRestantes).toBe(
        MAX_INTENTOS - 3,
      );
    });

    it('⛔ el último intento fallido dispara el bloqueo', () => {
      const v = verificarCodigo('000000', { ...base, intentos: MAX_INTENTOS - 1 });

      expect(v.ok).toBe(false);
      expect(v.bloquear).toBe(true);
      expect(v.intentosRestantes).toBe(0);
    });

    it('un fallo intermedio NO bloquea', () => {
      // Bloquear al primer error castigaría a quien se equivoca tipeando.
      expect(verificarCodigo('000000', { ...base, intentos: 1 }).bloquear).toBe(false);
    });

    it('⛔ bloqueado no acepta ni el código correcto', () => {
      /**
       * Es el punto del bloqueo: si aceptara el correcto, alguien podría probar
       * cinco, esperar a que le vuelvan los intentos, y seguir. El bloqueo
       * tiene que valer para todo intento, incluido el que acierta.
       */
      const dentroDelBloqueo = new Date('2026-08-14T12:00:00Z');
      const v = verificarCodigo('123456', {
        ...base,
        intentos: MAX_INTENTOS,
        bloqueadoHasta: new Date('2026-08-14T12:30:00Z'),
      }, dentroDelBloqueo);

      expect(v.ok).toBe(false);
      expect(v.motivo).toBe('BLOQUEADO');
    });

    it('pasado el bloqueo vuelve a aceptar', () => {
      const despues = new Date('2026-08-14T13:00:00Z');
      const v = verificarCodigo('123456', {
        ...base,
        intentos: MAX_INTENTOS,
        bloqueadoHasta: new Date('2026-08-14T12:30:00Z'),
      }, despues);

      expect(v.ok).toBe(true);
    });
  });

  it('el bloqueo dura lo declarado', () => {
    const ahora = new Date('2026-08-14T12:00:00Z');
    const fin = finDelBloqueo(ahora);
    expect(fin.getTime() - ahora.getTime()).toBe(BLOQUEO_MINUTOS * 60_000);
  });
});
