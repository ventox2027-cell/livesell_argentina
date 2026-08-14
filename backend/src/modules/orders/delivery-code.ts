import { randomInt, timingSafeEqual } from 'node:crypto';

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
 * POR QUÉ NO SE GUARDA HASHEADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fue una decisión deliberada y va explicada porque contradice el reflejo
 * habitual.
 *
 * Un hash sirve cuando el secreto lo tiene una persona y el sistema sólo
 * necesita **verificarlo**. Acá el comprador tiene que poder **leerlo** cada
 * vez que abre su pedido: no es una contraseña que se memoriza, es un número
 * que se muestra cuando llega el repartidor, quizás días después.
 *
 * Con hash habría que mostrarlo una sola vez y perderlo, o guardarlo cifrado —
 * y el cifrado con la clave en el mismo servidor protege contra un volcado de
 * base, no contra el acceso a la aplicación, que es el vector realista.
 *
 * Lo que sí se hace:
 *
 *   · el vendedor **nunca** puede consultarlo: no está en ninguna respuesta
 *     suya, y el endpoint de confirmación sólo compara;
 *   · no aparece en logs (ver la redacción de Pino);
 *   · se compara en tiempo constante;
 *   · un solo uso, con tope de intentos y bloqueo temporal.
 *
 * La amenaza real no es alguien leyendo la base: es un vendedor marcando
 * entregas que no hizo. Contra eso, el hash no aporta nada.
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
