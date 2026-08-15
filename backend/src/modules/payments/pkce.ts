import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE — Proof Key for Code Exchange (RFC 7636).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ AGREGA SOBRE EL `state`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Son dos defensas distintas y las dos hacen falta:
 *
 *   · el **`state`** ata el callback a la persona que inició la autorización.
 *     Sin él, un atacante autoriza con SU cuenta y hace que la víctima visite
 *     la URL del callback;
 *   · **PKCE** ata el CÓDIGO a la petición que lo pidió. Sin él, alguien que
 *     logre interceptar el código —del historial del navegador, de un log de
 *     proxy, de una redirección mal configurada— lo puede canjear desde otro
 *     lado.
 *
 * Lo que hace que funcione: el verificador **nunca viaja por el navegador**.
 * Sólo viaja su hash. Quien vea la URL de autorización ve el desafío, y del
 * desafío no se puede volver al verificador.
 *
 * ─── Por qué lo agregamos si nuestro cliente es confidencial ───
 *
 * Con `client_secret` en el servidor, PKCE no es obligatorio: un atacante que
 * intercepte el código igual necesita el secreto para canjearlo.
 *
 * Se agrega igual porque cubre exactamente el caso en que ese secreto se
 * filtre. Cuesta veinte líneas y una columna, y el día que el secreto aparezca
 * en el lugar equivocado —un log, una captura, un repositorio— la diferencia
 * entre PKCE y no tenerlo es si alguien puede conectar cuentas en nuestro
 * nombre.
 *
 * Archivo puro: es criptografía sobre cadenas y tiene que poder probarse sin
 * nada alrededor.
 */

/**
 * Largo del verificador, en bytes de entropía.
 *
 * El RFC pide entre 43 y 128 caracteres en base64url. 32 bytes dan 43
 * caracteres exactos, que es el mínimo — y el mínimo del RFC ya son 256 bits de
 * entropía, más que suficiente. Pedir más no agrega seguridad y hace la URL más
 * larga.
 */
const BYTES_DEL_VERIFICADOR = 32;

export interface ParDePkce {
  /** Se guarda en la base. **Nunca sale del servidor.** */
  verifier: string;
  /** Viaja en la URL de autorización. Es el hash del verificador. */
  challenge: string;
}

/**
 * Un par nuevo.
 *
 * `randomBytes` y no `Math.random()`: el verificador es lo único que impide
 * canjear un código interceptado, y una secuencia predecible no impide nada.
 */
export function generarPkce(): ParDePkce {
  const verifier = randomBytes(BYTES_DEL_VERIFICADOR).toString('base64url');
  return { verifier, challenge: desafioDe(verifier) };
}

/**
 * El desafío de un verificador: SHA-256 en base64url.
 *
 * ⛔ **S256, nunca `plain`.** El RFC permite mandar el verificador tal cual como
 * desafío, y eso anula PKCE por completo: quien vea la URL de autorización ve
 * el verificador y puede canjear el código. `plain` existe sólo para clientes
 * que no pueden calcular SHA-256, y nosotros somos un servidor Node.
 */
export function desafioDe(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** El método que se declara en la URL. Constante, para no escribirlo a mano. */
export const METODO_DE_DESAFIO = 'S256';
