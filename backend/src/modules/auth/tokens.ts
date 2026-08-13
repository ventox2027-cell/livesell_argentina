import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Piezas criptográficas de las sesiones.
 *
 * Archivo aparte, sin Nest ni Prisma, por la misma razón que `order-state.ts`:
 * es donde un error se traduce en cuentas ajenas, y tiene que poder probarse
 * a martillazos sin base de datos.
 *
 * ─── El reparto de responsabilidades ───
 *
 * **Access token**: un JWT firmado, corto (15 min), que el backend valida sin
 * tocar la base. Es lo que hace que cada petición cueste una verificación de
 * firma y no una consulta.
 *
 * **Refresh token**: NO es un JWT. Es un secreto aleatorio opaco, largo, del
 * que sólo guardamos el hash. La diferencia importa: un JWT de refresco no se
 * puede revocar sin una lista negra, y toda la seguridad del módulo depende de
 * poder cortar una sesión desde el servidor.
 *
 * El precio es una consulta a la base por refresco, que ocurre una vez cada 15
 * minutos por dispositivo. Barato para lo que compra.
 */

/** Bytes de entropía del refresh token. 32 = 256 bits. */
const REFRESH_TOKEN_BYTES = 32;

export interface AccessTokenClaims {
  /** `sub`: id del usuario. */
  sub: string;
  role: string;
  /**
   * Id de la sesión (la familia del refresh token).
   *
   * Va en el access token para poder correlacionar en los logs qué sesión hizo
   * qué, y para invalidar por sesión si algún día hace falta.
   */
  sid: string;
  /** Emitido en, en segundos. */
  iat: number;
  /** Expira en, en segundos. */
  exp: number;
}

/**
 * Genera un refresh token nuevo.
 *
 * Devuelve el valor en claro —que se manda al cliente UNA sola vez y no se
 * guarda— y su hash, que es lo único que toca la base.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  // base64url y no hex: mismo nivel de entropía en un tercio menos de
  // caracteres, y sin caracteres que necesiten escaparse en una URL.
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256 del token, sin sal.
 *
 * Sin sal a propósito, y no es un descuido. Una contraseña se saltea porque es
 * corta y adivinable; hay que hacer cada intento caro. Un token de 256 bits
 * aleatorios no se adivina ni con todo el cómputo del planeta, así que un hash
 * lento sólo agregaría latencia a cada refresco.
 *
 * Lo que sí hace falta es que la búsqueda por hash sea directa —un índice
 * UNIQUE— y con sal por token eso sería imposible sin recorrer la tabla.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const HEX = /^[0-9a-f]*$/i;

/**
 * Comparación en tiempo constante de dos hashes en hexadecimal.
 *
 * La validación de formato NO es decorativa: `Buffer.from('zz', 'hex')` no
 * falla, devuelve un buffer vacío. Sin la comprobación, dos cadenas basura
 * idénticas se comparan como IGUALES, y cualquier valor que no parsee se
 * convierte en un buffer vacío que coincide con otro buffer vacío.
 */
export function safeCompareHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!HEX.test(a) || !HEX.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Extrae el token del encabezado `Authorization`.
 *
 * Tolerante con el esquema —`bearer`, `Bearer`, `BEARER`— y estricto con todo
 * lo demás: un encabezado raro devuelve `null` y no una cadena a medias que
 * después falle en la verificación con un error confuso.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const partes = header.trim().split(/\s+/);
  if (partes.length !== 2) return null;
  if (partes[0]!.toLowerCase() !== 'bearer') return null;
  const token = partes[1]!;
  return token.length > 0 ? token : null;
}

/**
 * Normaliza un email para usarlo como identificador de cuenta.
 *
 * Sin esto, "Juan@Gmail.com " y "juan@gmail.com" son dos cuentas distintas, y
 * la persona pierde su historial de compras según cómo haya escrito el mail el
 * día que se registró.
 *
 * NO se aplican reglas propias de cada proveedor —quitar los puntos de Gmail,
 * por ejemplo—: son distintas en cada uno, cambian con el tiempo, y aplicarlas
 * mal fusiona cuentas de personas diferentes. Eso sí sería grave.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normaliza un teléfono argentino a E.164.
 *
 * En Argentina esto es un campo minado: la gente escribe `11 5555-6666`,
 * `011 15 5555 6666`, `+54 9 11 5555 6666` y todas son la misma persona. El
 * `9` de celular y el `15` histórico son la fuente de la mitad de los
 * duplicados en cualquier base argentina.
 *
 * Devuelve `null` si no se puede normalizar con confianza. Preferimos rechazar
 * y que la persona corrija a guardar un número que después no recibe el aviso
 * de que su pedido salió.
 */
export function normalizePhoneAr(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');

  // ── 1. Prefijo de país ──
  if (d.startsWith('+54')) d = d.slice(3);
  else if (d.startsWith('0054')) d = d.slice(4);
  else if (d.startsWith('54') && d.length > 10) d = d.slice(2);
  // Un "+" que sobrevivió es de otro país: no lo sabemos normalizar.
  if (d.includes('+')) return null;

  // ── 2. Prefijos de discado nacional ──
  // El 0 de larga distancia no existe en E.164.
  if (d.startsWith('0')) d = d.slice(1);
  // El 9 marca celular. Se saca acá y se repone al final, siempre.
  if (d.startsWith('9')) d = d.slice(1);

  if (!/^\d+$/.test(d)) return null;

  // ── 3. El 15 ──
  //
  // Va entre el código de área y el número de abonado, así que no se puede
  // borrar a ciegas: "1554..." puede ser el 15 de un número porteño o parte
  // del abonado de otro lado.
  //
  // La regla que sí es confiable es la longitud: un número argentino tiene
  // SIEMPRE 10 dígitos de área + abonado. Si hay 12, sobran exactamente dos, y
  // esos dos son el 15. Se prueba cada largo de código de área válido
  // —2 para el 11, 3 para 351 o 223, 4 para 2966— y se acepta el que deje 10.
  let nacional = d;
  if (d.length === 12) {
    const candidato = [2, 3, 4]
      .filter((areaLen) => d.slice(areaLen, areaLen + 2) === '15')
      .map((areaLen) => d.slice(0, areaLen) + d.slice(areaLen + 2))
      .find((n) => n.length === 10);
    if (!candidato) return null;
    nacional = candidato;
  }

  if (!/^\d{10}$/.test(nacional)) return null;
  // Un número que arranca en 0 después de todo esto no es válido.
  if (nacional.startsWith('0')) return null;

  return `+549${nacional}`;
}
