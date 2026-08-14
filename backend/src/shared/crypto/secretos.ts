import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cifrado de secretos que hay que poder volver a leer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO ES PARA CONTRASEÑAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una contraseña se guarda con un hash y no se descifra nunca. Un token de
 * OAuth es lo contrario: hay que recuperarlo tal cual para poder usarlo contra
 * la API de Mercado Pago. Así que se **cifra**, no se hashea.
 *
 * ⛔ No usar esto para contraseñas. Si aparece la tentación, la respuesta es
 * `argon2` o `bcrypt`, no este archivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO Y NO UN GESTOR DE SECRETOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El comentario original de `SellerPaymentAccount` decía que los tokens irían
 * a un gestor de secretos y que en la base sólo quedaría una referencia. Es lo
 * correcto y sigue siendo el destino, pero hoy no existe ese gestor: montarlo
 * significa contratar un servicio, y esa decisión no se toma sin el dueño del
 * producto delante.
 *
 * La alternativa que se descartó —guardar el token en texto plano hasta que
 * exista el gestor— es peor de lo que parece: un access token de Mercado Pago
 * permite COBRAR en nombre del vendedor. En una columna de texto queda en los
 * respaldos, en las réplicas, en cualquier volcado que alguien haga para
 * depurar, y en la pantalla del primero que abra un cliente de base de datos.
 *
 * Lo que se hace en cambio es cifrado con sobre: el secreto vive cifrado en la
 * base y **la llave vive afuera**, en una variable de entorno del proceso. Un
 * volcado de la base, por sí solo, no sirve para nada.
 *
 * Lo que esto NO resuelve, y hay que tenerlo claro:
 *
 *   · quien tenga acceso al proceso —o a sus variables de entorno— puede
 *     descifrar todo. Un gestor de secretos con auditoría y rotación
 *     automática es estrictamente mejor;
 *   · la rotación de la llave es manual. Ver `VERSION_DE_LLAVE`.
 *
 * Es un piso decente, no el techo. Está anotado como deuda.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AES-256-GCM, NO AES-256-CBC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GCM es cifrado autenticado: además de ocultar el contenido, detecta si
 * alguien lo modificó. Con CBC, un atacante con acceso de escritura a la base
 * puede alterar el texto cifrado y el descifrado devuelve basura sin avisar —o
 * peor, algo controlado por él.
 *
 * Acá, alterar un byte hace que `decipher.final()` lance. Es exactamente lo que
 * queremos: fallar ruidosamente antes que usar un token adulterado.
 */

const ALGORITMO = 'aes-256-gcm';

/** 96 bits, que es el tamaño que GCM espera. */
const LARGO_IV = 12;

/** 128 bits. */
const LARGO_ETIQUETA = 16;

/**
 * La versión de la llave con la que se cifró.
 *
 * ─── Para qué sirve si hay una sola llave ───
 *
 * Para el día que haya dos. Rotar una llave sin esto significa descifrar y
 * volver a cifrar TODAS las filas en una sola operación, con el sistema
 * detenido, y sin forma de volver atrás si algo sale mal a la mitad.
 *
 * Con la versión guardada en cada fila, la rotación es: se agrega la llave
 * nueva, lo nuevo se cifra con ella, y lo viejo se sigue leyendo con la
 * anterior hasta que se migre de a poco. Cuesta un entero por fila.
 */
export const VERSION_DE_LLAVE = 1;

export interface SecretoCifrado {
  /** Texto cifrado en base64. */
  ciphertext: string;
  /** El vector de inicialización, en base64. Distinto en cada cifrado. */
  iv: string;
  /** La etiqueta de autenticación de GCM, en base64. */
  tag: string;
  version: number;
}

export class LlaveInvalidaError extends Error {
  constructor(motivo: string) {
    super(`La llave de cifrado de credenciales es inválida: ${motivo}`);
    this.name = 'LlaveInvalidaError';
  }
}

/**
 * Convierte la llave de la variable de entorno a bytes.
 *
 * Se exige base64 de exactamente 32 bytes. Aceptar una cadena de texto cruda y
 * derivar la llave de ahí sería aceptar `"clave123"` como llave de 256 bits: el
 * cifrado se vería igual de bien y no protegería nada.
 *
 * Se valida al arrancar, no al primer uso. Descubrir que la llave está mal la
 * primera vez que un vendedor conecta su cuenta —seis horas después del
 * despliegue— es descubrirlo de la peor forma.
 */
export function leerLlave(base64: string): Buffer {
  let llave: Buffer;
  try {
    llave = Buffer.from(base64, 'base64');
  } catch {
    throw new LlaveInvalidaError('no es base64 válido');
  }

  if (llave.length !== 32) {
    throw new LlaveInvalidaError(
      `tiene ${llave.length} bytes y hacen falta 32. Generá una con: ` +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  /**
   * Una llave de puros ceros pasa la comprobación de largo y no protege nada.
   *
   * Suena improbable hasta que alguien pone `AAAA...` para "probar si arranca"
   * y eso queda en producción. La comparación es de tiempo constante por
   * costumbre, no porque acá importe.
   */
  if (timingSafeEqual(llave, Buffer.alloc(32))) {
    throw new LlaveInvalidaError('son todos ceros');
  }

  return llave;
}

/**
 * Cifra un secreto.
 *
 * El IV es **aleatorio y distinto en cada llamada**. Reutilizarlo con la misma
 * llave rompe GCM por completo: con dos mensajes cifrados con el mismo par
 * (llave, IV) se puede recuperar el texto plano de los dos. Por eso se genera
 * acá adentro y no se acepta por parámetro.
 */
export function cifrar(textoPlano: string, llave: Buffer): SecretoCifrado {
  const iv = randomBytes(LARGO_IV);
  const cipher = createCipheriv(ALGORITMO, llave, iv);

  const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: cifrado.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    version: VERSION_DE_LLAVE,
  };
}

export class SecretoAdulteradoError extends Error {
  constructor() {
    // El mensaje NO incluye el texto cifrado ni la llave. Un error que se
    // registra en los logs no puede ser una filtración.
    super('El secreto guardado no se pudo descifrar: está corrupto o fue modificado');
    this.name = 'SecretoAdulteradoError';
  }
}

/**
 * Descifra un secreto.
 *
 * Lanza si la etiqueta no verifica. Ese fallo NO es un caso raro que se pueda
 * ignorar: significa que el contenido de la base no es el que escribimos, y
 * seguir adelante con lo que salga sería usar datos que alguien pudo haber
 * elegido.
 */
export function descifrar(secreto: SecretoCifrado, llave: Buffer): string {
  if (secreto.version !== VERSION_DE_LLAVE) {
    // Cuando exista la segunda llave, acá se elige cuál usar. Hoy una versión
    // distinta es un dato de otra instalación, y usar la llave actual daría un
    // error de autenticación confuso.
    throw new SecretoAdulteradoError();
  }

  try {
    const iv = Buffer.from(secreto.iv, 'base64');
    const tag = Buffer.from(secreto.tag, 'base64');
    if (iv.length !== LARGO_IV || tag.length !== LARGO_ETIQUETA) {
      throw new SecretoAdulteradoError();
    }

    const decipher = createDecipheriv(ALGORITMO, llave, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(Buffer.from(secreto.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretoAdulteradoError();
  }
}

/**
 * Los últimos caracteres de un secreto, para poder hablar de él sin exponerlo.
 *
 * Sirve para que alguien de soporte pueda confirmar "sí, es el token que
 * termina en `…a3f9`" sin que el token completo aparezca nunca en un log, en
 * un ticket ni en una captura de pantalla.
 *
 * Cuatro caracteres: suficientes para distinguir dos tokens, insuficientes
 * para reconstruir nada.
 */
export function pista(secreto: string): string {
  if (secreto.length <= 4) return '····';
  return `····${secreto.slice(-4)}`;
}
