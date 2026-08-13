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
