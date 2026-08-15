import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hasheo de contraseñas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO ES `secretos.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/crypto/secretos.ts` CIFRA cosas que hay que volver a leer —el token
 * de Mercado Pago, el código de entrega—. Acá es al revés: una contraseña no se
 * recupera nunca, sólo se verifica. Si algún día alguien puede leer una
 * contraseña de VendoX, algo está muy mal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SCRYPT Y NO ARGON2 NI BCRYPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Argon2id es la recomendación actual y sería la elección para un sistema con
 * contraseñas de usuarios reales. Acá no las hay: VendoX entra con Google o con
 * Apple, y este módulo existe **sólo** para la cuenta de revisión de Google
 * Play. Una cuenta.
 *
 * Argon2 y bcrypt son dependencias nativas: se compilan al instalar, rompen en
 * cualquier imagen que no tenga las herramientas de build, y agregan una pieza
 * más al despliegue. Scrypt viene en `node:crypto`, está en el RFC 7914, y con
 * los parámetros de abajo es perfectamente adecuado para lo que se usa.
 *
 * ⚠️ Si algún día VendoX abre registro con contraseña para usuarios reales,
 * esto hay que revisarlo. Scrypt sigue siendo aceptable, pero a esa escala vale
 * la pena el costo de argon2id.
 *
 * ─── Los parámetros ───
 *
 * `N = 2^15` (32768), `r = 8`, `p = 1`. Es la configuración que la propia
 * documentación de Node sugiere para uso interactivo: unos 100 ms por hash en
 * hardware de servidor, y unos 32 MB de memoria — que es lo que encarece el
 * ataque con GPU, donde la memoria es el cuello de botella.
 */

/**
 * `scrypt` como promesa.
 *
 * Escrito a mano y no con `promisify`: los tipos de Node eligen la sobrecarga
 * de tres argumentos y pasar `options` da
 * `Expected 3 arguments, but got 4`. Envolverlo son seis líneas y deja los
 * parámetros explícitos, que es lo que importa acá.
 */
function derivar(
  contrasena: string,
  sal: Buffer,
  largo: number,
  opciones: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    scrypt(contrasena, sal, largo, opciones, (err, clave) => {
      if (err) rechazar(err);
      else resolver(clave);
    });
  });
}

const N = 32_768;
const R = 8;
const P = 1;
const LARGO_DE_CLAVE = 64;
const LARGO_DE_SAL = 16;

/**
 * `maxmem` explícito.
 *
 * El valor por defecto de Node es 32 MB, y `N = 2^15` con `r = 8` necesita
 * `128 * N * r` = exactamente 32 MB. Queda al filo y falla con
 * `Invalid scrypt params` en algunas versiones. Se pide el doble.
 */
const MAX_MEM = 64 * 1024 * 1024;

/** Prefijo del formato, para poder cambiar de algoritmo sin adivinar. */
const VERSION = 'scrypt$1';

/**
 * Hashea una contraseña.
 *
 * Devuelve `scrypt$1$<sal>$<hash>`, todo en base64url. Un solo campo de texto
 * que lleva adentro todo lo que hace falta para verificarlo: la sal no es
 * secreta y guardarla aparte sólo agrega una columna que alguien puede olvidar
 * de copiar.
 */
export async function hashearContrasena(contrasena: string): Promise<string> {
  const sal = randomBytes(LARGO_DE_SAL);
  const derivada = await derivar(contrasena.normalize('NFKC'), sal, LARGO_DE_CLAVE, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return `${VERSION}$${sal.toString('base64url')}$${derivada.toString('base64url')}`;
}

/**
 * ¿Es esta la contraseña?
 *
 * ─── Tiempo constante, y por qué acá sí importa ───
 *
 * `===` sobre el hash corta en el primer byte distinto. Ese tiempo se mide, y
 * con suficientes intentos se reconstruye el hash byte por byte — no la
 * contraseña, pero sí el objetivo del ataque offline.
 *
 * ─── Nunca lanza por una contraseña equivocada ───
 *
 * Devuelve `false` para todo: hash con formato raro, versión desconocida, sal
 * inválida. Una excepción en un caso y `false` en otro es una diferencia
 * observable desde afuera, y le dice a quien prueba si el usuario existe.
 */
export async function contrasenaCoincide(
  contrasena: string,
  hashGuardado: string,
): Promise<boolean> {
  const partes = hashGuardado.split('$');
  if (partes.length !== 4) return false;

  const [algoritmo, version, salBase64, hashBase64] = partes as [string, string, string, string];
  if (`${algoritmo}$${version}` !== VERSION) return false;

  try {
    const sal = Buffer.from(salBase64, 'base64url');
    const esperado = Buffer.from(hashBase64, 'base64url');
    if (sal.length !== LARGO_DE_SAL || esperado.length !== LARGO_DE_CLAVE) return false;

    const derivada = await derivar(contrasena.normalize('NFKC'), sal, LARGO_DE_CLAVE, {
      N,
      r: R,
      p: P,
      maxmem: MAX_MEM,
    });

    return timingSafeEqual(derivada, esperado);
  } catch {
    return false;
  }
}

/**
 * El mínimo que se le exige a una contraseña de revisión.
 *
 * Doce caracteres y nada más. Sin reglas de "una mayúscula y un símbolo": esas
 * reglas producen `Password1!` y no mejoran nada — el largo es lo que importa.
 *
 * Se valida en el script que la carga, no en el login: quien inicia sesión ya
 * tiene la contraseña que se le dio, y rechazarla ahí por corta sería filtrar
 * información sobre la política a quien está probando.
 */
export const LARGO_MINIMO_DE_CONTRASENA = 12;

export function contrasenaAceptable(contrasena: string): boolean {
  return contrasena.trim().length >= LARGO_MINIMO_DE_CONTRASENA;
}
