import { describe, expect, it } from 'vitest';

import {
  extractBearer,
  generateRefreshToken,
  hashRefreshToken,
  normalizeEmail,
  normalizePhoneAr,
  safeCompareHash,
} from '../../src/modules/auth/tokens';

describe('refresh tokens', () => {
  it('genera tokens distintos cada vez', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 500; i += 1) vistos.add(generateRefreshToken().token);
    expect(vistos.size).toBe(500);
  });

  it('tiene entropía suficiente', () => {
    // 32 bytes en base64url ⇒ 43 caracteres. Un token corto es un token
    // adivinable, y de eso depende que nadie entre a una cuenta ajena.
    const { token } = generateRefreshToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('no usa caracteres que haya que escapar', () => {
    // base64url: viaja en JSON, encabezados y URLs sin transformarse.
    for (let i = 0; i < 100; i += 1) {
      expect(generateRefreshToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('el hash es determinista y el token no se puede deducir de él', () => {
    const { token, hash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tokens distintos dan hashes distintos', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('safeCompareHash', () => {
  it('reconoce hashes iguales', () => {
    const { hash } = generateRefreshToken();
    expect(safeCompareHash(hash, hash)).toBe(true);
  });

  it('rechaza hashes distintos', () => {
    expect(safeCompareHash(generateRefreshToken().hash, generateRefreshToken().hash)).toBe(false);
  });

  it('no explota con basura', () => {
    expect(safeCompareHash('', '')).toBe(true);
    expect(safeCompareHash('no-es-hex', 'no-es-hex')).toBe(false);
    expect(safeCompareHash('abc', 'abcd')).toBe(false);
  });
});

describe('extractBearer', () => {
  it('extrae el token', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('acepta el esquema en cualquier capitalización', () => {
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('BEARER abc')).toBe('abc');
  });

  it('tolera espacios de más', () => {
    expect(extractBearer('  Bearer   abc  ')).toBe('abc');
  });

  it('⛔ rechaza cualquier otra cosa en vez de devolver algo a medias', () => {
    // Devolver una cadena parcial haría que el error apareciera después, en la
    // verificación de firma, con un mensaje que no señala la causa.
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('abc')).toBeNull();
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer('Bearer a b')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('pasa a minúscula y recorta', () => {
    expect(normalizeEmail('  Juan@Gmail.com ')).toBe('juan@gmail.com');
  });

  it('⛔ NO aplica reglas propias de cada proveedor', () => {
    // Quitar los puntos de Gmail parece inteligente y fusiona cuentas de
    // personas distintas. Ese error no se puede deshacer.
    expect(normalizeEmail('juan.perez@gmail.com')).toBe('juan.perez@gmail.com');
    expect(normalizeEmail('juan+tienda@gmail.com')).toBe('juan+tienda@gmail.com');
  });
});

describe('normalizePhoneAr', () => {
  it('normaliza las formas en que la gente escribe un celular porteño', () => {
    // Todas son la misma persona. Sin normalizar, son cinco cuentas.
    const esperado = '+5491155556666';
    for (const entrada of [
      '+5491155556666',
      '5491155556666',
      '+54 9 11 5555-6666',
      '011 15 5555 6666',
      '11 5555 6666',
      '1155556666',
      '0111555556666',
    ]) {
      expect(normalizePhoneAr(entrada), entrada).toBe(esperado);
    }
  });

  it('normaliza códigos de área del interior', () => {
    // Córdoba (351) y Mar del Plata (223).
    expect(normalizePhoneAr('0351 15 555 6666')).toBe('+5493515556666');
    expect(normalizePhoneAr('+54 9 223 555 6666')).toBe('+5492235556666');
  });

  it('⛔ devuelve null cuando no puede normalizar con confianza', () => {
    // Preferimos que la persona corrija a guardar un número que después no
    // recibe el aviso de que su pedido salió.
    expect(normalizePhoneAr('')).toBeNull();
    expect(normalizePhoneAr('123')).toBeNull();
    expect(normalizePhoneAr('no es un teléfono')).toBeNull();
    expect(normalizePhoneAr('+1 555 123 4567')).toBeNull();
    expect(normalizePhoneAr('11 5555 66660000')).toBeNull();
  });

  it('es idempotente', () => {
    // Normalizar dos veces tiene que dar lo mismo: si no, cada guardado
    // cambiaría el número y se perderían las notificaciones.
    const una = normalizePhoneAr('011 15 5555 6666')!;
    expect(normalizePhoneAr(una)).toBe(una);
  });
});
