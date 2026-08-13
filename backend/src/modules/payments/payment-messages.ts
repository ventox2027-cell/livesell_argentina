/**
 * Traducción de los errores de Mercado Pago a algo que una persona entienda.
 *
 * ─── Por qué esto existe ───
 *
 * En la primera prueba de campo, un dígito mal tipeado en la tarjeta produjo
 * este mensaje en la pantalla del comprador:
 *
 *     Rechazado: invalid card_number_validation
 *
 * Es correcto, es preciso, y es inútil. La persona no sabe qué hacer con eso:
 * no le dice que revise el número, no le dice si el problema es la tarjeta o
 * el sistema, y no le dice si tiene sentido volver a intentar. En una compra
 * durante un vivo, ese mensaje es una venta perdida.
 *
 * Peor todavía: Mercado Pago **acepta el token igual** con un número mal
 * tipeado. El error aparece recién al cobrar, cuando la persona ya cree que
 * hizo todo bien.
 *
 * ─── Dos ejes, no uno ───
 *
 * Cada caso responde dos preguntas distintas:
 *
 *   · Qué le decimos a la persona.
 *   · ¿Puede arreglarlo ella? Eso decide si la interfaz muestra "reintentar",
 *     "corregir los datos" o "probá con otra tarjeta".
 *
 * Mezclar las dos cosas lleva a ofrecer "reintentar" cuando reintentar no
 * puede funcionar nunca, que es otra forma de perder al comprador.
 */

/** Qué puede hacer la persona a continuación. */
export type PaymentRemedy =
  /** Corregir lo que cargó y volver a enviar. */
  | 'CORREGIR_DATOS'
  /** El mismo medio de pago puede funcionar más tarde. */
  | 'REINTENTAR'
  /** Con esta tarjeta no va a andar: hace falta otra. */
  | 'OTRO_MEDIO'
  /** Tiene que hacer algo fuera de la app, típicamente llamar al banco. */
  | 'CONTACTAR_BANCO'
  /** No hay nada que hacer: se resuelve solo o lo resolvemos nosotros. */
  | 'ESPERAR';

export interface PaymentMessage {
  /** Texto para mostrar. Sin jerga, sin códigos, en segunda persona. */
  text: string;
  remedy: PaymentRemedy;
}

/**
 * Errores de validación previos al cobro, por código de causa.
 *
 * Son los que ocurren ANTES de que el banco vea nada: Mercado Pago rechaza la
 * petición por datos mal formados. Casi todos son corregibles por la persona.
 */
const POR_CAUSA: Record<string, PaymentMessage> = {
  '3032': { text: 'El código de seguridad no tiene la cantidad de números correcta.', remedy: 'CORREGIR_DATOS' },
  '3033': { text: 'El número de tarjeta está incompleto.', remedy: 'CORREGIR_DATOS' },
  '3034': { text: 'Revisá el número de la tarjeta: parece que hay un número mal.', remedy: 'CORREGIR_DATOS' },
  '3035': { text: 'Revisá el número de la tarjeta.', remedy: 'CORREGIR_DATOS' },
  '325': { text: 'La fecha de vencimiento está incompleta.', remedy: 'CORREGIR_DATOS' },
  '326': { text: 'Revisá la fecha de vencimiento.', remedy: 'CORREGIR_DATOS' },
  '221': { text: 'Falta el nombre del titular, como figura en la tarjeta.', remedy: 'CORREGIR_DATOS' },
  '214': { text: 'Falta el número de documento.', remedy: 'CORREGIR_DATOS' },
  '324': { text: 'El número de documento no es válido.', remedy: 'CORREGIR_DATOS' },
  // El token es de un solo uso y dura poco. No es culpa de la persona.
  '3003': { text: 'La sesión de pago venció. Ingresá la tarjeta de nuevo.', remedy: 'CORREGIR_DATOS' },
  '2062': { text: 'La sesión de pago venció. Ingresá la tarjeta de nuevo.', remedy: 'CORREGIR_DATOS' },
};

/**
 * Rechazos del banco o de Mercado Pago, por `status_detail`.
 *
 * Acá el cobro sí llegó a procesarse. La distinción que importa es entre lo
 * que la persona puede arreglar y lo que no.
 */
const POR_DETALLE: Record<string, PaymentMessage> = {
  cc_rejected_insufficient_amount: { text: 'La tarjeta no tiene fondos suficientes.', remedy: 'OTRO_MEDIO' },
  cc_rejected_bad_filled_security_code: { text: 'El código de seguridad es incorrecto.', remedy: 'CORREGIR_DATOS' },
  cc_rejected_bad_filled_date: { text: 'La fecha de vencimiento es incorrecta.', remedy: 'CORREGIR_DATOS' },
  cc_rejected_bad_filled_card_number: { text: 'Revisá el número de la tarjeta.', remedy: 'CORREGIR_DATOS' },
  cc_rejected_bad_filled_other: { text: 'Revisá los datos de la tarjeta.', remedy: 'CORREGIR_DATOS' },
  cc_rejected_call_for_authorize: {
    text: 'Tu banco necesita que autorices este pago. Llamalos y volvé a intentar.',
    remedy: 'CONTACTAR_BANCO',
  },
  cc_rejected_card_disabled: {
    text: 'La tarjeta está inhabilitada. Llamá a tu banco para activarla.',
    remedy: 'CONTACTAR_BANCO',
  },
  cc_rejected_card_error: { text: 'No se pudo procesar el pago con esa tarjeta.', remedy: 'OTRO_MEDIO' },
  cc_rejected_duplicated_payment: {
    text: 'Ya hiciste un pago por este monto. Si querés pagar de nuevo, usá otra tarjeta.',
    remedy: 'OTRO_MEDIO',
  },
  cc_rejected_high_risk: { text: 'El pago fue rechazado. Probá con otro medio de pago.', remedy: 'OTRO_MEDIO' },
  cc_rejected_max_attempts: {
    text: 'Se superó el límite de intentos con esta tarjeta. Probá con otra.',
    remedy: 'OTRO_MEDIO',
  },
  cc_rejected_invalid_installments: { text: 'Esa cantidad de cuotas no está disponible.', remedy: 'CORREGIR_DATOS' },
  cc_rejected_blacklist: { text: 'No pudimos procesar el pago.', remedy: 'OTRO_MEDIO' },
  cc_rejected_other_reason: { text: 'El banco rechazó el pago. Probá con otra tarjeta.', remedy: 'OTRO_MEDIO' },

  // Pendientes: el pago no falló, todavía no se resolvió.
  pending_contingency: {
    text: 'Estamos procesando el pago. Te avisamos apenas se acredite.',
    remedy: 'ESPERAR',
  },
  pending_review_manual: {
    text: 'Estamos revisando el pago. Te avisamos en unos minutos.',
    remedy: 'ESPERAR',
  },
  accredited: { text: 'Pago acreditado.', remedy: 'ESPERAR' },
};

const GENERICO: PaymentMessage = {
  text: 'No se pudo completar el pago. Probá de nuevo o usá otra tarjeta.',
  remedy: 'OTRO_MEDIO',
};

/** Cuando ni siquiera sabemos si se cobró. Nunca decir "rechazado" acá. */
export const MENSAJE_INCIERTO: PaymentMessage = {
  text: 'Estamos confirmando el pago con Mercado Pago. No lo intentes de nuevo todavía.',
  remedy: 'ESPERAR',
};

/**
 * Traduce la respuesta de Mercado Pago.
 *
 * Se mira primero el `status_detail`, que es lo más específico, y después las
 * causas del error. Si no se reconoce nada, un genérico honesto: es preferible
 * a mostrar un código interno que no le dice nada a nadie.
 */
export function describePaymentOutcome(params: {
  statusDetail?: string | null;
  /** Cuerpo de error de Mercado Pago, del que se extraen las causas. */
  errorBody?: unknown;
}): PaymentMessage {
  const detalle = params.statusDetail?.toLowerCase();
  if (detalle && POR_DETALLE[detalle]) return POR_DETALLE[detalle];

  for (const codigo of extractCauseCodes(params.errorBody)) {
    const encontrado = POR_CAUSA[codigo];
    if (encontrado) return encontrado;
  }

  return GENERICO;
}

/** Códigos de causa del cuerpo de error, tolerante a la forma que venga. */
export function extractCauseCodes(errorBody: unknown): string[] {
  if (errorBody == null || typeof errorBody !== 'object') return [];
  const causes = (errorBody as { cause?: unknown }).cause;
  if (!Array.isArray(causes)) return [];
  return causes
    .map((c) => (c as { code?: unknown })?.code)
    .filter((c): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String);
}
