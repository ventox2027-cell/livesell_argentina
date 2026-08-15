import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  LlaveInvalidaError,
  SecretoAdulteradoError,
  cifrar,
  descifrar,
  leerLlave,
  pista,
} from '@/shared/crypto/secretos';

/**
 * El cifrado de los tokens de Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE ESTÁ EN JUEGO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un access token de Mercado Pago permite **cobrar en nombre del vendedor**.
 * Un bug acá no es un dato mal guardado: es la posibilidad de que alguien con
 * un volcado de la base pueda mover plata de otra persona.
 *
 * Por eso se prueba lo obvio (ida y vuelta) y sobre todo lo que no lo es: que
 * un texto cifrado modificado NO se descifre en silencio.
 */
describe('Cifrado de secretos', () => {
  const llave = randomBytes(32);
  // escaner:ok token inventado. Necesita la forma exacta de uno real porque lo
  // que se prueba es que el cifrado y el tachado de logs lo reconozcan.
  const TOKEN = 'APP_USR-1234567890123456-081414-abcdef0123456789abcdef0123456789-987654321';

  describe('Ida y vuelta', () => {
    it('lo que se cifra se recupera igual', () => {
      const cifrado = cifrar(TOKEN, llave);
      expect(descifrar(cifrado, llave)).toBe(TOKEN);
    });

    it('el texto cifrado no contiene el original', () => {
      // Suena tonto probarlo. No lo es: un "cifrado" mal implementado que
      // devolviera el texto tal cual pasaría el test de ida y vuelta.
      const cifrado = cifrar(TOKEN, llave);
      expect(cifrado.ciphertext).not.toContain(TOKEN);
      expect(cifrado.ciphertext).not.toContain('APP_USR');
    });

    it('funciona con acentos y emojis', () => {
      const raro = 'ñandú · ácido · 🔐 · 日本語';
      expect(descifrar(cifrar(raro, llave), llave)).toBe(raro);
    });

    it('funciona con una cadena vacía', () => {
      expect(descifrar(cifrar('', llave), llave)).toBe('');
    });
  });

  describe('El IV nunca se repite', () => {
    it('cifrar dos veces lo mismo da resultados distintos', () => {
      /**
       * ⚠️ Es el test más importante de este archivo.
       *
       * Reutilizar el par (llave, IV) rompe GCM por completo: con dos mensajes
       * cifrados con el mismo par se puede recuperar el texto plano de ambos.
       * Si alguien "optimiza" el IV a una constante, esto lo tiene que ver.
       */
      const a = cifrar(TOKEN, llave);
      const b = cifrar(TOKEN, llave);

      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);

      // Y los dos siguen descifrando bien.
      expect(descifrar(a, llave)).toBe(TOKEN);
      expect(descifrar(b, llave)).toBe(TOKEN);
    });

    it('cien cifrados dan cien IV distintos', () => {
      const ivs = new Set(Array.from({ length: 100 }, () => cifrar(TOKEN, llave).iv));
      expect(ivs.size).toBe(100);
    });
  });

  describe('⛔ Detecta que lo tocaron', () => {
    it('un texto cifrado modificado NO se descifra en silencio', () => {
      /**
       * Es la razón de usar GCM y no CBC. Con CBC, alterar el texto cifrado
       * devuelve basura sin avisar —o algo que el atacante eligió— y el sistema
       * sigue como si nada.
       */
      const cifrado = cifrar(TOKEN, llave);
      const bytes = Buffer.from(cifrado.ciphertext, 'base64');
      bytes[0] = bytes[0]! ^ 0xff;

      expect(() =>
        descifrar({ ...cifrado, ciphertext: bytes.toString('base64') }, llave),
      ).toThrow(SecretoAdulteradoError);
    });

    it('una etiqueta modificada tampoco pasa', () => {
      const cifrado = cifrar(TOKEN, llave);
      const tag = Buffer.from(cifrado.tag, 'base64');
      tag[0] = tag[0]! ^ 0xff;

      expect(() => descifrar({ ...cifrado, tag: tag.toString('base64') }, llave)).toThrow(
        SecretoAdulteradoError,
      );
    });

    it('un IV cambiado tampoco', () => {
      const cifrado = cifrar(TOKEN, llave);
      expect(() =>
        descifrar({ ...cifrado, iv: randomBytes(12).toString('base64') }, llave),
      ).toThrow(SecretoAdulteradoError);
    });

    it('con otra llave no se puede leer', () => {
      const cifrado = cifrar(TOKEN, llave);
      expect(() => descifrar(cifrado, randomBytes(32))).toThrow(SecretoAdulteradoError);
    });

    it('una versión de llave desconocida se rechaza', () => {
      // Un dato de otra instalación no se intenta descifrar con la llave de
      // esta: daría un error de autenticación que confunde.
      const cifrado = cifrar(TOKEN, llave);
      expect(() => descifrar({ ...cifrado, version: 99 }, llave)).toThrow(SecretoAdulteradoError);
    });

    it('un IV de largo incorrecto se rechaza antes de intentar', () => {
      const cifrado = cifrar(TOKEN, llave);
      expect(() =>
        descifrar({ ...cifrado, iv: randomBytes(8).toString('base64') }, llave),
      ).toThrow(SecretoAdulteradoError);
    });

    it('el mensaje de error NO incluye el secreto ni la llave', () => {
      // Un error que se registra en los logs no puede ser una filtración.
      const cifrado = cifrar(TOKEN, llave);
      try {
        descifrar(cifrado, randomBytes(32));
        expect.fail('tendría que haber lanzado');
      } catch (err) {
        const mensaje = (err as Error).message;
        expect(mensaje).not.toContain(cifrado.ciphertext);
        expect(mensaje).not.toContain(llave.toString('base64'));
        expect(mensaje).not.toContain(TOKEN);
      }
    });
  });

  describe('La llave', () => {
    it('acepta 32 bytes en base64', () => {
      const buena = randomBytes(32).toString('base64');
      expect(leerLlave(buena)).toHaveLength(32);
    });

    it('⛔ rechaza una llave corta', () => {
      // Aceptar cualquier texto y derivar la llave de ahí sería aceptar
      // "clave123" como llave de 256 bits: el cifrado se vería igual de bien y
      // no protegería nada.
      expect(() => leerLlave(Buffer.from('clave123').toString('base64'))).toThrow(
        LlaveInvalidaError,
      );
    });

    it('⛔ rechaza una llave de puros ceros', () => {
      // Suena improbable hasta que alguien pone AAAA... para "ver si arranca".
      expect(() => leerLlave(Buffer.alloc(32).toString('base64'))).toThrow(LlaveInvalidaError);
    });

    it('el error explica cómo generar una buena', () => {
      // Un mensaje que sólo diga "llave inválida" hace que alguien invente una
      // a mano hasta que el largo dé.
      try {
        leerLlave('corta');
        expect.fail('tendría que haber lanzado');
      } catch (err) {
        expect((err as Error).message).toContain('randomBytes(32)');
      }
    });
  });

  describe('Pista', () => {
    it('muestra sólo los últimos cuatro', () => {
      expect(pista('APP_USR-abcdefghij-a3f9')).toBe('····a3f9');
    });

    it('un secreto corto no revela nada', () => {
      expect(pista('abc')).toBe('····');
    });
  });
});
