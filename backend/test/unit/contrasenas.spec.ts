import { describe, expect, it } from 'vitest';

import {
  contrasenaAceptable,
  contrasenaCoincide,
  hashearContrasena,
  LARGO_MINIMO_DE_CONTRASENA,
} from '@/shared/crypto/contrasenas';

/**
 * El hasheo de la contraseña de la cuenta de revisión.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES LA ÚNICA CONTRASEÑA DEL SISTEMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VendoX entra con Google o con Apple. Esto existe sólo para que quien revisa
 * la app en Google Play pueda entrar con credenciales tipeables.
 *
 * Que sea una sola no la hace menos importante: es una cuenta de vendedor
 * activa con tienda y productos, y si alguien la toma puede publicar en nombre
 * de VendoX.
 */
describe('Hashear', () => {
  it('el hash NO contiene la contraseña', () => {
    // Suena obvio y es el tipo de cosa que un "optimizador" rompe.
    return hashearContrasena('una-contrasena-larga-de-prueba').then((hash) => {
      expect(hash).not.toContain('una-contrasena');
      expect(hash).not.toContain('prueba');
    });
  });

  it('dos veces la misma contraseña da hashes distintos', async () => {
    /**
     * La sal es aleatoria en cada llamada. Sin eso, dos cuentas con la misma
     * contraseña tendrían el mismo hash, y una tabla precalculada las rompe a
     * las dos de una.
     */
    const a = await hashearContrasena('la-misma-contrasena');
    const b = await hashearContrasena('la-misma-contrasena');

    expect(a).not.toBe(b);
    // Pero las dos verifican.
    expect(await contrasenaCoincide('la-misma-contrasena', a)).toBe(true);
    expect(await contrasenaCoincide('la-misma-contrasena', b)).toBe(true);
  });

  it('lleva la versión del algoritmo adelante', () => {
    // Para poder cambiar de algoritmo sin tener que adivinar cómo se generó
    // cada hash guardado.
    return hashearContrasena('otra-contrasena-larga').then((hash) => {
      expect(hash.startsWith('scrypt$1$')).toBe(true);
    });
  });
});

describe('Verificar', () => {
  it('acepta la correcta', async () => {
    const hash = await hashearContrasena('la-contrasena-de-revision');
    expect(await contrasenaCoincide('la-contrasena-de-revision', hash)).toBe(true);
  });

  it('⛔ rechaza cualquier otra', async () => {
    const hash = await hashearContrasena('la-contrasena-de-revision');

    for (const intento of [
      'la-contrasena-de-revisio', // un carácter menos
      'la-contrasena-de-revisionn', // uno de más
      'La-Contrasena-De-Revision', // mayúsculas
      '',
      ' la-contrasena-de-revision', // espacio adelante
    ]) {
      expect(await contrasenaCoincide(intento, hash), JSON.stringify(intento)).toBe(false);
    }
  });

  it('⛔ un hash con formato roto devuelve false, no lanza', async () => {
    /**
     * Una excepción en un caso y `false` en otro es una diferencia observable
     * desde afuera: le dice a quien prueba que encontró algo distinto.
     */
    for (const roto of [
      '',
      'scrypt$1',
      'scrypt$1$sal',
      'scrypt$2$c2Fs$aGFzaA',
      'bcrypt$1$c2Fs$aGFzaA',
      'cualquier-cosa',
      'scrypt$1$$',
    ]) {
      await expect(contrasenaCoincide('lo-que-sea', roto)).resolves.toBe(false);
    }
  });

  it('normaliza el unicode antes de comparar', async () => {
    /**
     * `é` se puede escribir de dos formas —un carácter, o `e` más el acento— y
     * los teclados de Android y de escritorio no siempre eligen la misma. Sin
     * normalizar, la misma contraseña tipeada en dos teclados no coincide, y el
     * síntoma es "me anda en la compu pero no en el teléfono".
     */
    /**
     * Se escriben con secuencias de escape y NO con el carácter literal: dos
     * eñes tipeadas en el editor se ven iguales y probablemente sean la misma,
     * y entonces el test pasaría sin comprobar nada.
     */
    const descompuesta = 'contraña-larguisima'; // n + U+0303
    const precompuesta = 'contraña-larguisima'; // ñ

    // La comprobación de que el test prueba algo: son cadenas distintas.
    expect(descompuesta).not.toBe(precompuesta);
    expect(descompuesta.normalize('NFKC')).toBe(precompuesta.normalize('NFKC'));

    const hash = await hashearContrasena(descompuesta);
    expect(await contrasenaCoincide(precompuesta, hash)).toBe(true);
  });
});

describe('El mínimo', () => {
  it('exige doce caracteres', () => {
    expect(LARGO_MINIMO_DE_CONTRASENA).toBe(12);
    expect(contrasenaAceptable('corta')).toBe(false);
    expect(contrasenaAceptable('a'.repeat(12))).toBe(true);
  });

  it('los espacios al costado no cuentan', () => {
    // `'   abc   '` tiene doce caracteres y tres letras.
    expect(contrasenaAceptable('   abc   ')).toBe(false);
  });

  it('no exige mayúsculas ni símbolos, a propósito', () => {
    /**
     * Esas reglas producen `Password1!` y no mejoran nada. El largo es lo que
     * importa, y una frase larga en minúsculas es mejor que ocho caracteres con
     * un signo de admiración al final.
     */
    expect(contrasenaAceptable('cuatro palabras sin nada raro')).toBe(true);
  });
});
