import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DomainEvent, type DomainEventPayload } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { NotificationsService } from './notifications.service';
import { avisoDeEstado, esEstadoQueSeAvisa } from './estados-que-se-avisan';

/**
 * Los avisos de una venta: la orden, el pago y la reseña.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS EVENTOS YA SE EMITÍAN. FALTABA ESCUCHARLOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `domain-events.ts` lo decía con todas las letras: «se emiten ahora aunque no
 * los escuche nadie: el día que exista el suscriptor, el camino de la venta no
 * se toca». Éste es ese suscriptor.
 *
 * Cinco tipos de aviso estaban declarados en el enum, con sus categorías y su
 * semántica de obligatorios, y **nadie los creaba**. La campana quedaba muda
 * justo para lo que más importa: la plata.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN OYENTE Y NO UNA LÍNEA EN CADA SERVICIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque el camino del dinero no tiene por qué saber que existen las
 * notificaciones. `payments.service.ts` acredita un pago; si además tuviera que
 * acordarse de avisar, cada rama nueva del cobro sería una oportunidad de
 * olvidarse — y las ramas del cobro son muchas: la respuesta directa, el
 * webhook, el conciliador.
 *
 * Y sobre todo: **la guarda de idempotencia ya está donde tiene que estar.**
 * `acreditar()` publica `paymentApproved` sólo cuando su `updateMany`
 * condicional afectó una fila. Un webhook repetido no acredita dos veces, así
 * que tampoco publica dos veces, así que tampoco avisa dos veces. El aviso
 * hereda una garantía que ya existía en vez de inventar la suya.
 *
 * La segunda red es la `dedupeKey`, con índice único en la base. Ver abajo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NADA SENSIBLE VIAJA EN EL AVISO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ni DNI, ni teléfono, ni dirección, ni el código de entrega, ni los últimos
 * cuatro de la tarjeta. Un aviso se lee en la pantalla bloqueada de un teléfono
 * que puede estar sobre una mesa.
 *
 * Lo que va es: qué pasó, de qué pedido, y su referencia corta — la misma que
 * la persona usa para hablar con soporte.
 */
@Injectable()
export class VentasListener {
  private readonly logger = new Logger(VentasListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Se confirmó una venta. Se le avisa al VENDEDOR.
   *
   * ⚠️ Al vendedor, no al comprador: el comprador acaba de pagar y está
   * mirando la pantalla. Avisarle de su propia acción es ruido.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * EN `orderConfirmed`, Y ANTES ESTABA EN `orderCreated`
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Ahí estaba el bug, y el comentario que lo justificaba estaba equivocado:
   * decía que «una orden creada ya reservó el stock: es una venta empezando».
   *
   * Pero la orden se crea al ABRIR el checkout —`CheckoutSheet` la pide apenas
   * se monta— así que el vendedor recibía «¡Te compraron!» de alguien que
   * todavía no había visto la pantalla de pago, y que podía cerrarla y no
   * volver nunca. Reportado desde producción: varias notificaciones de compra
   * sin un solo pago.
   *
   * `CONFIRMED` es el estado donde VendoX considera que hay una venta: el pago
   * se acreditó Y el stock se consumió. En el medio queda `PAID`, que todavía
   * puede terminar en devolución si el producto se agotó mientras el pago
   * viajaba — avisar ahí sería prometer una venta que se va a deshacer.
   *
   * ─── La idempotencia se hereda, no se inventa ───
   *
   * `marcarConfirmada()` publica este evento dentro de un `updateMany`
   * condicional de `PAID` a `CONFIRMED`: la transición ES el candado y sólo la
   * primera llamada afecta una fila. Un webhook repetido de Mercado Pago no
   * confirma dos veces, así que tampoco publica dos veces, así que tampoco
   * avisa dos veces. La `dedupeKey` es la segunda red.
   */
  @OnEvent(DomainEvent.orderConfirmed)
  async alConfirmarseUnaVenta(evento: DomainEventPayload): Promise<void> {
    try {
      const orden = await this.prisma.order.findUnique({
        where: { id: evento.entityId },
        select: {
          id: true,
          reference: true,
          itemsSubtotal: true,
          seller: { select: { userId: true } },
          buyer: { select: { firstName: true } },
          items: { select: { productNameSnapshot: true }, take: 1 },
        },
      });
      if (!orden) return;

      const producto = orden.items[0]?.productNameSnapshot ?? 'un producto';
      const quien = nombreDeQuienCompra(orden.buyer?.firstName);

      await this.notifications.crear({
        userId: orden.seller.userId,
        type: 'ORDER_RECEIVED',
        title: '¡Te compraron!',
        // El nombre de pila y el producto. Nada más: la dirección, el teléfono
        // y el código de entrega están en el pedido, detrás de la sesión del
        // vendedor. Un aviso se lee en una pantalla bloqueada sobre una mesa.
        body: `${quien} compró ${producto}. Preparalo cuando puedas.`,
        data: { orderId: orden.id, referencia: orden.reference },
        /**
         * Una venta, un aviso. La clave es el id de la orden: si este oyente
         * se ejecutara dos veces —un reintento del bus, un despliegue en el
         * medio— el índice único de la base descarta el segundo.
         */
        dedupeKey: `order_received:${orden.id}`,
      });
    } catch (e) {
      // Un aviso que no salió no puede tumbar una venta que sí ocurrió.
      this.logger.error({ msg: 'no se pudo avisar la venta', orderId: evento.entityId, e });
    }
  }

  /**
   * Alguien apartó una unidad. Se le avisa al VENDEDOR.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * RESERVAR NO ES COMPRAR, Y EL AVISO TIENE QUE DECIRLO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Una reserva aparta stock por unos minutos y puede terminar en nada: se
   * vence, se suelta, o la persona cierra la app. Decirle «¡Te compraron!» a un
   * vendedor por eso es prometerle plata que quizá no llegue — y era
   * exactamente lo que pasaba.
   *
   * Por eso NO dice «preparalo cuando puedas»: todavía no hay nada que
   * preparar. Dice lo que pasó y nada más.
   *
   * ─── Un aviso por reserva, y las reservas son idempotentes ───
   *
   * `reserve()` publica este evento sólo cuando CREA una fila. Un reintento con
   * la misma clave de idempotencia devuelve la reserva anterior sin volver a
   * publicar, y reusar una reserva viva tampoco publica. La `dedupeKey` con el
   * id de la reserva es la segunda red.
   */
  @OnEvent(DomainEvent.reservationCreated)
  async alReservar(evento: DomainEventPayload): Promise<void> {
    try {
      const variantId = (evento.data as { productVariantId?: string } | undefined)
        ?.productVariantId;
      if (!variantId) return;

      const variante = await this.prisma.productVariant.findUnique({
        where: { id: variantId },
        select: {
          product: {
            select: {
              name: true,
              store: { select: { seller: { select: { userId: true } } } },
            },
          },
        },
      });
      if (!variante) return;

      const vendedor = variante.product.store.seller.userId;

      /**
       * ⚠️ Nadie se avisa a sí mismo.
       *
       * Un vendedor puede apartar su propio producto para probar la app, y
       * recibir «te reservaron» por algo que acaba de hacer es ruido.
       */
      if (vendedor === evento.actorId) return;

      const quien = await this.nombreDe(evento.actorId);

      await this.notifications.crear({
        userId: vendedor,
        type: 'RESERVATION_RECEIVED',
        title: 'Te reservaron',
        body: `${quien} reservó ${variante.product.name}.`,
        data: { productVariantId: variantId, reservationId: evento.entityId },
        dedupeKey: `reservation_received:${evento.entityId}`,
      });
    } catch (e) {
      // Un aviso que no salió no puede tumbar una reserva que sí ocurrió.
      this.logger.error({
        msg: 'no se pudo avisar la reserva',
        reservationId: evento.entityId,
        e,
      });
    }
  }

  /** El nombre de pila de quien hizo algo, o «Alguien» si no se puede saber. */
  private async nombreDe(userId: string | null | undefined): Promise<string> {
    if (!userId) return 'Alguien';

    const persona = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true },
    });

    return nombreDeQuienCompra(persona?.firstName);
  }

  /**
   * El pago se acreditó. Se le avisa al COMPRADOR.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * UN WEBHOOK REPETIDO NO PRODUCE DOS AVISOS
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Y la garantía no está acá: está en `acreditar()`. Ese método mueve la
   * orden con un `updateMany` condicionado al estado, y publica
   * `paymentApproved` **sólo si afectó una fila**. El segundo webhook —que
   * llega siempre, Mercado Pago los repite— encuentra la orden ya en `PAID`,
   * afecta cero filas, y no publica nada.
   *
   * Este oyente hereda esa garantía. La `dedupeKey` es la segunda red, por si
   * algún día aparece un camino que publique el evento sin esa guarda.
   */
  @OnEvent(DomainEvent.paymentApproved)
  async alAcreditarse(evento: DomainEventPayload): Promise<void> {
    const orderId = (evento.data as { orderId?: string } | undefined)?.orderId;
    if (!orderId) return;

    try {
      const orden = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, reference: true, buyerId: true },
      });
      if (!orden) return;

      await this.notifications.crear({
        userId: orden.buyerId,
        type: 'PAYMENT_APPROVED',
        title: 'Se acreditó tu pago',
        /**
         * ⚠️ Sin monto.
         *
         * Cuánto pagó alguien es información financiera, y esto se lee en una
         * pantalla bloqueada. El importe está en el pedido, detrás de la
         * sesión.
         */
        body: `Tu pedido ${orden.reference} está confirmado. Te avisamos cuando lo despachen.`,
        data: { orderId: orden.id, referencia: orden.reference },
        // Por pedido, no por intento: dos intentos aprobados del mismo pedido
        // no pueden existir, y si existieran es un solo aviso igual.
        dedupeKey: `payment_approved:${orden.id}`,
      });
    } catch (e) {
      this.logger.error({ msg: 'no se pudo avisar el pago', orderId, e });
    }
  }

  /**
   * El cobro se rechazó. Se le avisa al COMPRADOR.
   *
   * ⚠️ Sólo cuando el pedido quedó **realmente** en `PAYMENT_FAILED`.
   *
   * Es la diferencia entre un rechazo accionable y uno que no lo es: si otro
   * intento ya acreditó, el `updateMany` de la rama de rechazo afectó cero
   * filas y el pedido sigue pago. Avisar ahí sería decirle «te rechazaron el
   * pago» a alguien cuya compra salió bien.
   *
   * Se relee el estado en vez de confiar en el evento por ese motivo exacto.
   */
  @OnEvent(DomainEvent.paymentRejected)
  async alRechazarse(evento: DomainEventPayload): Promise<void> {
    const orderId = (evento.data as { orderId?: string } | undefined)?.orderId;
    if (!orderId) return;

    try {
      const orden = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, reference: true, buyerId: true, status: true, statusReason: true },
      });
      if (!orden) return;

      // La comprobación que hace accionable el aviso.
      if (orden.status !== 'PAYMENT_FAILED') return;

      await this.notifications.crear({
        userId: orden.buyerId,
        type: 'PAYMENT_REJECTED',
        title: 'No pudimos cobrar tu pedido',
        /**
         * El motivo sale de `statusReason`, que lo escribe
         * `describePaymentOutcome` — mensajes ya pensados para mostrarle a una
         * persona, sin códigos del procesador ni datos de la tarjeta.
         */
        body: `${orden.statusReason ?? 'El pago fue rechazado'}. Probá con otra tarjeta.`,
        data: { orderId: orden.id, referencia: orden.reference },
        /**
         * Por INTENTO, no por pedido.
         *
         * Es el único de los cinco donde repetir tiene sentido: alguien prueba
         * una tarjeta, la rechazan, prueba otra, la rechazan de nuevo. Son dos
         * rechazos distintos y merecen dos avisos.
         */
        dedupeKey: `payment_rejected:${evento.entityId}`,
      });
    } catch (e) {
      this.logger.error({ msg: 'no se pudo avisar el rechazo', orderId, e });
    }
  }

  /**
   * El vendedor movió el pedido. Se le avisa al COMPRADOR.
   *
   * ⚠️ Sólo en los estados que le cambian algo a quien espera. Ver
   * `estados-que-se-avisan.ts`: un pedido que pasa a «preparándose» importa;
   * uno que vuelve de un estado interno, no.
   */
  @OnEvent(DomainEvent.orderFulfillmentChanged)
  async alCambiarElEstado(evento: DomainEventPayload): Promise<void> {
    const datos = evento.data as { desde?: string; hacia?: string } | undefined;
    const hacia = datos?.hacia;
    if (!hacia || !esEstadoQueSeAvisa(hacia)) return;

    try {
      const orden = await this.prisma.order.findUnique({
        where: { id: evento.entityId },
        select: { id: true, reference: true, buyerId: true },
      });
      if (!orden) return;

      const texto = avisoDeEstado(hacia);
      if (!texto) return;

      await this.notifications.crear({
        userId: orden.buyerId,
        type: 'ORDER_STATUS',
        title: texto.title,
        body: `${texto.body} Pedido ${orden.reference}.`,
        data: { orderId: orden.id, referencia: orden.reference, estado: hacia },
        /**
         * Por pedido Y estado.
         *
         * Un pedido pasa por varios estados y cada uno merece su aviso; pero
         * volver a marcar el mismo estado —que la máquina de estados permite en
         * algún reintento— no puede avisar dos veces.
         */
        dedupeKey: `order_status:${orden.id}:${hacia}`,
      });
    } catch (e) {
      this.logger.error({ msg: 'no se pudo avisar el estado', orderId: evento.entityId, e });
    }
  }

  /**
   * Alguien dejó una reseña. Se le avisa al VENDEDOR.
   *
   * No lleva la calificación en el cuerpo. «Te dejaron 2 estrellas» en la
   * pantalla bloqueada, sin poder responder ni ver el comentario, es una mala
   * noticia sin contexto — y la reacción es no volver a abrir la app.
   */
  @OnEvent(DomainEvent.reviewCreated)
  async alRecibirUnaResena(evento: DomainEventPayload): Promise<void> {
    const datos = evento.data as { sellerUserId?: string } | undefined;
    if (!datos?.sellerUserId) return;

    try {
      await this.notifications.crear({
        userId: datos.sellerUserId,
        type: 'REVIEW_RECEIVED',
        title: 'Te dejaron una opinión',
        body: 'Alguien opinó sobre una compra. Podés responderle desde tu tienda.',
        data: { reviewId: evento.entityId },
        dedupeKey: `review_received:${evento.entityId}`,
      });
    } catch (e) {
      this.logger.error({ msg: 'no se pudo avisar la reseña', reviewId: evento.entityId, e });
    }
  }
}

/**
 * El nombre de pila de quien compró o reservó, para el aviso.
 *
 * ⚠️ SÓLO el nombre de pila. Ni apellido, ni correo, ni teléfono: un aviso se
 * lee en la pantalla bloqueada de un teléfono que puede estar sobre una mesa,
 * y el vendedor tiene los datos completos del pedido detrás de su sesión.
 *
 * «Alguien» cuando no hay nombre. Es honesto y se lee bien: «Alguien reservó
 * un buzo» dice lo mismo que hace falta.
 */
export function nombreDeQuienCompra(nombre: string | null | undefined): string {
  const limpio = nombre?.trim() ?? '';
  return limpio.length === 0 ? 'Alguien' : limpio;
}
