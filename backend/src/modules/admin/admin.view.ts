/**
 * Qué ve el panel de administración, y qué no ve nunca.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES UNA CAPA APARTE Y NO `select` SUELTOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La tentación de un panel administrativo es devolver la fila entera: "somos
 * admin, que se vea todo". Eso está mal por dos razones distintas, y la
 * segunda es la que muerde.
 *
 * **La primera** es el principio de mínimo privilegio. Alguien de soporte
 * resolviendo "pagué y no veo la compra" no necesita el teléfono completo del
 * comprador ni su dirección. Cada dato mostrado sin necesidad es un dato que
 * se puede filtrar en una captura de pantalla, una sesión compartida o una
 * cuenta de admin comprometida.
 *
 * **La segunda** es que un `select: { ... }` disperso por veinte consultas es
 * imposible de auditar. El día que se agregue una columna sensible al modelo
 * —el token de OAuth de Mercado Pago de un vendedor, un documento de
 * identidad— hay que acordarse de excluirla en cada una de las veinte. Nadie
 * se acuerda de las veinte.
 *
 * Acá cada entidad tiene UNA función que decide su forma. Agregar una columna
 * sensible al esquema no la expone: hay que venir a escribirla.
 *
 * ─── El test que lo sostiene ───
 *
 * `test/unit/admin-sin-secretos.spec.ts` serializa la salida de todas estas
 * funciones y falla si aparece cualquier campo de la lista prohibida.
 */

/** Muestra lo justo para reconocerlo, no para reconstruirlo. */
export function enmascararEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const arroba = email.lastIndexOf('@');
  if (arroba <= 0) return '***';
  const local = email.slice(0, arroba);
  const dominio = email.slice(arroba + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${dominio}`;
}

/**
 * Últimos cuatro dígitos.
 *
 * Alcanza para que quien atiende confirme con la persona del otro lado que
 * hablan del mismo teléfono, y no alcanza para llamarla ni para usarlo en un
 * intento de recuperación de cuenta en otro servicio.
 */
export function enmascararTelefono(tel: string | null | undefined): string | null {
  if (!tel) return null;
  return tel.length <= 4 ? '****' : `${'*'.repeat(tel.length - 4)}${tel.slice(-4)}`;
}

// ─── Usuario ─────────────────────────────────────────────────────────────────

export interface UsuarioCrudo {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified?: boolean;
  phoneE164?: string | null;
  phoneVerified?: boolean;
  role: string;
  status: string;
  createdAt: Date;
  lastSeenAt?: Date | null;
  deletedAt?: Date | null;
}

export function verUsuario(u: UsuarioCrudo) {
  return {
    id: u.id,
    nombre: `${u.firstName} ${u.lastName}`.trim(),
    email: enmascararEmail(u.email),
    emailVerificado: u.emailVerified ?? false,
    telefono: enmascararTelefono(u.phoneE164),
    telefonoVerificado: u.phoneVerified ?? false,
    rol: u.role,
    estado: u.status,
    creadoEl: u.createdAt,
    ultimaActividadEl: u.lastSeenAt ?? null,
    eliminadoEl: u.deletedAt ?? null,
  };
}

// ─── Vendedor ────────────────────────────────────────────────────────────────

export interface VendedorCrudo {
  id: string;
  userId: string;
  displayName: string;
  slug: string;
  status: string;
  verificationStatus: string;
  createdAt: Date;
}

export function verVendedor(s: VendedorCrudo) {
  return {
    id: s.id,
    userId: s.userId,
    nombre: s.displayName,
    slug: s.slug,
    estado: s.status,
    verificacion: s.verificationStatus,
    creadoEl: s.createdAt,
  };
}

// ─── Producto ────────────────────────────────────────────────────────────────

export interface ProductoCrudo {
  id: string;
  storeId: string;
  name: string;
  slug: string;
  status: string;
  currency: string;
  basePriceCents: number;
  createdAt: Date;
  deletedAt?: Date | null;
}

export function verProducto(p: ProductoCrudo) {
  return {
    id: p.id,
    nombre: p.name,
    slug: p.slug,
    estado: p.status,
    storeId: p.storeId,
    moneda: p.currency,
    precioBaseCentavos: p.basePriceCents,
    creadoEl: p.createdAt,
    eliminadoEl: p.deletedAt ?? null,
  };
}

// ─── Orden ───────────────────────────────────────────────────────────────────

export interface OrdenCruda {
  id: string;
  reference: string;
  status: string;
  buyerId: string;
  sellerId: string;
  storeId: string;
  currency: string;
  itemsSubtotal: number;
  shippingAmount: number;
  discountAmount: number;
  grossAmount: number;
  platformFeeBps: number;
  platformFeeAmount: number;
  paymentProcessorFeeAmount?: number | null;
  sellerNetAmount: number;
  statusReason?: string | null;
  createdAt: Date;
  paidAt?: Date | null;
  confirmedAt?: Date | null;
  cancelledAt?: Date | null;
  expiredAt?: Date | null;
  refundedAt?: Date | null;
}

export function verOrden(o: OrdenCruda) {
  return {
    id: o.id,
    referencia: o.reference,
    estado: o.status,
    motivoEstado: o.statusReason ?? null,
    buyerId: o.buyerId,
    sellerId: o.sellerId,
    storeId: o.storeId,
    moneda: o.currency,
    /**
     * Todo en centavos enteros, igual que en la base.
     *
     * No se convierte a decimal acá: el panel muestra plata de gente real, y
     * un `/100` en el camino es exactamente donde aparecen los errores de
     * redondeo. Formatea el frontend, a partir del entero exacto.
     */
    dinero: {
      subtotal: o.itemsSubtotal,
      envio: o.shippingAmount,
      descuento: o.discountAmount,
      total: o.grossAmount,
      comisionPlataformaBps: o.platformFeeBps,
      comisionPlataforma: o.platformFeeAmount,
      comisionProcesador: o.paymentProcessorFeeAmount ?? null,
      netoVendedor: o.sellerNetAmount,
    },
    creadaEl: o.createdAt,
    pagadaEl: o.paidAt ?? null,
    confirmadaEl: o.confirmedAt ?? null,
    canceladaEl: o.cancelledAt ?? null,
    vencidaEl: o.expiredAt ?? null,
    devueltaEl: o.refundedAt ?? null,
  };
}

// ─── Intento de pago ─────────────────────────────────────────────────────────

export interface IntentoCrudo {
  id: string;
  orderId: string;
  provider: string;
  providerPaymentId?: string | null;
  status: string;
  amount: number;
  currency: string;
  paymentMethodType?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  failureCode?: string | null;
  failureMessageSafe?: string | null;
  processorFeeAmount?: number | null;
  createdAt: Date;
  approvedAt?: Date | null;
  lastCheckedAt?: Date | null;
}

/**
 * Un intento de cobro.
 *
 * ⚠️ Lo que NO sale de acá, y por qué cada uno:
 *
 *   · **`idempotencyKey`** — se deriva del token de la tarjeta. Exponerla es
 *     exponer un identificador estable de un medio de pago, que permite
 *     correlacionar compras de una misma tarjeta entre cuentas distintas.
 *   · **PAN y CVV** — nunca existieron en esta base y no van a existir. El
 *     diseño es SAQ-A: la tarjeta la tokeniza Mercado Pago dentro de un
 *     iframe y esos bytes no tocan nuestros servidores.
 *
 * `brand` y `lastFour` sí salen: es lo que permite decirle a alguien "el
 * intento con la Visa terminada en 3704 fue rechazado por fondos", que es
 * exactamente la conversación que soporte tiene que poder tener.
 *
 * `failureMessageSafe` es el mensaje ya saneado por el módulo de pagos. El
 * crudo del proveedor no se guarda.
 */
export function verIntentoDePago(a: IntentoCrudo) {
  return {
    id: a.id,
    orderId: a.orderId,
    estado: a.status,
    proveedor: a.provider,
    providerPaymentId: a.providerPaymentId ?? null,
    montoCentavos: a.amount,
    moneda: a.currency,
    metodo: a.paymentMethodType ?? null,
    tarjeta: a.brand || a.lastFour ? { marca: a.brand ?? null, ultimos4: a.lastFour ?? null } : null,
    fallo: a.failureCode
      ? { codigo: a.failureCode, mensaje: a.failureMessageSafe ?? null }
      : null,
    comisionProcesador: a.processorFeeAmount ?? null,
    creadoEl: a.createdAt,
    aprobadoEl: a.approvedAt ?? null,
    ultimaConsultaEl: a.lastCheckedAt ?? null,
  };
}

// ─── Devolución ──────────────────────────────────────────────────────────────

export interface DevolucionCruda {
  id: string;
  orderId: string;
  paymentAttemptId: string;
  provider: string;
  providerRefundId?: string | null;
  status: string;
  amount: number;
  reason: string;
  failureMessageSafe?: string | null;
  attempts: number;
  createdAt: Date;
  completedAt?: Date | null;
}

export function verDevolucion(r: DevolucionCruda) {
  return {
    id: r.id,
    orderId: r.orderId,
    paymentAttemptId: r.paymentAttemptId,
    proveedor: r.provider,
    providerRefundId: r.providerRefundId ?? null,
    estado: r.status,
    montoCentavos: r.amount,
    motivo: r.reason,
    ultimoError: r.failureMessageSafe ?? null,
    intentos: r.attempts,
    creadaEl: r.createdAt,
    completadaEl: r.completedAt ?? null,
  };
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

export interface WebhookCrudo {
  id: string;
  notificationId: string;
  topic: string;
  action?: string | null;
  resourceId?: string | null;
  signatureValid: boolean;
  rejectionReason?: string | null;
  processedAt?: Date | null;
  error?: string | null;
  receivedAt: Date;
}

/**
 * Un webhook recibido.
 *
 * ⚠️ **`headers` y `payload` NO salen.**
 *
 * Las cabeceras traen la firma del proveedor y a veces cabeceras de
 * autorización. El cuerpo de un webhook de Mercado Pago trae el objeto de pago
 * completo, con datos del pagador.
 *
 * Para operar alcanza con saber si la firma era válida, si se procesó, cuándo,
 * y con qué recurso. Si algún día hiciera falta el cuerpo para depurar, se
 * agrega un endpoint aparte que lo sanee explícitamente — no se abre éste.
 */
export function verWebhook(w: WebhookCrudo) {
  return {
    id: w.id,
    proveedor: 'mercadopago',
    notificationId: w.notificationId,
    tema: w.topic,
    accion: w.action ?? null,
    recursoId: w.resourceId ?? null,
    firmaValida: w.signatureValid,
    motivoRechazo: w.rejectionReason ?? null,
    procesadoEl: w.processedAt ?? null,
    error: w.error ?? null,
    recibidoEl: w.receivedAt,
  };
}

// ─── Auditoría ───────────────────────────────────────────────────────────────

export interface AuditoriaCruda {
  id: string;
  actorType: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  createdAt: Date;
}

export function verAuditoria(a: AuditoriaCruda) {
  return {
    id: a.id,
    actorTipo: a.actorType,
    actorId: a.actorId ?? null,
    accion: a.action,
    entidad: a.entityType,
    entidadId: a.entityId,
    motivo: a.reason ?? null,
    antes: a.before ?? null,
    despues: a.after ?? null,
    fecha: a.createdAt,
  };
}
