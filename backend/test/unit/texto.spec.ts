import { describe, expect, it } from 'vitest';

import {
  TextoIlegibleError,
  normalizarTexto,
  textoLimpio,
  tieneCaracteresRotos,
} from '@/shared/utils/texto';

/**
 * Texto que escriben personas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ORIGINÓ ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Apareció en la base un producto llamado `Vela arom�tica`. Los bytes
 * guardados eran `…6f 6d EF BF BD 74…`, y `EF BF BD` es U+FFFD: el texto ya
 * estaba roto EN EL DISCO, no era un problema de cómo se mostraba.
 *
 * Lo escribió un script desde una consola de Windows con página de códigos
 * 1252: el `á` viajó como el byte suelto `0xE1`, que no es UTF-8 válido, y Node
 * lo reemplazó al decodificar. El byte original no se puede recuperar.
 *
 * Lo que se prueba acá son las dos defensas: rechazar texto ya roto, y
 * normalizar el que está bien pero viene en dos formas distintas.
 */
describe('Texto de personas', () => {
  /** Las palabras del bug, más las que rompen de otras formas. */
  const PALABRAS = ['Vela aromática', 'Muñeca', 'Niñez', 'Té', 'Jabón artesanal', 'Ñandú'];

  describe('⛔ Texto ya roto', () => {
    it('detecta el carácter de reemplazo', () => {
      // Nadie lo escribe a propósito: no está en ningún teclado. Siempre es el
      // resultado de una decodificación fallida más arriba.
      expect(tieneCaracteresRotos('Vela arom�tica')).toBe(true);
      expect(tieneCaracteresRotos('Vela aromática')).toBe(false);
    });

    it('reproduce exactamente el bug de la base', () => {
      /**
       * Así se rompió: el `á` como byte suelto de cp1252, decodificado como
       * UTF-8. Es lo que pasa cuando un script manda texto desde una consola de
       * Windows sin declarar la codificación.
       */
      const comoLlego = Buffer.from([0xe1]).toString('utf8');
      const roto = `Vela arom${comoLlego}tica`;

      expect(tieneCaracteresRotos(roto)).toBe(true);
      expect(Buffer.from(roto, 'utf8').includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true);
    });

    it('lo rechaza en el borde', () => {
      // Es el único momento en que todavía se puede pedir el texto de nuevo.
      expect(() => textoLimpio('Vela arom�tica')).toThrow(TextoIlegibleError);
    });

    it('el mensaje dice qué hacer, no qué falló', () => {
      // "Error de codificación UTF-8" no le sirve a nadie que vende tejidos.
      try {
        textoLimpio('roto�');
        expect.fail('tendría que haber lanzado');
      } catch (err) {
        expect((err as Error).message).toContain('volvé a escribirlo');
      }
    });
  });

  describe('⛔ La misma palabra en dos formas Unicode', () => {
    it('NFD y NFC quedan iguales después de normalizar', () => {
      /**
       * "á" se puede escribir como U+00E1 o como a + U+0301. Se ven idénticos y
       * NO son iguales. El teclado de iOS produce NFD en algunos casos.
       *
       * Sin esto: un producto cargado desde un iPhone no se encuentra buscando
       * desde un Android, y dos productos con el mismo nombre pasan el índice
       * único.
       */
      const nfc = 'Vela aromática';
      const nfd = 'Vela aromática';

      // Antes de normalizar son distintos, aunque se lean igual.
      expect(nfc).not.toBe(nfd);
      expect(nfd.length).toBeGreaterThan(nfc.length);

      // Después, la misma cadena.
      expect(normalizarTexto(nfd)).toBe(normalizarTexto(nfc));
      expect(normalizarTexto(nfd)).toBe(nfc);
    });

    it('funciona con todas las palabras del caso', () => {
      for (const p of PALABRAS) {
        const descompuesta = p.normalize('NFD');
        expect(normalizarTexto(descompuesta), p).toBe(p.normalize('NFC'));
      }
    });

    it('NFC es la forma más corta', () => {
      // Convertir a NFD haría que "á" ocupe dos caracteres, y un límite de 60
      // aceptaría la mitad de las palabras acentuadas.
      expect(normalizarTexto('Ñandú').length).toBe(5);
    });
  });

  describe('Espacios', () => {
    it('los repetidos se juntan', () => {
      // Alguien pega dos espacios desde el teléfono sin darse cuenta, y
      // "Vela  aromática" es un producto distinto para cualquier índice único.
      expect(normalizarTexto('Vela  aromática')).toBe('Vela aromática');
      expect(normalizarTexto('  Muñeca  ')).toBe('Muñeca');
    });

    it('los saltos de línea también', () => {
      expect(normalizarTexto('Vela\naromática')).toBe('Vela aromática');
    });
  });

  describe('Lo que NO toca', () => {
    it('el texto correcto pasa igual', () => {
      for (const p of PALABRAS) {
        expect(textoLimpio(p), p).toBe(p);
      }
    });

    it('los emojis sobreviven', () => {
      // Un vendedor pone emojis en el nombre del producto todo el tiempo.
      expect(textoLimpio('Vela aromática 🕯️')).toBe('Vela aromática 🕯️');
    });

    it('los caracteres de otros alfabetos también', () => {
      expect(textoLimpio('日本語')).toBe('日本語');
    });
  });
});
