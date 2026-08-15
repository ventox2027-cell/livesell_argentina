import { describe, expect, it } from 'vitest';

import {
  BLOQUEO_MINUTOS,
  codigoCoincide,
  finDelBloqueo,
  generarCodigoDeEntrega,
  guardarCodigo,
  LARGO_DEL_CODIGO,
  leerCodigoGuardado,
  MAX_INTENTOS,
  verificarCodigo,
  type EstadoDelCodigo,
} from '@/modules/orders/delivery-code';
import { SecretoAdulteradoError } from '@/shared/crypto/secretos';

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

// ═══════════════════════════════════════════════════════════════════════════
// GUARDADO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El código cifrado en reposo.
 *
 * Lo que estos tests protegen es una clase de incidente concreta: alguien se
 * lleva un respaldo de la base, o una réplica, o un volcado que un compañero
 * hizo para depurar. Con el código en claro en la columna, todos los pedidos en
 * camino quedan confirmables por quien los tenga.
 *
 * No protege contra alguien con acceso al proceso —la llave está ahí— y no es
 * la defensa principal, que sigue siendo que el vendedor nunca lo ve.
 */
describe('Guardado del código', () => {
  /** Una llave de 32 bytes que no es de ceros. Sólo para estos tests. */
  const LLAVE = Buffer.alloc(32, 7);

  it('lo que se guarda NO es el código', () => {
    const codigo = '004821';
    const guardado = guardarCodigo(codigo, LLAVE);

    expect(guardado).not.toContain(codigo);
    expect(guardado).not.toBe(codigo);
    // Y se nota de un vistazo que no es texto plano.
    expect(guardado.startsWith('v1.')).toBe(true);
  });

  it('se puede volver a leer', () => {
    // Esto es lo que hace imposible el hash: el comprador tiene que poder leer
    // su código cada vez que abre el pedido.
    for (const codigo of ['000000', '004821', '999999', '123456']) {
      expect(leerCodigoGuardado(guardarCodigo(codigo, LLAVE), LLAVE)).toBe(codigo);
    }
  });

  it('preserva los ceros a la izquierda al ida y vuelta', () => {
    /**
     * `004821` es un código válido. Si en algún punto del camino pasara por un
     * número, volvería como `4821` y la entrega sería imposible de confirmar.
     */
    const guardado = guardarCodigo('004821', LLAVE);
    const leido = leerCodigoGuardado(guardado, LLAVE);

    expect(leido).toBe('004821');
    expect(leido).toHaveLength(6);
  });

  it('⛔ el mismo código dos veces NO produce lo mismo', () => {
    /**
     * El IV es distinto en cada cifrado. Si no lo fuera, dos pedidos con el
     * mismo código tendrían la misma fila y quien viera la base sabría que
     * coinciden — y con un solo código conocido, sabría los dos.
     */
    const a = guardarCodigo('123456', LLAVE);
    const b = guardarCodigo('123456', LLAVE);

    expect(a).not.toBe(b);
    // Pero los dos descifran a lo mismo.
    expect(leerCodigoGuardado(a, LLAVE)).toBe(leerCodigoGuardado(b, LLAVE));
  });

  it('⛔ con otra llave no se descifra: falla, no devuelve basura', () => {
    /**
     * GCM es cifrado autenticado. Con AES-CBC esto habría devuelto seis bytes
     * cualesquiera y el sistema habría comparado contra ellos sin enterarse.
     */
    const guardado = guardarCodigo('123456', LLAVE);
    const otra = Buffer.alloc(32, 9);

    expect(() => leerCodigoGuardado(guardado, otra)).toThrow(SecretoAdulteradoError);
  });

  it('⛔ un código adulterado en la base no se acepta', () => {
    const guardado = guardarCodigo('123456', LLAVE);
    // Se le cambia un carácter al texto cifrado, como haría alguien con acceso
    // de escritura a la base.
    const partes = guardado.split('.');
    const ultimo = partes[3]!;
    partes[3] = (ultimo[0] === 'A' ? 'B' : 'A') + ultimo.slice(1);

    expect(() => leerCodigoGuardado(partes.join('.'), LLAVE)).toThrow(SecretoAdulteradoError);
  });

  it('los códigos viejos, en claro, se siguen leyendo', () => {
    /**
     * Los pedidos despachados antes de este cambio tienen seis dígitos en la
     * columna. No se migran, y sin esto quedarían inconfirmables: el comprador
     * vería un error donde antes veía su número.
     */
    expect(leerCodigoGuardado('004821', LLAVE)).toBe('004821');
    expect(leerCodigoGuardado('004821', null)).toBe('004821');
  });

  it('sin llave se guarda en claro, como antes', () => {
    // Un servidor recién clonado, sin CREDENTIALS_ENCRYPTION_KEY, tiene que
    // poder despachar un pedido de prueba.
    expect(guardarCodigo('123456', null)).toBe('123456');
  });

  it('⛔ sin llave NO se puede leer algo cifrado', () => {
    // El caso de la llave borrada del entorno. Falla ruidosamente en vez de
    // devolver el sobre entero como si fuera el código.
    const guardado = guardarCodigo('123456', LLAVE);

    expect(() => leerCodigoGuardado(guardado, null)).toThrow(SecretoAdulteradoError);
  });

  it('⛔ un sobre con la forma rota no se interpreta a medias', () => {
    for (const roto of ['v1.', 'v1.a.b', 'v1.a.b.c.d', 'v.a.b.c', 'vx.a.b.c']) {
      expect(() => leerCodigoGuardado(roto, LLAVE)).toThrow(SecretoAdulteradoError);
    }
  });

  it('lo guardado entra en la restricción de la base', () => {
    /**
     * La columna tiene un CHECK que acepta seis dígitos o el sobre. Si el
     * formato cambiara y la expresión de la migración no, el INSERT fallaría
     * recién en producción, al despachar un pedido.
     *
     * La expresión es la misma que la de
     * `20260815020000_delivery_code_cifrado`.
     */
    const restriccion = /^v[0-9]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;

    for (let i = 0; i < 200; i++) {
      expect(guardarCodigo(generarCodigoDeEntrega(), LLAVE)).toMatch(restriccion);
    }
  });
});
