/**
 * Error de dominio. Lo lanzan los servicios; el filtro global lo traduce a HTTP.
 *
 * Los controladores NUNCA lanzan HttpException: la capa de dominio no debe
 * conocer códigos HTTP. Cuando este backend exponga gRPC o consuma la capa de
 * voz de la Fase 2, la traducción cambia en un solo archivo.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** code → status HTTP. Único lugar donde el dominio se cruza con el transporte. */
export const HTTP_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RESOURCE_GONE: 410,
  RATE_LIMITED: 429,

  // Dominio del spike
  SPIKE_DISABLED: 404, // 404 y no 403: no revelamos que el módulo existe
  SESSION_NOT_FOUND: 404,
  SESSION_ALREADY_ENDED: 409,
  LIVEKIT_UNAVAILABLE: 503,
  INVALID_WEBHOOK_SIGNATURE: 401,

  // Dominio de pagos (Sprint 0B)
  ORDER_NOT_FOUND: 404,
  // 409 y no 400: el pedido es válido, lo que pasa es que la orden está en un
  // estado que no lo admite. La app puede reintentar tras releer la orden.
  ORDER_NOT_PAYABLE: 409,
  PAYMENTS_DISABLED: 404,

  // 422 y no 400: el cuerpo está bien formado y los tipos son correctos. Lo
  // que falla es una regla: la política que el vendedor quiere publicar deja
  // al comprador por debajo del piso que le da la ley. El cliente no tiene que
  // corregir el JSON sino mostrarle el motivo a la persona.
  EXCHANGE_POLICY_INVALID: 422,

  // Moderación
  //
  // 409 y no 400: el reporte es válido, lo que pasa es que esta persona ya
  // reportó esto. La app tiene que poder mostrar "ya lo reportaste, lo estamos
  // revisando" en vez de un error genérico — hizo algo razonable.
  ALREADY_REPORTED: 409,
  REPORT_NOT_FOUND: 404,
  REPORT_TARGET_NOT_FOUND: 404,

  // Soporte
  //
  // 404 y no 403 para un ticket ajeno: confirmar que existe ya es
  // información. Y 404 y no 400 porque la app tiene que poder distinguir "no
  // encontramos esa conversación" de "mandaste algo mal" — con 400 muestra
  // "algo salió mal" en una pantalla donde lo correcto es "no existe".
  SUPPORT_TICKET_NOT_FOUND: 404,
  // 409: el ticket existe y es tuyo, pero está en un estado que no admite
  // mensajes nuevos. La app puede ofrecer abrir uno nuevo.
  SUPPORT_TICKET_CLOSED: 409,

  // Dominio de autenticación
  INVALID_TOKEN: 401,
  // 401 y no 403: la sesión se puede recuperar reiniciándola, y el cliente
  // necesita distinguir "volvé a entrar" de "no tenés permiso".
  SESSION_REVOKED: 401,
  IDENTITY_REJECTED: 401,
  ACCOUNT_SUSPENDED: 403,
  EMAIL_TAKEN: 409,
  PHONE_INVALID: 400,

  // ─── Dominio comercial ───
  SELLER_EXISTS: 409,
  SELLER_NOT_ACTIVE: 403,
  /**
   * 404 y no 403 para lo que no es propio.
   *
   * Responder 403 sobre un producto ajeno CONFIRMA que ese id existe. Con eso,
   * alguien puede enumerar el catálogo de la competencia probando ids: los que
   * dan 403 existen, los que dan 404 no.
   *
   * Con 404 uniforme, "no existe" y "no es tuyo" son indistinguibles desde
   * afuera. Adentro sí se distinguen: la bitácora registra el intento.
   */
  SELLER_NOT_FOUND: 404,
  STORE_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  IMAGE_NOT_FOUND: 404,

  SLUG_TAKEN: 409,
  SLUG_RESERVED: 422,
  SKU_TAKEN: 409,
  INVALID_PRICE: 422,
  VARIANT_COMBINATION_EXISTS: 409,
  TOO_MANY_IMAGES: 422,
  INVALID_FILE: 415,
  FILE_TOO_LARGE: 413,

  // ─── Dominio de inventario ───
  /**
   * 409 y no 400.
   *
   * El pedido era válido: pedir una unidad de una variante que existe está
   * bien escrito. Lo que pasa es que el estado del mundo cambió entre que la
   * persona vio el producto y tocó comprar. La app tiene que poder distinguir
   * "escribiste mal" de "te ganaron de mano", porque la respuesta al usuario
   * es completamente distinta.
   */
  OUT_OF_STOCK: 409,
  INVENTORY_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  /** La reserva ya está consumida, vencida o cancelada. */
  RESERVATION_NOT_ACTIVE: 409,
  /** Misma clave de idempotencia, cuerpo distinto. Casi siempre un bug del cliente. */
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  /** El vendedor quiso bajar el stock por debajo de lo ya reservado. */
  STOCK_BELOW_RESERVED: 409,
  /** El producto, la variante, la tienda o el vendedor no admiten venta. */
  NOT_PURCHASABLE: 409,
  QUANTITY_INVALID: 422,

  // ─── Dominio de órdenes y pagos ───
  ORDER_NOT_FOUND_V2: 404,
  /** La reserva venció antes de crear la orden. */
  RESERVATION_EXPIRED: 409,
  /** Esa reserva ya tiene una orden. */
  ORDER_ALREADY_EXISTS: 409,
  /** La orden está en un estado que no admite cobro. */
  ORDER_NOT_PAYABLE_V2: 409,
  /** Ya hay un cobro en vuelo. Lanzar otro cobraría dos veces. */
  PAYMENT_IN_FLIGHT: 409,
  PAYMENT_ALREADY_APPROVED: 409,
  /**
   * No sabemos si el cobro se procesó. 202 y no 4xx/5xx: la petición se
   * aceptó, el resultado llega después. La app tiene que consultar, no
   * reintentar a ciegas.
   */
  PAYMENT_STATE_UNKNOWN: 202,
  PAYMENT_REJECTED: 402,
  /** Se acreditó la plata pero ya no había stock. */
  LATE_PAYMENT_OUT_OF_STOCK: 409,
  REFUND_IN_PROGRESS: 409,
  ADDRESS_REQUIRED: 422,
  ADDRESS_NOT_FOUND: 404,
  /** El comprador no puede cambiar estados de preparación. */
  FULFILLMENT_NOT_ALLOWED: 403,
  INVALID_TRANSITION: 409,

  // ─── Entrega ───
  //
  // 422 y no 400: el cuerpo está bien formado —seis dígitos, ya lo validó el
  // DTO— y lo que falla es la regla. La app necesita distinguir "escribiste
  // cualquier cosa" de "el número no es ese", porque son dos mensajes
  // distintos para el repartidor.
  DELIVERY_CODE_INVALID: 422,
  DELIVERY_CODE_LOCKED: 422,
  /** Intentar `DELIVERED` sin pasar por el código. */
  DELIVERY_CODE_REQUIRED: 422,
};

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super('NOT_FOUND', `${what} no encontrado`, { id });
  }
}

export class SessionNotFoundError extends DomainError {
  constructor(id: string) {
    super('SESSION_NOT_FOUND', 'Sesión de spike no encontrada', { sessionId: id });
  }
}

export class LiveKitUnavailableError extends DomainError {
  constructor(operation: string, cause?: unknown) {
    super('LIVEKIT_UNAVAILABLE', 'LiveKit no está disponible', {
      operation,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
