import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { portadaDe } from '@/shared/storage/url-publica';
import { CuponesService } from '@/modules/commerce/cupones.service';
import { resolverPrecio } from '@/modules/live/precio-de-vivo';
import { exigirHabilitada } from '@/shared/config/banderas';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { leerLlave } from '@/shared/crypto/secretos';
import { MetricsService } from '@/shared/observability/metrics.service';
import { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import { TasaDeComision } from '@/modules/sellers/tasa-de-comision.service';
import { exigirMayoriaDeEdad } from '@/modules/users/edad';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  admiteCancelacionDelComprador,
  esTransicionDelVendedor,
  puedeVencer,
  transicionValida,
} from './order-state';
import {
  finDelBloqueo,
  generarCodigoDeEntrega,
  guardarCodigo,
  leerCodigoGuardado,
  verificarCodigo,
} from './delivery-code';
import { calcularPrecio, referenciaDeOrden, verificarCoherencia } from './pricing';
import { costoDeEnvio, permiteRetiro, recargoAlComprador } from './shipping';

/**
 * Órdenes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODO LO QUE PUEDE CAMBIAR SE COPIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una orden guarda el nombre del producto, el precio, la variante, el SKU, la
 * foto y la dirección completa. No referencias: **copias**.
 *
 * El motivo es una pregunta que hay que poder responder dentro de dos años:
 * "¿qué compró esta persona, a qué precio y a qué dirección?". Si la orden
 * guardara sólo `productId`, la respuesta dependería de que el producto siga
 * existiendo, con el mismo nombre y el mismo precio. Ninguna de las tres cosas
 * se puede garantizar: el vendedor archiva productos, les cambia el nombre y
 * les sube el precio todos los días.
 *
 * Lo mismo con la dirección. Alguien se muda, actualiza su perfil, y de golpe
 * todas sus compras anteriores figuran enviadas a la casa nueva.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NADA DE PLATA VIENE DEL CLIENTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El cuerpo de `POST /orders` tiene exactamente dos campos: la reserva y la
 * dirección. Ni precio, ni subtotal, ni comisión, ni `sellerId`, ni moneda.
 *
 * Todo eso lo deriva el backend del producto real. Un DTO que aceptara
 * `unitPrice` sería un endpoint donde alguien compra un televisor por un peso.
 */

export class OrderNotFoundError extends DomainError {
  constructor() {
    super('ORDER_NOT_FOUND_V2', 'Pedido no encontrado');
  }
}

export class ReservationExpiredError extends DomainError {
  constructor() {
    super(
      'RESERVATION_EXPIRED',
      'Se te venció el tiempo para completar la compra. Probá de nuevo.',
    );
  }
}

export class AddressRequiredError extends DomainError {
  constructor() {
    super('ADDRESS_REQUIRED', 'Necesitamos una dirección de entrega antes de comprar');
  }
}

/** Lo que sale al cliente. Enumerado, no filtrado. */
const ORDER_SELECT = {
  id: true,
  reference: true,
  buyerId: true,
  sellerId: true,
  storeId: true,
  reservationId: true,
  status: true,
  currency: true,
  itemsSubtotal: true,
  shippingAmount: true,
  processorSurchargeAmount: true,
  shippingModeSnapshot: true,
  processorFeeModeSnapshot: true,
  pickupSelected: true,
  discountAmount: true,
  grossAmount: true,
  platformFeeBps: true,
  platformFeeAmount: true,
  paymentProcessorFeeAmount: true,
  sellerNetAmount: true,
  shippingAddress: true,
  statusReason: true,
  createdAt: true,
  paidAt: true,
  confirmedAt: true,
  cancelledAt: true,
  expiredAt: true,
  refundedAt: true,
  // La línea de tiempo del pedido. El estado dice dónde está; estas marcas
  // dicen cuánto tardó cada paso.
  preparingAt: true,
  readyAt: true,
  shippedAt: true,
  deliveredAt: true,
  // ⚠️ `deliveryCode` NO está acá a propósito: esta proyección la usan también
  // las respuestas del vendedor, y él nunca puede verlo.
} satisfies Prisma.OrderSelect;

/**
 * La forma de una orden tal como sale al cliente.
 *
 * Derivada de la proyección y no del modelo de Prisma: si fuera `Order`, el
 * tipo prometería campos que la proyección no trae —`buyerSnapshot`,
 * `updatedAt`— y el compilador dejaría pasar código que los lee y encuentra
 * `undefined` en producción.
 */
export type OrdenPublica = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
    private readonly sellerOAuth: SellerOAuthService,
    private readonly cupones: CuponesService,
    private readonly tasaDeComision: TasaDeComision,
  ) {}

  /**
   * La llave con la que se cifra el código de entrega, o `null` si no hay.
   *
   * Es la misma que cifra los tokens de Mercado Pago. No se guarda en un campo:
   * `leerLlave` valida en cada llamada, y el costo de eso —parsear 32 bytes de
   * base64— es irrelevante al lado de la consulta a la base que la acompaña
   * siempre.
   *
   * `null` y no una excepción cuando falta: un servidor recién clonado, sin
   * llave, tiene que poder despachar un pedido de prueba. Ver `guardarCodigo`.
   */
  private get llaveDeCodigos(): Buffer | null {
    return env.CREDENTIALS_ENCRYPTION_KEY ? leerLlave(env.CREDENTIALS_ENCRYPTION_KEY) : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convierte una reserva en una orden.
   *
   * ─── Por qué la reserva ES la clave de idempotencia ───
   *
   * `Order.reservationId` tiene un índice único. Eso hace que dos peticiones
   * simultáneas con la misma reserva no puedan crear dos órdenes: la segunda
   * choca contra el índice, se relee y se devuelve la que ganó.
   *
   * La cabecera `Idempotency-Key` se exige igual, porque obliga al cliente a
   * tener la disciplina que va a necesitar sí o sí en el cobro. Pero la
   * garantía real la da la base, no la cabecera — una cabecera se puede
   * olvidar, un índice único no.
   *
   * ─── Por qué no se consume el stock acá ───
   *
   * La orden no toca el inventario. Las unidades siguen apartadas por la
   * reserva hasta que el pago se apruebe de verdad. Consumirlas al crear la
   * orden significaría descontar stock por cada carrito abandonado.
   */
  async create(params: {
    buyerId: string;
    reservationId: string;
    addressId?: string;
    /** Sólo se respeta si la tienda ofrece retiro. Ver `costoDeEnvio`. */
    retiraEnPersona?: boolean;
    /**
     * Desde qué vivo se está comprando.
     *
     * Sirve para dos cosas: aplicar el precio exclusivo si lo hay, y poder
     * decir después cuánto vendió cada transmisión. No lleva el precio: eso lo
     * decide el servidor.
     */
    liveSessionId?: string;
    /**
     * El código del cupón, tal como lo tipeó la persona.
     *
     * ⚠️ El **código**, nunca el descuento. Se normaliza y se busca en la base
     * del vendedor de esta compra; cuánto descuenta lo decide el servidor.
     */
    cupon?: string;
  }): Promise<OrdenPublica> {
    const { buyerId, reservationId } = params;

    // Interruptor de emergencia. Apagar el checkout impide crear órdenes
    // NUEVAS; las que ya existen se pagan, se preparan y se entregan igual.
    exigirHabilitada('CHECKOUT_ENABLED');

    // 1 · La reserva, **sólo si es de esta persona**. Ajena = no encontrada.
    const reserva = await this.prisma.inventoryReservation.findFirst({
      where: { id: reservationId, userId: buyerId },
    });
    if (!reserva) throw new OrderNotFoundError();

    // 2 · ¿Ya tiene orden? Reintento o doble toque.
    const existente = await this.prisma.order.findUnique({
      where: { reservationId },
      select: ORDER_SELECT,
    });
    if (existente) {
      if (existente.buyerId !== buyerId) throw new OrderNotFoundError();
      return existente;
    }

    if (reserva.status !== 'ACTIVE') throw new ReservationExpiredError();
    if (reserva.expiresAt.getTime() <= Date.now()) throw new ReservationExpiredError();

    // 3 · El producto real. De acá sale el precio, no del cliente.
    const variante = await this.prisma.productVariant.findFirst({
      where: { id: reserva.productVariantId, deletedAt: null },
      select: {
        id: true,
        title: true,
        sku: true,
        priceOverrideCents: true,
        product: {
          select: {
            id: true,
            name: true,
            basePriceCents: true,
            status: true,
            deletedAt: true,
            images: { orderBy: { position: 'asc' }, take: 1, select: { storageKey: true } },
            store: {
              select: {
                id: true,
                status: true,
                shippingMode: true,
                shippingFlatAmount: true,
                processorFeeMode: true,
                seller: { select: { id: true, status: true, displayName: true } },
              },
            },
          },
        },
      },
    });
    if (!variante) throw new OrderNotFoundError();

    const producto = variante.product;
    const tienda = producto.store;

    /**
     * Un vendedor suspendido no recibe órdenes nuevas.
     *
     * Las que ya pagó alguien siguen existiendo y hay que gestionarlas —no se
     * borra historial— pero la venta nueva se corta acá.
     */
    if (tienda.seller.status !== 'ACTIVE') {
      throw new DomainError('SELLER_NOT_ACTIVE', 'Este vendedor no está operando en este momento');
    }
    if (tienda.status !== 'ACTIVE' || producto.status !== 'ACTIVE' || producto.deletedAt) {
      throw new DomainError('NOT_PURCHASABLE', 'Este producto ya no está disponible');
    }

    /**
     * Sin Mercado Pago conectado no se crea la orden.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * POR QUÉ ACÁ Y NO SÓLO AL COBRAR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Publicar y transmitir ya están bloqueados, así que en teoría no debería
     * existir un producto comprable de un vendedor sin cuenta. Pero sí hay un
     * caso real: **los productos publicados ANTES de la regla**. Esos siguen
     * publicados a propósito —no se rompe lo que ya estaba— y alguien puede
     * intentar comprarlos.
     *
     * Cortar recién al cobrar sería peor: la persona aparta stock, carga su
     * dirección, entra el número de tarjeta, y recién ahí se entera. Además
     * deja una orden huérfana y unidades reservadas cinco minutos por una
     * compra que nunca podía completarse.
     *
     * Se corta al crear, que es el primer momento en que se sabe.
     */
    await this.sellerOAuth.exigirParaVender(tienda.seller.id, 'comprar');

    // 4 · Dirección de entrega.
    const direccion = await this.direccionParaEnviar(buyerId, params.addressId);

    const comprador = await this.prisma.user.findUniqueOrThrow({
      where: { id: buyerId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneE164: true,
        birthDate: true,
      },
    });

    /**
     * VendoX es 18+.
     *
     * Acá y no al registrarse: meter un formulario de edad entre "Continuar con
     * Google" y el primer video es la forma más cara de perder a alguien que
     * todavía no sabe si la app le sirve. Es el mismo criterio con el que se
     * pide el teléfono.
     *
     * La fecha es DECLARADA, no verificada. Lo que esto sí y no logra está
     * explicado en `users/edad.ts`, y conviene leerlo antes de decir en algún
     * lado que la edad está comprobada.
     */
    exigirMayoriaDeEdad(comprador.birthDate, 'comprar');

    // 5 · Los números. Una sola función los calcula, y se comprueban antes de
    // escribir: la base tiene los mismos CHECK, pero fallar acá permite decir
    // QUÉ no cierra en vez de devolver el nombre de una restricción.
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL PRECIO DE VIVO SE RESUELVE ACÁ, EN EL SERVIDOR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La app manda `liveSessionId` para decir DESDE DÓNDE está comprando. No
     * manda el precio, y no podría: si el cuerpo de la petición pudiera decir
     * cuánto sale algo, cualquiera compraría a un peso.
     *
     * Con ese id se busca la fila de `live_session_products` y se evalúa la
     * ventana **con el reloj del servidor**. Una oferta que venció hace treinta
     * segundos no se aplica aunque la app todavía la esté mostrando.
     *
     * ⚠️ Y se valida que el vivo sea del MISMO vendedor que el producto. Sin
     * eso, alguien podría mandar el id del vivo de otra tienda —donde hay un
     * descuento del 80 %— y llevarse este producto a ese precio.
     */
    const precioDeLista = variante.priceOverrideCents ?? producto.basePriceCents;

    const enElVivo = params.liveSessionId
      ? await this.prisma.liveSessionProduct.findFirst({
          where: {
            liveSessionId: params.liveSessionId,
            productId: producto.id,
            // El vivo tiene que ser de este vendedor y estar al aire.
            session: {
              sellerId: tienda.seller.id,
              state: { in: ['LIVE', 'RECONNECTING'] },
            },
          },
          select: { livePriceCents: true, livePriceFrom: true, livePriceUntil: true },
        })
      : null;

    const precioResuelto = resolverPrecio(
      precioDeLista,
      enElVivo ?? { livePriceCents: null, livePriceFrom: null, livePriceUntil: null },
    );

    const unitPrice = precioResuelto.precioCentavos;

    /**
     * El envío y el recargo salen de la política de la tienda, no del cliente.
     *
     * Es la misma regla que el precio: si el cuerpo de la petición pudiera
     * decir cuánto sale el envío, alguien compraría con envío negativo. Lo
     * único que aporta quien compra es **si retira** —y sólo se respeta cuando
     * la tienda ofrece esa opción—.
     */
    const politica = {
      modo: tienda.shippingMode,
      montoFijo: tienda.shippingFlatAmount,
    };
    const retira = params.retiraEnPersona === true;
    const envio = costoDeEnvio(politica, retira);

    const itemsSubtotal = unitPrice * reserva.quantity;

    /**
     * El recargo del procesador queda CERRADO acá.
     *
     * Si el costo real que informa Mercado Pago después resulta mayor, la
     * diferencia la absorbe el vendedor. Cambiar el total después de que
     * alguien aceptó pagarlo no es una opción — ni técnica ni legalmente.
     */
    const recargo = recargoAlComprador({
      modo: tienda.processorFeeMode,
      itemsSubtotal,
      envio,
      bps: env.PROCESSOR_FEE_ESTIMATE_BPS,
      // Apagado en la beta: el comprador paga producto + envío y nada más. El
      // motivo, largo, está en `recargoAlComprador`.
      habilitado: env.BUYER_PROCESSOR_SURCHARGE_ENABLED,
    });

    /**
     * La comisión de ESTE vendedor, resuelta una sola vez.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * SE CALCULA ACÁ Y SE CONGELA EN LA ORDEN
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Business puede tener una tasa más baja según su volumen de las últimas
     * cuatro semanas. Como la ventana es móvil, la misma consulta mañana da
     * otro número — por eso el resultado se guarda en la orden y no se vuelve a
     * mirar nunca, igual que `platformFeeBps` desde siempre.
     *
     * Se resuelve UNA vez y se usa en los dos caminos de precio —con cupón y
     * sin cupón—. Consultarlo dos veces abriría la puerta a que una orden se
     * calcule con una tasa y se guarde con otra.
     *
     * `evaluadaEl` se fija acá, antes de la transacción, para que la ventana
     * medida y la que se registra sean exactamente la misma.
     */
    const evaluadaEl = new Date();
    const tasa = await this.tasaDeComision.para(tienda.seller.id, evaluadaEl);

    /**
     * El precio SIN cupón.
     *
     * El descuento no se puede calcular todavía: tomar el cupo de un cupón es
     * una escritura, y tiene que pasar adentro de la misma transacción que crea
     * la orden para que se deshaga junto con ella si algo falla. Se recalcula
     * ahí adentro. Ver más abajo.
     */
    const precioSinCupon = calcularPrecio({
      unitPrice,
      quantity: reserva.quantity,
      shippingAmount: envio,
      // Va en su propio campo, no sumado al envío: el checkout tiene que
      // mostrar una línea por concepto. Meterlo adentro del envío haría que el
      // comprador viera "Envío $4.200" cuando el vendedor cobra $3.500.
      processorSurchargeAmount: recargo,
      platformFeeBps: tasa.bps,
    });

    const orderId = newId('ord');

    /**
     * El precio definitivo sale de adentro de la transacción, pero se necesita
     * después para las métricas y la bitácora. Arranca en el precio sin cupón:
     * si no hay cupón, es el mismo.
     */
    let precioFinal = precioSinCupon;

    try {
      await this.prisma.$transaction(async (tx) => {
        /**
         * El cupón, si mandó uno.
         *
         * ⚠️ Lo que viaja desde la app es el **código**, nunca el descuento. El
         * servidor lo busca en su propia base, comprueba que sea de ESTE
         * vendedor y calcula cuánto descuenta. Si el cuerpo de la petición
         * pudiera decir «descuento: $9.900», cualquiera compraría a un peso.
         *
         * Un código que no aplica **corta el pedido** en vez de ignorarse:
         * alguien que escribió un cupón espera ese descuento, y enterarse
         * después de que se lo cobraron completo es peor que un error claro.
         */
        const cupon = params.cupon
          ? await this.cupones.tomarCupo(tx, {
              userId: buyerId,
              sellerId: tienda.seller.id,
              codigo: params.cupon,
              subtotalCentavos: precioSinCupon.itemsSubtotal,
            })
          : null;

        /**
         * Y se recalcula todo con el descuento adentro.
         *
         * No alcanza con restarlo del total: la comisión del 6 % se cobra sobre
         * el subtotal **ya descontado** —ver `baseDeComision`—, así que el
         * cálculo entero tiene que rehacerse.
         */
        const precio = cupon
          ? calcularPrecio({
              unitPrice,
              quantity: reserva.quantity,
              shippingAmount: envio,
              processorSurchargeAmount: recargo,
              discountAmount: cupon.descuentoCentavos,
              platformFeeBps: tasa.bps,
            })
          : precioSinCupon;

        const coherencia = verificarCoherencia(precio);
        if (!coherencia.ok) {
          // Nunca debería pasar. Si pasa, es un bug de cálculo y hay que verlo.
          this.logger.error({
            msg: 'precio incoherente al crear la orden',
            motivo: coherencia.motivo,
          });
          throw new DomainError('VALIDATION_FAILED', 'No pudimos calcular el total de tu compra');
        }

        precioFinal = precio;

        await tx.order.create({
          data: {
            id: orderId,
            reference: referenciaDeOrden(),
            buyerId,
            storeId: tienda.id,
            sellerId: tienda.seller.id,
            reservationId,
            status: 'PENDING_PAYMENT',
            ...precio,
            // Fotos de la política con la que se cobró. La tienda puede
            // cambiarla mañana; este pedido tiene que seguir explicando por qué
            // cobró lo que cobró.
            shippingModeSnapshot: tienda.shippingMode,
            processorFeeModeSnapshot: tienda.processorFeeMode,
            pickupSelected: retira && permiteRetiro(tienda.shippingMode),

            /**
             * Por qué se cobró ese porcentaje, y con qué se decidió.
             *
             * `precio.platformFeeBps` ya dice CUÁNTO. Esto dice POR QUÉ: sin
             * ello, dentro de seis meses una orden al 3 % y otra al 4 % del
             * mismo vendedor son indistinguibles de un error.
             *
             * Las tres últimas son las ENTRADAS de la decisión, congeladas
             * junto con ella. La ventana de volumen es móvil: recalcularla
             * mañana da otro número, así que sin guardarlas no hay forma de
             * reconstruir por qué esta orden cayó en el tramo que cayó.
             */
            platformFeeReason: tasa.motivo,
            platformFeeWeeklyVolume: tasa.promedioSemanal,
            platformFeeRefundRateBps: tasa.tasaDeDevolucionBps,
            platformFeeEvaluatedAt: evaluadaEl,

            /**
             * De dónde vino la compra y a qué precio estaba en lista.
             *
             * ⚠️ `liveSessionId` se guarda sólo si el vivo se VALIDÓ arriba
             * —del mismo vendedor y al aire—. Guardar el que mandó la app sin
             * validar dejaría que cualquiera atribuyera sus compras al vivo que
             * quisiera, y las estadísticas del vendedor serían inventadas.
             *
             * `listPriceCents` responde, seis meses después, por qué dos
             * órdenes del mismo producto tienen precios distintos.
             */
            liveSessionId: enElVivo ? (params.liveSessionId ?? null) : null,
            listPriceCents: precioDeLista,
            // Fotos: nada de esto se vuelve a leer de su tabla original.
            shippingAddress: direccion,
            buyerSnapshot: {
              id: comprador.id,
              nombre: `${comprador.firstName} ${comprador.lastName}`.trim(),
              email: comprador.email,
              telefono: comprador.phoneE164,
            },
          },
        });

        await tx.orderItem.create({
          data: {
            id: newId('oit'),
            orderId,
            productId: producto.id,
            productVariantId: variante.id,
            productNameSnapshot: producto.name,
            variantLabelSnapshot: variante.title,
            skuSnapshot: variante.sku,
            imageUrlSnapshot: portadaDe(producto.images),
            quantity: reserva.quantity,
            unitPrice,
            subtotal: precio.itemsSubtotal,
          },
        });

        /**
         * El canje va DESPUÉS de crear la orden: la fila apunta a ella por
         * clave foránea.
         *
         * Y sigue adentro de la transacción, así que si la restricción única
         * por (cupón, comprador) rechaza —la misma persona usándolo dos veces—
         * se deshace todo, orden incluida. Que es lo correcto: se estaba
         * creando con un descuento al que no tenía derecho.
         */
        if (cupon) {
          await this.cupones.registrarCanje(tx, { cupon, userId: buyerId, orderId });
        }
      });
    } catch (err) {
      // Carrera: otra petición con la misma reserva ganó. Se devuelve la suya,
      // que es exactamente lo que esperaba quien reintentó.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const ganadora = await this.prisma.order.findUnique({
          where: { reservationId },
          select: ORDER_SELECT,
        });
        if (ganadora && ganadora.buyerId === buyerId) return ganadora;
      }
      throw err;
    }

    this.metrics.orders.inc({ result: 'created' });
    this.events.publish(DomainEvent.orderCreated, {
      entityId: orderId,
      actorId: buyerId,
      data: { sellerId: tienda.seller.id, grossAmount: precioFinal.grossAmount },
    });
    void this.audit.log({
      action: 'order.created',
      entityType: 'order',
      entityId: orderId,
      actorId: buyerId,
      after: {
        reservationId,
        grossAmount: precioFinal.grossAmount,
        platformFeeBps: precioFinal.platformFeeBps,
        platformFeeAmount: precioFinal.platformFeeAmount,
        descuento: precioFinal.discountAmount,
      },
    });

    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: ORDER_SELECT,
    });
  }


  /**
   * Aplica un cupón a un pedido que todavía no se pagó.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ EXISTE ESTE MÉTODO Y NO ALCANZA CON EL DE `create`
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El checkout crea el pedido apenas se abre, para que la persona vea el total
   * mientras decide. El cupón se escribe después, en la pantalla del resumen —
   * que es donde todo el mundo espera escribirlo.
   *
   * ⚠️ Sólo sobre un pedido en `PENDING_PAYMENT` y **sin ningún intento de
   * cobro**. Cambiar el importe de algo que ya tiene una preferencia de pago
   * abierta en Mercado Pago dejaría al comprador pagando un número y a la orden
   * esperando otro, y la conciliación no cerraría nunca.
   */
  async aplicarCupon(orderId: string, buyerId: string, codigo: string): Promise<OrdenPublica> {
    // La pertenencia va en el WHERE. Un pedido ajeno no se encuentra: 404.
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: {
        id: true,
        status: true,
        sellerId: true,
        itemsSubtotal: true,
        shippingAmount: true,
        processorSurchargeAmount: true,
        discountAmount: true,
        platformFeeBps: true,
        _count: { select: { attempts: true } },
      },
    });
    if (!orden) throw new OrderNotFoundError();

    if (orden.status !== 'PENDING_PAYMENT') {
      throw new DomainError(
        'ORDER_NOT_EDITABLE',
        'Este pedido ya no se puede modificar',
        { estado: orden.status },
      );
    }

    /**
     * Ya intentó pagar.
     *
     * Aunque el intento haya fallado: la preferencia sigue viva del lado de
     * Mercado Pago y podría aprobarse tarde por el importe viejo.
     */
    if (orden._count.attempts > 0) {
      throw new DomainError(
        'ORDER_NOT_EDITABLE',
        'Ya empezaste a pagar este pedido. Cancelalo y hacelo de nuevo para usar un cupón',
      );
    }

    if (orden.discountAmount > 0) {
      throw new DomainError('ORDER_NOT_EDITABLE', 'Este pedido ya tiene un cupón aplicado');
    }

    await this.prisma.$transaction(async (tx) => {
      const cupon = await this.cupones.tomarCupo(tx, {
        userId: buyerId,
        sellerId: orden.sellerId,
        codigo,
        subtotalCentavos: orden.itemsSubtotal,
      });

      /**
       * Se recalcula TODO, no se resta el descuento del total.
       *
       * La comisión del 6 % se cobra sobre el subtotal ya descontado —ver
       * `baseDeComision`—, así que restar sólo del bruto dejaría al vendedor
       * pagando comisión sobre plata que no cobró.
       */
      const precio = calcularPrecio({
        unitPrice: orden.itemsSubtotal,
        quantity: 1,
        shippingAmount: orden.shippingAmount,
        processorSurchargeAmount: orden.processorSurchargeAmount,
        discountAmount: cupon.descuentoCentavos,
        platformFeeBps: orden.platformFeeBps,
      });

      const coherencia = verificarCoherencia(precio);
      if (!coherencia.ok) {
        this.logger.error({ msg: 'precio incoherente al aplicar cupón', motivo: coherencia.motivo });
        throw new DomainError('VALIDATION_FAILED', 'No pudimos recalcular el total');
      }

      /**
       * El estado va en el WHERE, otra vez.
       *
       * Entre la lectura de arriba y esta escritura, el pedido pudo vencer o
       * empezar a pagarse. Si cambió, `updateMany` afecta cero filas y la
       * transacción se corta sin haber tocado nada.
       */
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: 'PENDING_PAYMENT', discountAmount: 0 },
        data: {
          discountAmount: precio.discountAmount,
          grossAmount: precio.grossAmount,
          platformFeeAmount: precio.platformFeeAmount,
          sellerNetAmount: precio.sellerNetAmount,
        },
      });
      if (count === 0) {
        throw new DomainError('ORDER_NOT_EDITABLE', 'Este pedido ya no se puede modificar');
      }

      await this.cupones.registrarCanje(tx, { cupon, userId: buyerId, orderId });

      await this.audit.log({
        action: 'order.coupon_applied',
        entityType: 'order',
        entityId: orderId,
        actorId: buyerId,
        after: {
          codigo: cupon.codigo,
          descuento: cupon.descuentoCentavos,
          grossAmount: precio.grossAmount,
          platformFeeAmount: precio.platformFeeAmount,
        },
      });
    });

    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_SELECT });
  }

  /**
   * Saca el cupón del pedido.
   *
   * Devuelve el cupo: la persona no lo consumió. Sin esto, probar y arrepentirse
   * gastaría un uso de un cupón limitado — y encima el comprador no podría
   * volver a usarlo nunca, por la restricción de uno por persona.
   */
  async quitarCupon(orderId: string, buyerId: string): Promise<OrdenPublica> {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: {
        id: true,
        status: true,
        itemsSubtotal: true,
        shippingAmount: true,
        processorSurchargeAmount: true,
        platformFeeBps: true,
        cuponCanjeado: { select: { id: true, couponId: true } },
      },
    });
    if (!orden) throw new OrderNotFoundError();

    if (orden.status !== 'PENDING_PAYMENT') {
      throw new DomainError('ORDER_NOT_EDITABLE', 'Este pedido ya no se puede modificar');
    }
    if (!orden.cuponCanjeado) {
      // Sacar algo que no está deja el mismo estado final. No es un error.
      return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_SELECT });
    }

    const precio = calcularPrecio({
      unitPrice: orden.itemsSubtotal,
      quantity: 1,
      shippingAmount: orden.shippingAmount,
      processorSurchargeAmount: orden.processorSurchargeAmount,
      platformFeeBps: orden.platformFeeBps,
    });

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: 'PENDING_PAYMENT' },
        data: {
          discountAmount: 0,
          grossAmount: precio.grossAmount,
          platformFeeAmount: precio.platformFeeAmount,
          sellerNetAmount: precio.sellerNetAmount,
        },
      });
      if (count === 0) {
        throw new DomainError('ORDER_NOT_EDITABLE', 'Este pedido ya no se puede modificar');
      }

      await tx.couponRedemption.delete({ where: { id: orden.cuponCanjeado!.id } });
      // El cupo vuelve: no lo consumió.
      await tx.coupon.update({
        where: { id: orden.cuponCanjeado!.couponId },
        data: { usos: { decrement: 1 } },
      });
    });

    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_SELECT });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LECTURA
  // ═══════════════════════════════════════════════════════════════════════

  /** Una orden del comprador. Ajena = 404, no 403. */
  async forBuyer(orderId: string, buyerId: string) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: {
        ...ORDER_SELECT,
        /**
         * El código de entrega sale SÓLO acá.
         *
         * Es el detalle del comprador, resuelto con `buyerId` en el WHERE. El
         * vendedor tiene sus propios endpoints y ninguno lo incluye: si pudiera
         * leerlo, podría marcar entregado sin haber entregado y todo el
         * mecanismo no serviría para nada.
         *
         * Sale cifrado de la base y se descifra abajo, antes de devolverlo.
         */
        deliveryCode: true,
        deliveryCodeIssuedAt: true,
        // Para que la app sepa si ya opinó, sin pedir otra ruta. Sin esto
        // mostraría 'Calificar compra' sobre algo ya calificado y el backend
        // lo rechazaría con un error que la persona no entiende.
        review: { select: { id: true, rating: true, createdAt: true } },
        items: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            brand: true,
            lastFour: true,
            failureMessageSafe: true,
            createdAt: true,
            approvedAt: true,
          },
        },
        refunds: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, amount: true, createdAt: true, completedAt: true },
        },
      },
    });
    if (!orden) throw new OrderNotFoundError();

    /**
     * El código se descifra recién acá, en el último paso antes de salir.
     *
     * Y se oculta si el pedido ya está entregado: después de `DELIVERED` el
     * código no sirve para nada y seguir mostrándolo es dejar un secreto
     * inútil a la vista en una pantalla que la persona va a volver a abrir para
     * calificar la compra o pedir un cambio.
     */
    return {
      ...orden,
      deliveryCode:
        orden.deliveryCode && !orden.deliveredAt
          ? leerCodigoGuardado(orden.deliveryCode, this.llaveDeCodigos)
          : null,
    };
  }

  async listForBuyer(buyerId: string, query: { cursor?: string; limit: number }) {
    const filas = await this.prisma.order.findMany({
      where: { buyerId, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      select: {
        ...ORDER_SELECT,
        items: {
          select: {
            productNameSnapshot: true,
            variantLabelSnapshot: true,
            imageUrlSnapshot: true,
            quantity: true,
            unitPrice: true,
          },
        },
        store: { select: { name: true, slug: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return this.paginar(filas, query.limit);
  }

  /**
   * Las ventas de un vendedor.
   *
   * Ve lo que necesita para despachar —qué, cuánto, a quién y a dónde— y su
   * neto. No ve datos del cobro que no le sirven: con qué tarjeta pagaron o el
   * id del pago en Mercado Pago no le aportan nada y son información de otro.
   */
  async listForSeller(
    sellerId: string,
    query: { cursor?: string; limit: number; status?: OrderStatus },
  ) {
    const filas = await this.prisma.order.findMany({
      where: {
        sellerId,
        // Las órdenes sin pagar no son ventas: no ensucian el panel hasta que
        // hay plata de por medio.
        status: query.status ?? { notIn: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'] },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      select: {
        id: true,
        reference: true,
        status: true,
        currency: true,
        itemsSubtotal: true,
        shippingAmount: true,
        grossAmount: true,
        platformFeeAmount: true,
        sellerNetAmount: true,
        shippingAddress: true,
        buyerSnapshot: true,
        createdAt: true,
        paidAt: true,
        confirmedAt: true,
        items: true,
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return this.paginar(filas, query.limit);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRANSICIONES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cambia el estado de preparación. **Sólo el vendedor.**
   *
   * `sellerId` va en el WHERE: la orden de otro vendedor no es una operación
   * prohibida, es una que no encuentra nada.
   *
   * El comprador no puede tocar estos estados. "Ya lo empaqueté" es una
   * declaración sobre el mundo físico que sólo puede hacer quien tiene el
   * paquete en la mano.
   */
  async advanceFulfillment(orderId: string, sellerId: string, hacia: OrderStatus) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, sellerId },
      select: { id: true, status: true, deliveryCode: true },
    });
    if (!orden) throw new OrderNotFoundError();

    /**
     * ⛔ `DELIVERED` no se alcanza por este camino.
     *
     * "Entregado" es una afirmación sobre el mundo físico, y hasta acá la hacía
     * unilateralmente quien tiene interés en que sea cierta. Ahora exige el
     * código que tiene el comprador: `confirmarEntrega`.
     */
    if (hacia === 'DELIVERED') {
      throw new DomainError(
        'DELIVERY_CODE_REQUIRED',
        'Para marcar entregado hace falta el código que tiene quien compró',
      );
    }

    if (!esTransicionDelVendedor(orden.status, hacia)) {
      throw new DomainError(
        'INVALID_TRANSITION',
        `No se puede pasar de ${orden.status} a ${hacia}`,
        { desde: orden.status, hacia },
      );
    }

    /**
     * Al despachar se emite el código de entrega.
     *
     * Acá y no antes: el código sirve para confirmar que el paquete llegó, y
     * mostrárselo al comprador mientras el pedido todavía se está preparando lo
     * expone a un screenshot días antes de que haga falta.
     *
     * Si ya había uno —el vendedor volvió a marcar despachado— se conserva: el
     * comprador ya lo tiene anotado y cambiárselo por debajo lo dejaría
     * diciendo un número que no sirve.
     */
    const emitirCodigo = hacia === 'SHIPPED' && !orden.deliveryCode;

    const actualizada = await this.prisma.order.update({
      where: { id: orden.id },
      data: {
        status: hacia,
        ...this.marcaDeTiempo(hacia),
        ...(emitirCodigo
          ? {
              deliveryCode: guardarCodigo(generarCodigoDeEntrega(), this.llaveDeCodigos),
              deliveryCodeIssuedAt: new Date(),
              deliveryCodeAttempts: 0,
              deliveryCodeLockedUntil: null,
            }
          : {}),
      },
      select: ORDER_SELECT,
    });

    this.events.publish(DomainEvent.orderFulfillmentChanged, {
      entityId: orden.id,
      actorId: sellerId,
      data: { desde: orden.status, hacia },
    });
    void this.audit.log({
      action: 'order.fulfillment_changed',
      entityType: 'order',
      entityId: orden.id,
      actorId: sellerId,
      before: { status: orden.status },
      after: { status: hacia },
    });

    return actualizada;
  }

  /** Cuándo pasó cada paso de la preparación. */
  private marcaDeTiempo(hacia: OrderStatus): Record<string, Date> {
    const ahora = new Date();
    switch (hacia) {
      case 'PREPARING':
        return { preparingAt: ahora };
      case 'READY_TO_SHIP':
        return { readyAt: ahora };
      case 'SHIPPED':
        return { shippedAt: ahora };
      default:
        return {};
    }
  }

  /**
   * El vendedor confirma la entrega con el código del comprador.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EL VENDEDOR NUNCA VE EL CÓDIGO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * No sale en ninguna respuesta suya: ni en el detalle de la orden, ni en el
   * listado, ni en el error de un intento fallido. Este método sólo **compara**.
   *
   * Si pudiera consultarlo, todo el mecanismo no serviría para nada: podría
   * marcar entregado sin haber entregado, que es exactamente lo que hay que
   * impedir.
   *
   * ─── El bloqueo protege al comprador, no al sistema ───
   *
   * Cinco intentos y media hora de espera. No es contra la fuerza bruta —seis
   * dígitos y cinco intentos ya la hacen inviable— sino contra el vendedor que
   * prueba números a ver si pega y cierra la entrega sin haberla hecho.
   */
  async confirmarEntrega(orderId: string, sellerId: string, codigo: string) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, sellerId },
      select: {
        id: true,
        status: true,
        deliveryCode: true,
        deliveryCodeAttempts: true,
        deliveryCodeLockedUntil: true,
        deliveredAt: true,
      },
    });
    if (!orden) throw new OrderNotFoundError();

    const veredicto = verificarCodigo(codigo, {
      // Descifrado en memoria y sólo para comparar. No se devuelve, no se
      // registra y no sale de esta función.
      codigo: orden.deliveryCode
        ? leerCodigoGuardado(orden.deliveryCode, this.llaveDeCodigos)
        : null,
      intentos: orden.deliveryCodeAttempts,
      bloqueadoHasta: orden.deliveryCodeLockedUntil,
      entregado: orden.deliveredAt !== null,
      status: orden.status,
    });

    if (!veredicto.ok) {
      // El intento fallido se cuenta ANTES de responder, y en la misma
      // escritura que el bloqueo: leer, decidir y escribir por separado dejaría
      // una ventana para probar en paralelo.
      if (veredicto.motivo === 'NO_COINCIDE') {
        await this.prisma.order.update({
          where: { id: orden.id },
          data: {
            deliveryCodeAttempts: { increment: 1 },
            ...(veredicto.bloquear ? { deliveryCodeLockedUntil: finDelBloqueo() } : {}),
          },
        });
      }

      /**
       * Queda registrado SIEMPRE, con quién y cuándo.
       *
       * Varios fallidos sobre pedidos distintos es la señal de un vendedor
       * probando números, y sin este rastro no se ve.
       *
       * ⚠️ No se registra el código ingresado: sería guardar intentos de
       * adivinar un secreto al lado del secreto.
       */
      /**
       * Se ESPERA la escritura, a diferencia del resto del servicio.
       *
       * En los demás casos el registro es un rastro para investigar después y
       * puede ir en segundo plano. Acá es la evidencia de que alguien está
       * probando números para cerrar una entrega que no hizo: si se pierde
       * porque el proceso se reinició en el medio, se pierde justo el dato que
       * justificaba mirar.
       */
      await this.audit.log({
        action: 'order.delivery_code_failed',
        entityType: 'order',
        entityId: orden.id,
        actorId: sellerId,
        after: { motivo: veredicto.motivo, intentosRestantes: veredicto.intentosRestantes },
      });

      throw new DomainError(
        veredicto.motivo === 'BLOQUEADO' ? 'DELIVERY_CODE_LOCKED' : 'DELIVERY_CODE_INVALID',
        veredicto.motivo === 'BLOQUEADO'
          ? 'Demasiados intentos. Probá de nuevo en un rato.'
          : 'El código no coincide.',
        { intentosRestantes: veredicto.intentosRestantes },
      );
    }

    // Reconfirmar algo ya entregado no vuelve a escribir ni a auditar.
    if (orden.deliveredAt) {
      return this.prisma.order.findUniqueOrThrow({
        where: { id: orden.id },
        select: ORDER_SELECT,
      });
    }

    /**
     * La entrega y el contador de ventas del vendedor, en la MISMA transacción.
     *
     * `sellers.sales_count` es el «327 ventas» del perfil público. Si se
     * escribiera aparte y esa segunda escritura fallara, el número quedaría
     * atrasado para siempre: nada lo recalcula solo, y nadie se entera de que
     * está mal porque no hay con qué compararlo.
     *
     * Cuenta ENTREGAS, no pedidos pagos. Ver `stores/reputacion.ts`.
     */
    const [entregada] = await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orden.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          deliveryCodeAttempts: 0,
          deliveryCodeLockedUntil: null,
        },
        select: ORDER_SELECT,
      }),
      this.prisma.seller.update({
        where: { id: sellerId },
        data: { salesCount: { increment: 1 } },
      }),
    ]);

    this.events.publish(DomainEvent.orderFulfillmentChanged, {
      entityId: orden.id,
      actorId: sellerId,
      data: { desde: orden.status, hacia: 'DELIVERED' },
    });
    await this.audit.log({
      action: 'order.delivered',
      entityType: 'order',
      entityId: orden.id,
      actorId: sellerId,
      before: { status: orden.status },
      after: { status: 'DELIVERED' },
    });

    return entregada;
  }

  /** El comprador se arrepiente antes de pagar. */
  async cancelByBuyer(orderId: string, buyerId: string) {
    const orden = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId },
      select: { id: true, status: true, reservationId: true },
    });
    if (!orden) throw new OrderNotFoundError();

    if (!admiteCancelacionDelComprador(orden.status)) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Este pedido ya no se puede cancelar',
        { status: orden.status },
      );
    }

    const actualizada = await this.prisma.order.update({
      where: { id: orden.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), statusReason: 'Cancelado por vos' },
      select: ORDER_SELECT,
    });

    this.metrics.orders.inc({ result: 'cancelled' });
    this.events.publish(DomainEvent.orderCancelled, {
      entityId: orden.id,
      actorId: buyerId,
      data: { reservationId: orden.reservationId },
    });
    void this.audit.log({
      action: 'order.cancelled',
      entityType: 'order',
      entityId: orden.id,
      actorId: buyerId,
      before: { status: orden.status },
    });

    return actualizada;
  }

  /**
   * Marca vencidas las órdenes que nadie pagó.
   *
   * ─── La condición delicada ───
   *
   * Sólo vencen las que están en `PENDING_PAYMENT` o `PAYMENT_FAILED`. Una
   * orden con un cobro en vuelo —`PROCESSING_PAYMENT`— **no vence nunca por
   * tiempo**, aunque su reserva ya no exista.
   *
   * El motivo: si ese cobro se aprobó y todavía no nos enteramos, marcarla
   * vencida sería quedarse con la plata de alguien. El conciliador tiene que
   * resolverla primero; recién cuando se sabe que no hubo cobro, puede vencer.
   *
   * Es exactamente el mismo error que ya cometimos en el spike con las órdenes
   * trabadas en `PROCESSING`, visto desde el otro lado.
   */
  async expireStale(limite = 200): Promise<{ revisadas: number; vencidas: number }> {
    const corte = new Date(Date.now() - env.ORDER_EXPIRATION_GRACE_SECONDS * 1000);

    const posibles = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
        createdAt: { lt: corte },
      },
      select: { id: true, status: true, buyerId: true, reservationId: true },
      orderBy: { createdAt: 'asc' },
      take: limite,
    });

    /**
     * Se filtra por el estado de la reserva en una segunda consulta.
     *
     * `Order.reservationId` es una columna suelta, sin relación declarada, a
     * propósito: una clave foránea ataría el ciclo de vida de una orden PAGADA
     * al de una reserva que puede vencerse y limpiarse. Una venta tiene que
     * sobrevivir a la reserva que la originó.
     *
     * El costo es una consulta más por barrido, sobre a lo sumo 200 ids.
     */
    const idsDeReserva = posibles.map((o) => o.reservationId).filter((id): id is string => !!id);

    const activas = new Set(
      idsDeReserva.length === 0
        ? []
        : (
            await this.prisma.inventoryReservation.findMany({
              where: { id: { in: idsDeReserva }, status: 'ACTIVE' },
              select: { id: true },
            })
          ).map((r) => r.id),
    );

    // Vence la que no tiene reserva, o cuya reserva ya no está viva.
    const candidatas = posibles.filter(
      (o) => !o.reservationId || !activas.has(o.reservationId),
    );

    let vencidas = 0;
    for (const orden of candidatas) {
      try {
        // La condición va en el WHERE del UPDATE: entre que se leyó la
        // candidata y ahora, alguien pudo haber empezado a pagar.
        const { count } = await this.prisma.order.updateMany({
          where: { id: orden.id, status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] } },
          data: {
            status: 'EXPIRED',
            expiredAt: new Date(),
            statusReason: 'Se venció el tiempo para pagar',
          },
        });
        if (count === 0) continue;

        vencidas += 1;
        this.metrics.orders.inc({ result: 'expired' });
        this.events.publish(DomainEvent.orderExpired, {
          entityId: orden.id,
          actorId: null,
          data: { buyerId: orden.buyerId },
        });
      } catch (err) {
        this.logger.error({
          msg: 'no se pudo vencer una orden',
          orderId: orden.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { revisadas: candidatas.length, vencidas };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNOS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Dirección de entrega, como foto.
   *
   * Se copia entera en la orden. Cambiar la dirección del perfil mañana no
   * puede reescribir a dónde se mandó una compra de hoy.
   */
  private async direccionParaEnviar(
    userId: string,
    addressId?: string,
  ): Promise<Prisma.InputJsonValue> {
    const direccion = await this.prisma.userAddress.findFirst({
      where: {
        userId,
        deletedAt: null,
        ...(addressId ? { id: addressId } : { isDefault: true }),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!direccion) throw new AddressRequiredError();

    return {
      recipientFullName: direccion.recipientFullName,
      documentType: direccion.documentType,
      documentNumber: direccion.documentNumber,
      phoneE164: direccion.phoneE164,
      street: direccion.street,
      number: direccion.number,
      floor: direccion.floor,
      apartment: direccion.apartment,
      city: direccion.city,
      province: direccion.province,
      postalCode: direccion.postalCode,
      references: direccion.references,
    };
  }

  private paginar<T extends { id: string }>(filas: T[], limit: number) {
    const hayMas = filas.length > limit;
    const items = hayMas ? filas.slice(0, limit) : filas;
    return { items, nextCursor: hayMas ? (items[items.length - 1]?.id ?? null) : null };
  }

  /** Expuesto para los tests y para el conciliador. */
  puedeVencerEstado(status: OrderStatus): boolean {
    return puedeVencer(status);
  }

  /** Expuesto para los tests. */
  transicionEsValida(desde: OrderStatus, hacia: OrderStatus): boolean {
    return transicionValida(desde, hacia);
  }
}
