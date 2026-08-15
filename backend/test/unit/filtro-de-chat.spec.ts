import { describe, expect, it } from 'vitest';

import {
  explicacionDelFiltro,
  filtrarMensaje,
  normalizarParaFiltro,
  PALABRAS_PROHIBIDAS_POR_OMISION,
} from '@/modules/live/filtro-de-chat';

/**
 * El filtro del chat del vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS DOS ERRORES POSIBLES NO CUESTAN LO MISMO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * · **Falso negativo** — pasa un teléfono. Alguien se lleva la operación afuera
 *   de VendoX y quien compra queda sin comprobante ni forma de reclamar;
 * · **Falso positivo** — se frena un mensaje normal. Alguien no puede escribir
 *   "$45000" en un chat de compraventa, se enoja, y con razón.
 *
 * El segundo es más frecuente y más visible. Por eso hay tantos tests de lo que
 * **tiene que pasar** como de lo que hay que frenar.
 */
describe('Normalizar', () => {
  it('saca acentos y mayúsculas', () => {
    expect(normalizarParaFiltro('NEGRÓN')).toBe('negron');
    expect(normalizarParaFiltro('Ñandú')).toBe('nandu');
  });

  it('colapsa letras repetidas', () => {
    /**
     * Estirar una vocal es lo primero que prueba cualquiera para saltear un
     * filtro.
     */
    expect(normalizarParaFiltro('holaaaaa')).toBe('hola');
    expect(normalizarParaFiltro('sudaaaaaca')).toBe('sudaca');
  });

  it('⛔ no colapsa las dobles legítimas', () => {
    // `carro` no puede volverse `caro`, ni `llave` volverse `lave`.
    expect(normalizarParaFiltro('carro')).toBe('carro');
    expect(normalizarParaFiltro('llave')).toBe('llave');
  });
});

describe('Datos de contacto', () => {
  /**
   * Es lo que más daño hace en una plataforma de venta: sacar la operación
   * afuera deja a quien compra sin protección, sin comprobante y sin forma de
   * reclamar. Es también la forma más común de estafa.
   */

  it('⛔ frena teléfonos, escritos como sea', () => {
    for (const texto of [
      'llamame al 1123456789',
      'mi numero es 11 2345 6789',
      'wsp 11-2345-6789',
      '(011) 2345-6789',
      '1 1 2 3 4 5 6 7 8 9',
      '+54 9 11 2345 6789',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(false);
    }
  });

  it('⛔ frena correos, incluso disfrazados', () => {
    for (const texto of [
      'escribime a juan@gmail.com',
      'juan arroba gmail punto com',
      'juan @ gmail . com',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(false);
    }
  });

  it('⛔ frena redes sociales', () => {
    for (const texto of [
      'seguime en ig juanperez',
      'IG: @juanperez',
      'mandame whatsapp',
      'te paso por telegram',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(false);
    }
  });

  it('⛔ frena enlaces', () => {
    for (const texto of [
      'entra a https://otrositio.com',
      'www.otrositio.com',
      'miratienda.shop tiene mejor precio',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(false);
      expect(filtrarMensaje(texto).motivo, texto).toBeDefined();
    }
  });
});

describe('Lo que TIENE que pasar', () => {
  /**
   * La mitad más importante del archivo.
   *
   * Un chat de compraventa está lleno de números: precios, talles, cantidades,
   * medidas, códigos postales. Un filtro que los frena es un filtro que nadie
   * puede usar.
   */

  it('los precios pasan', () => {
    for (const texto of [
      'cuanto sale?',
      '$45000',
      'sale 45.000 pesos',
      '45000 esta bien?',
      'tenes en 3 cuotas de 15000?',
      'lo dejas en 40 lucas?',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(true);
    }
  });

  it('los talles, cantidades y medidas pasan', () => {
    for (const texto of [
      'tenes talle 42?',
      'quiero 2 unidades',
      'mide 30 x 40 cm?',
      'me quedan 3',
      'codigo postal 1425',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(true);
    }
  });

  it('putear NO está prohibido', () => {
    /**
     * Un "qué caro la puta madre" es alguien mirando un precio, no acoso. La
     * lista tiene ataques dirigidos y discriminación, no palabrotas.
     *
     * Frenar esto sería convertir el chat de un vivo argentino en algo que
     * nadie puede usar.
     */
    for (const texto of [
      'que caro la puta madre',
      'esta buenisimo el boludo',
      'no jodas, en serio?',
      'la concha de la lora que lindo',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(true);
    }
  });

  it('las conversaciones normales de un vivo pasan', () => {
    for (const texto of [
      'hola!',
      'me encanta',
      'hacen envios a Cordoba?',
      'cuanto tarda el envio',
      'ya te compre 2 veces, todo perfecto',
      'aguante',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(true);
    }
  });
});

describe('Palabras prohibidas', () => {
  it('⛔ frena discriminación y amenazas', () => {
    for (const texto of [
      'negro de mierda',
      'andate sudaca',
      'te voy a matar',
      'se donde vivis',
    ]) {
      expect(filtrarMensaje(texto).permitido, texto).toBe(false);
      expect(filtrarMensaje(texto).motivo, texto).toBe('PALABRA_PROHIBIDA');
    }
  });

  it('⛔ frena aunque se escriba con acentos o estirado', () => {
    expect(filtrarMensaje('negrooo de mierdaaa').permitido).toBe(false);
    expect(filtrarMensaje('SUDACA').permitido).toBe(false);
  });

  it('la lista se puede reemplazar por configuración', () => {
    /**
     * Cada agregado a la lista es una decisión de moderación, y tiene que poder
     * hacerse sin desplegar.
     */
    const r = filtrarMensaje('esta palabra rara', { palabrasProhibidas: ['palabra rara'] });
    expect(r.permitido).toBe(false);

    // Y con la lista propia, las de la lista por defecto ya no aplican.
    expect(filtrarMensaje('sudaca', { palabrasProhibidas: ['otra cosa'] }).permitido).toBe(true);
  });

  it('la lista por defecto son ataques, no palabrotas', () => {
    /**
     * Fija la política. Si alguien agrega `puto` o `boludo` a secas, este test
     * lo hace visible en la revisión.
     */
    for (const palabra of PALABRAS_PROHIBIDAS_POR_OMISION) {
      const esAtaqueDirigido =
        palabra.includes('de mierda') ||
        palabra.startsWith('te voy a') ||
        palabra.startsWith('se donde') ||
        palabra === 'sudaca';
      expect(esAtaqueDirigido, `"${palabra}" no parece un ataque dirigido`).toBe(true);
    }
  });
});

describe('Lo que se le dice a la persona', () => {
  it('explica qué pasó, para que pueda reescribirlo', () => {
    // "No se pudo enviar" a secas hace que lo reintente cinco veces pensando
    // que es la conexión.
    expect(explicacionDelFiltro('CONTACTO')).toContain('datos de contacto');
    expect(explicacionDelFiltro('ENLACE')).toContain('enlaces');
  });

  it('⛔ pero no le enseña a esquivar el filtro', () => {
    /**
     * "Detectamos un número de teléfono" explica. "Los números de más de ocho
     * dígitos están prohibidos" es un manual.
     */
    const textos = (['CONTACTO', 'ENLACE', 'PALABRA_PROHIBIDA'] as const).map(
      explicacionDelFiltro,
    );

    for (const t of textos) {
      expect(t).not.toMatch(/\d+\s*(d[ií]gitos|caracteres)/i);
      expect(t.toLowerCase()).not.toContain('expresión regular');
    }
  });

  it('el de contacto dice POR QUÉ conviene comprar por la app', () => {
    // No es una regla arbitraria: comprar por afuera deja a la persona sin
    // comprobante y sin forma de reclamar. Decirlo cambia cómo se recibe.
    expect(explicacionDelFiltro('CONTACTO')).toContain('comprobante');
  });
});
