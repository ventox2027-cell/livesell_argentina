import { randomInt, timingSafeEqual } from 'node:crypto';

import {
  cifrar,
  descifrar,
  desempaquetar,
  empaquetar,
  estaEmpaquetado,
  SecretoAdulteradoError,
} from '@/shared/crypto/secretos';

/**
 * El código de entrega.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PROBLEMA RESUELVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Entregado" es una afirmación sobre el mundo físico, y hasta ahora la hacía
 * unilateralmente quien tenía interés en que fuera cierta: el vendedor. Un
 * pedido podía figurar entregado sin que nadie hubiera recibido nada.
 *
 * El código lo tiene el comprador. El vendedor sólo puede marcar entregado si
 * se lo dicen, y eso sólo pasa si el paquete llegó. La confirmación deja de
 * depender de la palabra de una sola parte.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SE HASHEA — SE CIFRA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Va explicado porque contradice el reflejo habitual, y porque la decisión
 * cambió: durante un tiempo se guardó en texto plano.
 *
 * ─── Por qué el hash es imposible, no indeseable ───
 *
 * Un hash sirve cuando el secreto lo tiene una persona y el sistema sólo
 * necesita **verificarlo**. Acá el comprador tiene que poder **leerlo** cada
 * vez que abre su pedido: no es una contraseña que se memoriza, es un número
 * que se dice en la puerta cuando llega el repartidor, quizás días después.
 *
 * Con hash habría que mostrarlo una sola vez y que lo pierda quien reinstale la
 * app o cambie de teléfono. No es una decisión de seguridad: es que el sistema
 * dejaría de funcionar.
 *
 * ─── Por qué sí se cifra ───
 *
 * El cifrado con sobre (`shared/crypto/secretos.ts`) sí permite volver a leer,
 * y la llave vive en una variable de entorno, fuera de la base. Un respaldo, una
 * réplica o un volcado que alguien hizo para depurar dejan de contener códigos
 * utilizables.
 *
 * Lo que NO resuelve, y hay que tenerlo claro: quien tenga acceso al proceso
 * puede descifrar. Y la amenaza principal sigue siendo otra —un vendedor
 * marcando entregas que no hizo— contra la que lo que protege es que él nunca
 * ve el código, no el cifrado.
 *
 * Se hace igual porque cuesta casi nada y cubre una clase de incidente
 * completa: la filtración del contenido de la base sin acceso al servidor.
 *
 * ⚠️ El precio es real y hay que saberlo: **si se pierde la llave, los códigos
 * en curso no se pueden leer ni verificar**. Es la misma llave que cifra los
 * tokens de Mercado Pago, así que perderla ya era un incidente mayor.
 *
 * Lo demás, que no cambió:
 *
 *   · el vendedor **nunca** puede consultarlo: no está en ninguna respuesta
 *     suya, y el endpoint de confirmación sólo compara;
 *   · no aparece en logs (ver la redacción de Pino);
 *   · se compara en tiempo constante;
 *   · un solo uso, con tope de intentos y bloqueo temporal.
 */

/**
 * Seis dígitos.
 *
 * Se dice en voz alta en la puerta, muchas veces por gente apurada o mayor.
 * Ocho dígitos o alfanumérico bajarían un riesgo que ya está acotado por el
 * tope de intentos, a cambio de que la entrega se vuelva incómoda.
 *
 * Con seis dígitos y cinco intentos, la probabilidad de acertar a ciegas es
 * de 5 en un millón.
 */
export const LARGO_DEL_CODIGO = 6;

/** Cinco intentos y se bloquea. */
export const MAX_INTENTOS = 5;

/** Cuánto dura el bloqueo tras agotar los intentos. */
export const BLOQUEO_MINUTOS = 30;

/**
 * Genera un código.
 *
 * `randomInt` de `node:crypto` y no `Math.random()`: el segundo es predecible
 * a partir de unas pocas salidas, y con los códigos de otros pedidos a la vista
 * —los propios— alcanzaría para adivinar los ajenos.
 *
 * Se permiten ceros a la izquierda: descartarlos reduciría el espacio y
 * sesgaría los códigos, que es justo lo contrario de lo que se busca.
 */
export function generarCodigoDeEntrega(): string {
  const maximo = 10 ** LARGO_DEL_CODIGO;
  return String(randomInt(0, maximo)).padStart(LARGO_DEL_CODIGO, '0');
}

/**
 * Compara en tiempo constante.
 *
 * Con `===` el tiempo de respuesta depende de cuántos dígitos coinciden, y
 * eso permite adivinar el código de a un dígito en vez de probarlo entero.
 * Son seis dígitos y cinco intentos, así que la diferencia práctica es chica —
 * pero escribir la comparación insegura acá invita a copiarla a un lugar donde
 * sí importe.
 */
export function codigoCoincide(ingresado: string, esperado: string): boolean {
  const a = Buffer.from(ingresado.trim(), 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDADO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prepara un código para guardarlo en la base.
 *
 * ─── Por qué la llave es un parámetro y no `env` ───
 *
 * Este módulo se prueba sin base de datos y sin configuración. Leer `env` acá
 * adentro lo ataría al arranque de la aplicación y obligaría a montar medio
 * sistema para probar una función de doce líneas.
 *
 * ─── Por qué `null` es un valor aceptado ───
 *
 * Un servidor sin `CREDENTIALS_ENCRYPTION_KEY` —el arranque mínimo de alguien
 * que clona el repositorio— tiene que seguir funcionando. Guarda el código en
 * plano, que es exactamente lo que hacía antes de existir esta función.
 *
 * No es una puerta trasera silenciosa: sin esa llave tampoco hay Mercado Pago,
 * así que ese servidor no cobra ni entrega nada real.
 */
export function guardarCodigo(codigo: string, llave: Buffer | null): string {
  if (!llave) return codigo;
  return empaquetar(cifrar(codigo, llave));
}

/**
 * Lee un código guardado, cifrado o no.
 *
 * ─── Los códigos viejos ───
 *
 * Las órdenes despachadas antes de este cambio tienen seis dígitos en plano en
 * la columna. No se migran: en dos semanas no queda ninguna sin entregar, y una
 * migración que cifra filas es un script que puede fallar a la mitad y dejar
 * pedidos que nadie puede confirmar.
 *
 * ─── Por qué la condición es "son seis dígitos" y no "no parece un sobre" ───
 *
 * La segunda forma —devolver tal cual todo lo que no empiece con `v1.`— es la
 * que se escribió primero y es peligrosa: cualquier cosa que termine en esa
 * columna por un error de código sale de acá como si fuera un código válido.
 *
 * Lo legado tiene una forma exacta y conocida, garantizada por la restricción
 * que la base tenía cuando se escribió. Todo lo demás **tiene** que ser un
 * sobre, y si no lo es, es un error.
 *
 * Lanza `SecretoAdulteradoError` si no es ninguna de las dos cosas, o si estaba
 * cifrado y no se puede descifrar. Eso significa que la llave no es la que
 * corresponde o que alguien tocó la fila, y en los dos casos hay que fallar
 * ruidosamente.
 */
export function leerCodigoGuardado(guardado: string, llave: Buffer | null): string {
  if (esCodigoEnClaro(guardado)) return guardado;
  if (!estaEmpaquetado(guardado)) throw new SecretoAdulteradoError();
  if (!llave) throw new SecretoAdulteradoError();
  return descifrar(desempaquetar(guardado), llave);
}

/** La forma exacta de un código de antes del cifrado. */
function esCodigoEnClaro(valor: string): boolean {
  return valor.length === LARGO_DEL_CODIGO && /^[0-9]+$/.test(valor);
}

export type MotivoDeRechazo =
  | 'SIN_CODIGO'
  | 'BLOQUEADO'
  | 'NO_COINCIDE'
  | 'YA_ENTREGADO'
  | 'ESTADO_INVALIDO';

export interface EstadoDelCodigo {
  /** El código emitido, o `null` si el pedido todavía no se despachó. */
  codigo: string | null;
  intentos: number;
  bloqueadoHasta: Date | null;
  entregado: boolean;
  /** El estado de la orden, para saber si corresponde confirmar. */
  status: string;
}

export interface Veredicto {
  ok: boolean;
  motivo?: MotivoDeRechazo;
  /** Cuántos intentos quedan después de éste. */
  intentosRestantes: number;
  /** `true` si este intento agotó los intentos y disparó el bloqueo. */
  bloquear: boolean;
}

/**
 * Decide si un código ingresado confirma la entrega.
 *
 * Módulo puro, sin Prisma, por el mismo motivo que `order-state.ts`: es la
 * lógica donde un error deja marcar entregas ajenas o bloquea a un vendedor
 * legítimo, y tiene que poder probarse sin base de datos.
 */
export function verificarCodigo(
  ingresado: string,
  estado: EstadoDelCodigo,
  ahora: Date = new Date(),
): Veredicto {
  const restantes = Math.max(0, MAX_INTENTOS - estado.intentos);

  // Idempotente: reconfirmar una entrega ya hecha no es un error del vendedor.
  if (estado.entregado) {
    return { ok: true, motivo: 'YA_ENTREGADO', intentosRestantes: restantes, bloquear: false };
  }

  // Sólo se confirma lo que se despachó. Marcar entregado algo que todavía se
  // está preparando no significa nada.
  if (estado.status !== 'SHIPPED') {
    return { ok: false, motivo: 'ESTADO_INVALIDO', intentosRestantes: restantes, bloquear: false };
  }

  if (!estado.codigo) {
    return { ok: false, motivo: 'SIN_CODIGO', intentosRestantes: restantes, bloquear: false };
  }

  if (estado.bloqueadoHasta && estado.bloqueadoHasta > ahora) {
    return { ok: false, motivo: 'BLOQUEADO', intentosRestantes: 0, bloquear: false };
  }

  if (codigoCoincide(ingresado, estado.codigo)) {
    return { ok: true, intentosRestantes: restantes, bloquear: false };
  }

  const trasEsteIntento = restantes - 1;
  return {
    ok: false,
    motivo: 'NO_COINCIDE',
    intentosRestantes: Math.max(0, trasEsteIntento),
    bloquear: trasEsteIntento <= 0,
  };
}

/** Cuándo termina el bloqueo, a partir de ahora. */
export function finDelBloqueo(ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() + BLOQUEO_MINUTOS * 60_000);
}
