import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { MetricsService } from '@/shared/observability/metrics.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  cruzoUmbral,
  disponibles,
  huellaDePeticion,
  vistaPublica,
  type ReservationStatus,
} from './reservations';

/**
 * Inventario y reservas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA DECISIÓN QUE DEFINE ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que NO se hace acá, en ningún camino:
 *
 *     const inv = await prisma.inventory.findUnique(...)   // 1. leer
 *     if (inv.onHand - inv.reserved >= qty) {              // 2. decidir
 *       await prisma.inventory.update(...)                 // 3. escribir
 *     }
 *
 * Entre el paso 1 y el 3 hay una ventana. Durante un vivo esa ventana son
 * microsegundos y pasan cien peticiones por ella: las cien leen "queda 1", las
 * cien deciden que sí, y las cien escriben. Se vendieron cien unidades de una.
 *
 * Y no se arregla achicando la ventana. Se arregla eliminándola: **el que
 * decide es el motor**, en una sola sentencia donde la condición y la
 * escritura son la misma operación:
 *
 *     UPDATE inventory
 *        SET reserved = reserved + $qty
 *      WHERE id = $id AND (on_hand - reserved) >= $qty
 *
 * PostgreSQL serializa las escrituras sobre una fila. La primera petición toma
 * el bloqueo, escribe y libera; la segunda vuelve a evaluar el WHERE contra el
 * valor YA actualizado. Cuando no queda nada, el UPDATE afecta cero filas. Cero
 * filas es la respuesta: OUT_OF_STOCK.
 *
 * Sin reintentos, sin bloqueo optimista, sin `SELECT FOR UPDATE`, sin Redis.
 *
 * ─── Y si igual hay un bug ───
 *
 * La tabla tiene `CHECK (reserved <= on_hand)`. Si algún día alguien escribe
 * un UPDATE sin la condición, la transacción explota en vez de sobrevender.
 * Es preferible un error 500 ruidoso a una unidad vendida dos veces.
 */

export class OutOfStockError extends DomainError {
  constructor(disponible: number) {
    super('OUT_OF_STOCK', 'No queda stock disponible', { disponible });
  }
}

export class ReservationNotFoundError extends DomainError {
  constructor() {
    super('RESERVATION_NOT_FOUND', 'Reserva no encontrada');
  }
}

export class ReservationNotActiveError extends DomainError {
  constructor(status: ReservationStatus) {
    super('RESERVATION_NOT_ACTIVE', 'Esa reserva ya no está activa', { status });
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'Esa clave de idempotencia ya se usó con otro pedido',
    );
  }
}

export class NotPurchasableError extends DomainError {
  constructor(motivo: string) {
    super('NOT_PURCHASABLE', 'Este producto no está disponible para comprar', { motivo });
  }
}

export class StockBelowReservedError extends DomainError {
  constructor(reserved: number) {
    super(
      'STOCK_BELOW_RESERVED',
      `No podés bajar el stock por debajo de ${reserved}: hay ${reserved} ${
        reserved === 1 ? 'unidad reservada' : 'unidades reservadas'
      } en este momento`,
      { minimo: reserved },
    );
  }
}

/** Fila de inventario tal como la devuelven las sentencias crudas. */
interface FilaInventario {
  id: string;
  on_hand: number;
  reserved: number;
  low_stock_threshold: number | null;
}

interface FilaLiberacion {
  quantity: number;
  inventory_id: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly metrics: MetricsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // RESERVAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Aparta unidades para un comprador.
   *
   * ─── El orden de las operaciones no es casual ───
   *
   * Dentro de la transacción se INSERTA la reserva primero y se toca el
   * inventario último. La razón es la duración del bloqueo: la fila de
   * inventario de la variante que está sonando en un vivo es EL punto de
   * contención —todas las peticiones se serializan ahí— y cuanto menos tiempo
   * se la retenga, más compradores por segundo pasan.
   *
   * El INSERT no compite con nadie (cada reserva es una fila nueva). Si se
   * hiciera al revés, cada petición mantendría bloqueada la fila caliente
   * mientras inserta, y el rendimiento bajo un vivo caería sin motivo.
   */
  async reserve(params: {
    userId: string;
    productVariantId: string;
    quantity: number;
    idempotencyKey: string;
  }) {
    const { userId, productVariantId, quantity, idempotencyKey } = params;
    const inicio = process.hrtime.bigint();

    const requestHash = huellaDePeticion(productVariantId, quantity);

    /**
     * 1 y 2 · Las dos lecturas previas, EN PARALELO.
     *
     * Son independientes: una pregunta si el producto se puede comprar y la
     * otra si esta persona ya tiene una reserva. Encadenarlas con dos `await`
     * seguidos las serializaba sin motivo, y este es el camino más caliente
     * del sistema —durante un vivo pasan por acá todas las compras—.
     *
     * Las dos preguntas sobre reservas van además en UNA sola consulta:
     *
     *   · ¿Ya respondimos esta misma petición? (reintento por red mala)
     *   · ¿Ya tiene una reserva viva de esta variante? (doble toque)
     *
     * Ambas filtran por el mismo `userId` y cada rama tiene su índice
     * —`(user_id, idempotency_key)` y `(user_id, status)`— así que unirlas con
     * un OR no le cuesta nada al planificador.
     *
     * De tres viajes secuenciales a la base quedan dos en paralelo.
     */
    const [vendible, previas] = await Promise.all([
      this.verificarVendible(productVariantId),
      this.prisma.inventoryReservation.findMany({
        where: {
          userId,
          OR: [{ idempotencyKey }, { productVariantId, status: 'ACTIVE' }],
        },
      }),
    ]);

    const previa = previas.find((r) => r.idempotencyKey === idempotencyKey);
    if (previa) {
      if (previa.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
      this.metrics.inventoryReservation.inc({ result: 'idempotent_replay' });
      return this.vistaDeReserva(previa);
    }

    /**
     * 3 · Reserva viva de esta misma variante.
     *
     * Se reutiliza en vez de crear otra. Es la regla que evita que un doble
     * toque, dos pestañas o un reintento con clave nueva aparten el stock dos
     * veces. La alternativa —actualizar la cantidad— obliga a liberar y volver
     * a tomar, y esa secuencia tiene un instante en el que el stock está suelto
     * y otro comprador se lo puede llevar.
     */
    const activa = previas.find(
      (r) => r.productVariantId === productVariantId && r.status === 'ACTIVE',
    );
    if (activa) {
      if (activa.expiresAt.getTime() > Date.now()) {
        this.metrics.inventoryReservation.inc({ result: 'reused' });
        return { ...this.vistaDeReserva(activa), reused: true };
      }

      /**
       * Venció, pero todavía figura ACTIVE porque ni el job ni el
       * reconciliador llegaron a barrerla. Se vence acá mismo.
       *
       * Sin esto, el índice único parcial rechazaría la reserva nueva —para él
       * sigue habiendo una activa— y el comprador recibiría de vuelta una
       * reserva muerta con el contador en 00:00. La expiración es atómica e
       * idempotente, así que hacerla en este camino no compite con el barrido:
       * si el reconciliador se adelanta, acá simplemente no pasa nada.
       */
      await this.expireIfDue(activa.id);
    }

    const reservationId = newId('rsv');
    const expiresAt = new Date(Date.now() + env.INVENTORY_RESERVATION_TTL_SECONDS * 1000);
    const antes = disponibles(vendible.inventory.on_hand, vendible.inventory.reserved);

    let despues = antes;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.inventoryReservation.create({
          data: {
            id: reservationId,
            inventoryId: vendible.inventory.id,
            productVariantId,
            userId,
            quantity,
            status: 'ACTIVE',
            idempotencyKey,
            requestHash,
            expiresAt,
          },
        });

        // ─── La sentencia que decide ───
        //
        // La condición y la escritura son la misma operación. No hay lectura
        // previa que se pueda quedar vieja.
        const filas = await tx.$queryRaw<FilaInventario[]>`
          UPDATE "inventory"
             SET "reserved" = "reserved" + ${quantity},
                 "updated_at" = now()
           WHERE "id" = ${vendible.inventory.id}
             AND ("on_hand" - "reserved") >= ${quantity}
          RETURNING "id", "on_hand", "reserved", "low_stock_threshold"
        `;

        // Cero filas = la condición no se cumplió = no hay stock. No es un
        // error del cliente ni un fallo del sistema: es la respuesta.
        const fila = filas[0];
        if (!fila) throw new OutOfStockError(antes < 0 ? 0 : antes);

        despues = disponibles(fila.on_hand, fila.reserved);
      });
    } catch (err) {
      // Carrera con otra petición idéntica: las dos insertaron, una perdió.
      // Se relee y se devuelve la que ganó — que es exactamente el resultado
      // que esperaba quien reintentó.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const ganadora = await this.resolverCarrera(userId, idempotencyKey, productVariantId);
        if (ganadora) {
          this.metrics.inventoryReservation.inc({ result: 'idempotent_replay' });
          return this.vistaDeReserva(ganadora);
        }
        this.metrics.inventoryConcurrencyConflicts.inc();
      }
      if (err instanceof OutOfStockError) {
        this.metrics.inventoryReservation.inc({ result: 'out_of_stock' });
      }
      throw err;
    }

    this.metrics.inventoryReservation.inc({ result: 'created' });
    this.metrics.inventoryReservationLatency.observe(
      Number(process.hrtime.bigint() - inicio) / 1e9,
    );

    this.events.publish(DomainEvent.reservationCreated, {
      entityId: reservationId,
      actorId: userId,
      data: { productVariantId, quantity, expiresAt: expiresAt.toISOString() },
    });
    this.avisarCruceDeUmbral(productVariantId, antes, despues, vendible.inventory);

    /**
     * La bitácora NO bloquea la respuesta.
     *
     * La reserva ya está cometida en PostgreSQL: hacer esperar al comprador un
     * viaje más a la base para escribir un registro que nadie va a leer en ese
     * instante es cambiar latencia en el camino caliente por nada.
     *
     * `AuditService.log` está diseñado para no lanzar nunca, así que un fallo
     * acá no puede tumbar una venta. Lo que se acepta a cambio: si el proceso
     * muere entre el commit y esta escritura, se pierde una línea de bitácora.
     * La reserva sigue existiendo y es reconstruible desde la tabla.
     */
    void this.audit.log({
      action: 'reservation.created',
      entityType: 'inventory_reservation',
      entityId: reservationId,
      actorId: userId,
      after: { productVariantId, quantity, expiresAt },
    });

    return {
      reservationId,
      status: 'ACTIVE' as const,
      productVariantId,
      quantity,
      expiresAt,
      remainingSeconds: env.INVENTORY_RESERVATION_TTL_SECONDS,
      reused: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TERMINAR UNA RESERVA
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convierte la reserva en venta.
   *
   * ─── Por qué se descuenta de `onHand` y no sólo de `reserved` ───
   *
   *     antes:   onHand 10 · reserved 2 · disponibles 8
   *     consume 1
   *     después: onHand  9 · reserved 1 · disponibles 8
   *
   * Restar únicamente de `reserved` daría `onHand 10 · reserved 1 · 9
   * disponibles`: la unidad vendida volvería al mostrador. La venta se lleva
   * una unidad FÍSICA, así que tiene que bajar de las dos columnas a la vez —
   * y por eso `available` no se mueve.
   *
   * Orders todavía no existe. Este método queda listo para que, cuando un pago
   * se acredite, la orden llame acá y nadie tenga que reinventar la regla.
   */
  async consume(reservationId: string) {
    const resultado = await this.prisma.$transaction(async (tx) => {
      // La transición ES el candado. `AND status = 'ACTIVE'` hace que sólo la
      // primera llamada afecte una fila; una segunda encuentra cero y no
      // descuenta nada. Consumir dos veces es imposible sin un `if`.
      const cerradas = await tx.$queryRaw<FilaLiberacion[]>`
        UPDATE "inventory_reservations"
           SET "status" = 'CONSUMED', "consumed_at" = now(), "updated_at" = now()
         WHERE "id" = ${reservationId} AND "status" = 'ACTIVE'
        RETURNING "quantity", "inventory_id"
      `;

      const cerrada = cerradas[0];
      if (!cerrada) return null;

      const filas = await tx.$queryRaw<FilaInventario[]>`
        UPDATE "inventory"
           SET "on_hand"  = "on_hand"  - ${cerrada.quantity},
               "reserved" = "reserved" - ${cerrada.quantity},
               "updated_at" = now()
         WHERE "id" = ${cerrada.inventory_id}
           AND "on_hand"  >= ${cerrada.quantity}
           AND "reserved" >= ${cerrada.quantity}
        RETURNING "id", "on_hand", "reserved", "low_stock_threshold"
      `;

      // Si esto pasa, el invariante se rompió antes de llegar acá. Se aborta:
      // dejar la reserva consumida sin descontar stock sería peor.
      if (!filas[0]) {
        throw new DomainError(
          'OUT_OF_STOCK',
          'El inventario no alcanza para consumir la reserva',
          { reservationId },
        );
      }

      return { quantity: cerrada.quantity, inventario: filas[0] };
    });

    if (!resultado) return this.yaTerminada(reservationId, 'consume');

    this.metrics.inventoryReservation.inc({ result: 'consumed' });
    this.events.publish(DomainEvent.reservationConsumed, {
      entityId: reservationId,
      data: { quantity: resultado.quantity },
    });
    await this.audit.log({
      action: 'reservation.consumed',
      entityType: 'inventory_reservation',
      entityId: reservationId,
      actorId: null,
      after: { quantity: resultado.quantity, onHand: resultado.inventario.on_hand },
    });

    return { reservationId, status: 'CONSUMED' as const, changed: true };
  }

  /**
   * El comprador la suelta.
   *
   * Libera `reserved` y no toca `onHand`: la unidad nunca salió del depósito.
   *
   * `userId` va en el WHERE, no en un `if`: cancelar la reserva de otro no es
   * una operación prohibida, es una operación que no encuentra nada.
   */
  async cancel(reservationId: string, userId: string) {
    const resultado = await this.liberar(reservationId, 'CANCELLED', { userId });

    if (!resultado) return this.yaTerminada(reservationId, 'cancel', userId);

    this.metrics.inventoryReservation.inc({ result: 'cancelled' });
    this.events.publish(DomainEvent.reservationCancelled, {
      entityId: reservationId,
      actorId: userId,
      data: { quantity: resultado.quantity },
    });
    await this.audit.log({
      action: 'reservation.cancelled',
      entityType: 'inventory_reservation',
      entityId: reservationId,
      actorId: userId,
      after: { quantity: resultado.quantity },
    });

    return { reservationId, status: 'CANCELLED' as const, changed: true };
  }

  /**
   * Vence una reserva, si corresponde.
   *
   * Idempotente por construcción y sin condiciones de carrera: el filtro
   * `status = 'ACTIVE' AND expires_at <= now()` va dentro del propio UPDATE.
   * Si el job diferido y el reconciliador la agarran en el mismo instante, uno
   * afecta una fila y el otro cero. El stock se libera exactamente una vez.
   *
   * El `now()` es el de PostgreSQL, no el de Node: dos procesos con relojes
   * levemente distintos tomarían decisiones distintas sobre la misma reserva.
   */
  async expireIfDue(reservationId: string): Promise<boolean> {
    const resultado = await this.liberar(reservationId, 'EXPIRED', { soloVencidas: true });
    if (!resultado) return false;

    this.metrics.inventoryReservation.inc({ result: 'expired' });
    this.events.publish(DomainEvent.reservationExpired, {
      entityId: reservationId,
      actorId: null,
      data: { quantity: resultado.quantity },
    });
    await this.audit.log({
      action: 'reservation.expired',
      entityType: 'inventory_reservation',
      entityId: reservationId,
      actorId: null,
      after: { quantity: resultado.quantity },
    });

    return true;
  }

  /**
   * Toma stock directamente, para un pago que llegó tarde.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * EL CASO QUE ESTO RESUELVE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Alguien reserva la última unidad y empieza a pagar. Pierde señal. La
   * reserva vence y el stock se libera. Cinco minutos después, Mercado Pago
   * acredita el pago.
   *
   * Ahora hay plata de una persona y una unidad que quizá se llevó otra.
   *
   * ─── Lo que NO se hace ───
   *
   * **No se revive la reserva vencida.** `EXPIRED → CONSUMED` está prohibido y
   * seguirá estándolo: si en el medio otro comprador reservó esa unidad, revivir
   * la primera se la robaría a alguien que hizo todo bien.
   *
   * **No se crea una reserva nueva de cinco minutos para consumirla después.**
   * Entre reservar y consumir habría una ventana; y peor, si el consumo
   * fallara quedaría stock apartado por una orden ya pagada.
   *
   * ─── Lo que sí se hace ───
   *
   * Una sola sentencia que descuenta de `onHand` **sólo si hay disponible**.
   * No pasa por `reserved` en ningún momento: no hay estado intermedio, no hay
   * ventana, no hay nada que limpiar si falla.
   *
   *     onHand 3 · reserved 1 · disponibles 2
   *     recuperar 1
   *     onHand 2 · reserved 1 · disponibles 1
   *
   * Si devuelve cero filas, no había: la orden va a `PAYMENT_REQUIRES_REFUND`
   * y se devuelve la plata.
   *
   * ─── El principio ───
   *
   * **El dinero acreditado no autoriza a romper las reglas de inventario.** Es
   * preferible devolver una venta que entregar una unidad que no existe o
   * quitársela a quien la reservó bien.
   */
  async consumeAvailableStockAfterLatePayment(params: {
    productVariantId: string;
    quantity: number;
    orderId: string;
  }): Promise<{ ok: true; onHand: number } | { ok: false; disponible: number }> {
    const { productVariantId, quantity, orderId } = params;

    const filas = await this.prisma.$queryRaw<FilaInventario[]>`
      UPDATE "inventory"
         SET "on_hand" = "on_hand" - ${quantity},
             "updated_at" = now()
       WHERE "product_variant_id" = ${productVariantId}
         AND ("on_hand" - "reserved") >= ${quantity}
      RETURNING "id", "on_hand", "reserved", "low_stock_threshold"
    `;

    const fila = filas[0];

    if (!fila) {
      // Se relee para poder decir CUÁNTO había, que es lo que se va a
      // registrar y lo que va a mirar quien investigue el reembolso.
      const actual = await this.prisma.inventory.findUnique({
        where: { productVariantId },
        select: { onHand: true, reserved: true },
      });
      const disponible = actual ? disponibles(actual.onHand, actual.reserved) : 0;

      this.metrics.latePaymentStock.inc({ result: 'out_of_stock' });
      this.events.publish(DomainEvent.inventoryLatePaymentOutOfStock, {
        entityId: productVariantId,
        data: { orderId, quantity, disponible },
      });
      await this.audit.log({
        action: 'inventory.late_payment_out_of_stock',
        entityType: 'inventory',
        entityId: productVariantId,
        actorId: null,
        after: { orderId, quantity, disponible },
      });

      this.logger.warn({
        msg: 'pago tardío sin stock: hay que devolver la plata',
        orderId,
        productVariantId,
        quantity,
        disponible,
      });

      return { ok: false, disponible };
    }

    this.metrics.latePaymentStock.inc({ result: 'reacquired' });
    this.events.publish(DomainEvent.inventoryLatePaymentReacquired, {
      entityId: productVariantId,
      data: { orderId, quantity, onHand: fila.on_hand },
    });
    await this.audit.log({
      action: 'inventory.late_payment_reacquired',
      entityType: 'inventory',
      entityId: fila.id,
      actorId: null,
      after: { orderId, productVariantId, quantity, onHand: fila.on_hand },
    });

    return { ok: true, onHand: fila.on_hand };
  }

  /**
   * Barrido de vencidas. Lo llama el reconciliador.
   *
   * Se procesa una por una y no con un UPDATE masivo a propósito: cada
   * expiración es su propia transacción, así una fila problemática no arrastra
   * al lote entero. Con el índice parcial sobre las ACTIVE, encontrar las
   * candidatas cuesta lo mismo con mil reservas que con un millón.
   */
  async expireDue(limite = 200): Promise<{ revisadas: number; vencidas: number }> {
    const candidatas = await this.prisma.inventoryReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: limite,
    });

    let vencidas = 0;
    for (const { id } of candidatas) {
      try {
        if (await this.expireIfDue(id)) vencidas += 1;
      } catch (err) {
        // Una reserva que falla no puede frenar a las demás: si lo hiciera, un
        // solo registro corrupto dejaría stock apartado para siempre.
        this.logger.error({
          msg: 'no se pudo vencer una reserva',
          reservationId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { revisadas: candidatas.length, vencidas };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STOCK DEL VENDEDOR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fija el stock físico.
   *
   * ─── Por qué puede fallar bajar el stock ───
   *
   *     onHand 10 · reserved 8 → el vendedor pone 5
   *
   * Aceptarlo dejaría `reserved > onHand`: ocho personas con una unidad
   * apartada de un total de cinco. Tres se van a quedar sin lo que ya creían
   * tener. Se rechaza y se le dice cuál es el mínimo.
   *
   * Si lo que quiere es dejar de vender, la herramienta es pausar la variante
   * o el producto — no falsear el inventario. Son cosas distintas y conviene
   * que la interfaz no las confunda.
   */
  async setOnHand(params: {
    inventoryId: string;
    onHand: number;
    actorId: string;
    productVariantId: string;
    motivo?: string;
  }) {
    const { inventoryId, onHand, actorId, productVariantId } = params;

    const anterior = await this.porId(inventoryId);
    const antes = disponibles(anterior.on_hand, anterior.reserved);

    const filas = await this.prisma.$queryRaw<FilaInventario[]>`
      UPDATE "inventory"
         SET "on_hand" = ${onHand}, "updated_at" = now()
       WHERE "id" = ${inventoryId}
         AND "reserved" <= ${onHand}
      RETURNING "id", "on_hand", "reserved", "low_stock_threshold"
    `;

    const fila = filas[0];
    if (!fila) {
      // Se relee: entre la lectura y el UPDATE pudo entrar una reserva, y el
      // mensaje tiene que decir el mínimo REAL, no uno viejo.
      const actual = await this.porId(inventoryId);
      throw new StockBelowReservedError(actual.reserved);
    }

    await this.registrarCambio({
      accion: 'inventory.set',
      inventoryId,
      productVariantId,
      actorId,
      antes: anterior,
      despues: fila,
      motivo: params.motivo,
    });
    this.avisarCruceDeUmbral(productVariantId, antes, disponibles(fila.on_hand, fila.reserved), fila);

    return this.vistaDeInventario(fila, productVariantId);
  }

  /**
   * Suma o resta unidades.
   *
   * Existe además del valor absoluto porque "me entraron 10 más" es la
   * operación real de un vendedor, y obligarlo a calcular 47 + 10 = 57 y
   * escribir 57 introduce errores de tipeo sobre datos que importan.
   *
   * El delta se aplica DENTRO del UPDATE. Con dos ajustes simultáneos de +10 y
   * +5, leer-sumar-escribir perdería uno de los dos; así se aplican los dos.
   */
  async adjust(params: {
    inventoryId: string;
    delta: number;
    actorId: string;
    productVariantId: string;
    motivo?: string;
  }) {
    const { inventoryId, delta, actorId, productVariantId } = params;

    const anterior = await this.porId(inventoryId);
    const antes = disponibles(anterior.on_hand, anterior.reserved);

    const filas = await this.prisma.$queryRaw<FilaInventario[]>`
      UPDATE "inventory"
         SET "on_hand" = "on_hand" + ${delta}, "updated_at" = now()
       WHERE "id" = ${inventoryId}
         AND ("on_hand" + ${delta}) >= "reserved"
         AND ("on_hand" + ${delta}) >= 0
      RETURNING "id", "on_hand", "reserved", "low_stock_threshold"
    `;

    const fila = filas[0];
    if (!fila) {
      const actual = await this.porId(inventoryId);
      throw new StockBelowReservedError(actual.reserved);
    }

    await this.registrarCambio({
      accion: 'inventory.adjusted',
      inventoryId,
      productVariantId,
      actorId,
      antes: anterior,
      despues: fila,
      motivo: params.motivo,
      delta,
    });
    this.avisarCruceDeUmbral(productVariantId, antes, disponibles(fila.on_hand, fila.reserved), fila);

    return this.vistaDeInventario(fila, productVariantId);
  }

  /**
   * Id de inventario de una variante, creándolo si falta.
   *
   * Toda variante debería tener su fila —se crea junto con la variante y la
   * migración rellenó las viejas— pero este camino lo garantiza igual. Es el
   * único lugar donde se crea bajo demanda, y a propósito: es una operación
   * del VENDEDOR, no del camino de compra.
   *
   * En el camino de compra, una variante sin inventario se responde como
   * agotada. Crear filas ahí agregaría una escritura al punto más caliente del
   * sistema para resolver algo que no debería pasar nunca.
   */
  async idDeVariante(productVariantId: string): Promise<string> {
    const existente = await this.prisma.inventory.findUnique({
      where: { productVariantId },
      select: { id: true },
    });
    if (existente) return existente.id;

    const id = newId('inv');
    try {
      await this.prisma.inventory.create({ data: { id, productVariantId } });
      this.events.publish(DomainEvent.inventoryCreated, {
        entityId: id,
        data: { productVariantId },
      });
      return id;
    } catch (err) {
      // Dos peticiones del mismo vendedor a la vez: una creó, la otra choca
      // contra el índice único. Se relee y se sigue.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const ganadora = await this.prisma.inventory.findUniqueOrThrow({
          where: { productVariantId },
          select: { id: true },
        });
        return ganadora.id;
      }
      throw err;
    }
  }

  /** Umbral de "quedan pocas" de una variante. */
  async setLowStockThreshold(inventoryId: string, umbral: number | null, actorId: string) {
    const actualizado = await this.prisma.inventory.update({
      where: { id: inventoryId },
      data: { lowStockThreshold: umbral },
    });
    await this.audit.log({
      action: 'inventory.threshold_set',
      entityType: 'inventory',
      entityId: inventoryId,
      actorId,
      after: { lowStockThreshold: umbral },
    });
    return actualizado;
  }

  /**
   * Crea las filas de inventario de varias variantes.
   *
   * `skipDuplicates` para que llamarlo dos veces no falle: se invoca al crear
   * un producto y también al reparar variantes viejas.
   */
  async ensureForVariants(variantIds: readonly string[], tx?: Prisma.TransactionClient) {
    if (variantIds.length === 0) return;
    const cliente = tx ?? this.prisma;
    await cliente.inventory.createMany({
      data: variantIds.map((productVariantId) => ({ id: newId('inv'), productVariantId })),
      skipDuplicates: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LECTURA
  // ═══════════════════════════════════════════════════════════════════════

  /** Disponibilidad pública de una variante. Sin números exactos salvo "quedan pocas". */
  async availability(productVariantId: string) {
    const inv = await this.prisma.inventory.findUnique({ where: { productVariantId } });
    // Sin fila de inventario, la respuesta segura es "agotado". Es preferible
    // no vender a vender algo cuya existencia no consta.
    if (!inv) return { productVariantId, availability: 'OUT_OF_STOCK' as const, remaining: null };

    return {
      productVariantId,
      ...vistaPublica(inv.onHand, inv.reserved, inv.lowStockThreshold ?? env.INVENTORY_LOW_STOCK_THRESHOLD),
    };
  }

  /** Vista completa para el vendedor: ve sus propios números. */
  async forVariants(variantIds: readonly string[]) {
    const filas = await this.prisma.inventory.findMany({
      where: { productVariantId: { in: [...variantIds] } },
    });

    return filas.map((i) => ({
      inventoryId: i.id,
      productVariantId: i.productVariantId,
      onHand: i.onHand,
      reserved: i.reserved,
      available: disponibles(i.onHand, i.reserved),
      lowStockThreshold: i.lowStockThreshold,
    }));
  }

  /** Reservas activas del usuario. La app las relee al volver del segundo plano. */
  async myActiveReservations(userId: string) {
    const filas = await this.prisma.inventoryReservation.findMany({
      where: { userId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'asc' },
    });
    return filas.map((r) => this.vistaDeReserva(r));
  }

  /** Una reserva, **sólo si es del usuario**. Ajena = no encontrada. */
  async myReservation(reservationId: string, userId: string) {
    const r = await this.prisma.inventoryReservation.findFirst({
      where: { id: reservationId, userId },
    });
    if (!r) throw new ReservationNotFoundError();
    return this.vistaDeReserva(r);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNOS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Libera stock cerrando la reserva, en una sola transacción.
   *
   * Concentra lo que comparten cancelar y vencer: la transición de estado y la
   * devolución de unidades a `reserved` son inseparables. Si estuvieran en dos
   * métodos, algún día uno se llamaría sin el otro.
   */
  private async liberar(
    reservationId: string,
    hacia: 'CANCELLED' | 'EXPIRED',
    opciones: { userId?: string; soloVencidas?: boolean },
  ): Promise<{ quantity: number } | null> {
    const filtroUsuario = opciones.userId
      ? Prisma.sql`AND "user_id" = ${opciones.userId}`
      : Prisma.empty;
    // El reloj es el de PostgreSQL. Con el de Node, dos instancias con relojes
    // desfasados discreparían sobre si una reserva ya venció.
    const filtroVencimiento = opciones.soloVencidas
      ? Prisma.sql`AND "expires_at" <= now()`
      : Prisma.empty;
    const columnaFecha =
      hacia === 'CANCELLED' ? Prisma.sql`"cancelled_at"` : Prisma.sql`"expired_at"`;

    return this.prisma.$transaction(async (tx) => {
      const cerradas = await tx.$queryRaw<FilaLiberacion[]>`
        UPDATE "inventory_reservations"
           SET "status" = ${hacia}::"ReservationStatus",
               ${columnaFecha} = now(),
               "updated_at" = now()
         WHERE "id" = ${reservationId}
           AND "status" = 'ACTIVE'
           ${filtroUsuario}
           ${filtroVencimiento}
        RETURNING "quantity", "inventory_id"
      `;

      const cerrada = cerradas[0];
      if (!cerrada) return null;

      await tx.$executeRaw`
        UPDATE "inventory"
           SET "reserved" = "reserved" - ${cerrada.quantity},
               "updated_at" = now()
         WHERE "id" = ${cerrada.inventory_id}
      `;

      return { quantity: cerrada.quantity };
    });
  }

  /**
   * Qué responder cuando el UPDATE no afectó nada.
   *
   * Puede ser porque la reserva ya terminó —y entonces la operación es
   * idempotente: se responde sin cambiar nada— o porque no existe / es de
   * otro, y entonces es 404.
   */
  private async yaTerminada(reservationId: string, operacion: string, userId?: string) {
    const actual = await this.prisma.inventoryReservation.findFirst({
      where: { id: reservationId, ...(userId ? { userId } : {}) },
      select: { status: true },
    });
    if (!actual) throw new ReservationNotFoundError();

    this.logger.debug({
      msg: 'operación sin efecto: la reserva ya estaba terminada',
      reservationId,
      operacion,
      status: actual.status,
    });

    return {
      reservationId,
      status: actual.status,
      changed: false as const,
    };
  }

  /**
   * ¿Se puede comprar esta variante?
   *
   * Cuatro estados en cascada —vendedor, tienda, producto, variante— y todos
   * se evalúan en el backend. La app puede mostrar un botón "Comprar" viejo,
   * cacheado de hace media hora; lo que decide es esto.
   *
   * Una sola consulta con los joins: son cuatro tablas y hacerlo en cuatro
   * viajes agregaría latencia justo en el camino más caliente del sistema.
   */
  private async verificarVendible(productVariantId: string) {
    const variante = await this.prisma.productVariant.findFirst({
      where: { id: productVariantId, deletedAt: null },
      select: {
        id: true,
        status: true,
        product: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            store: {
              select: { id: true, status: true, seller: { select: { id: true, status: true } } },
            },
          },
        },
        inventory: {
          select: { id: true, onHand: true, reserved: true, lowStockThreshold: true },
        },
      },
    });

    // 404 y no "no vendible": una variante inexistente y una ajena tienen que
    // ser indistinguibles desde afuera.
    if (!variante) throw new DomainError('VARIANT_NOT_FOUND', 'Variante no encontrada');

    if (variante.status !== 'ACTIVE') throw new NotPurchasableError('variante_inactiva');

    const producto = variante.product;
    if (producto.deletedAt) throw new NotPurchasableError('producto_borrado');
    if (producto.status !== 'ACTIVE') throw new NotPurchasableError('producto_no_publicado');
    if (producto.store.status !== 'ACTIVE') throw new NotPurchasableError('tienda_pausada');
    if (producto.store.seller.status !== 'ACTIVE') throw new NotPurchasableError('vendedor_inactivo');

    // Sin fila de inventario no hay nada que apartar. No es un error del
    // cliente: es que no hay stock cargado.
    if (!variante.inventory) throw new OutOfStockError(0);

    return {
      variante,
      inventory: {
        id: variante.inventory.id,
        on_hand: variante.inventory.onHand,
        reserved: variante.inventory.reserved,
        low_stock_threshold: variante.inventory.lowStockThreshold,
      } satisfies FilaInventario,
    };
  }

  private async buscarPorClave(userId: string, idempotencyKey: string) {
    return this.prisma.inventoryReservation.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  /**
   * Resuelve un choque de índice único.
   *
   * Dos peticiones simultáneas —el mismo doble toque— pueden insertar a la
   * vez: una gana y la otra recibe P2002. La que perdió no tiene que fallar,
   * tiene que devolver lo que hizo la que ganó. Para el usuario fue un solo
   * toque.
   */
  private async resolverCarrera(
    userId: string,
    idempotencyKey: string,
    productVariantId: string,
  ) {
    return (
      (await this.buscarPorClave(userId, idempotencyKey)) ??
      (await this.prisma.inventoryReservation.findFirst({
        where: { userId, productVariantId, status: 'ACTIVE' },
      }))
    );
  }

  private async porId(inventoryId: string): Promise<FilaInventario> {
    const inv = await this.prisma.inventory.findUnique({ where: { id: inventoryId } });
    if (!inv) throw new DomainError('INVENTORY_NOT_FOUND', 'Inventario no encontrado');
    return {
      id: inv.id,
      on_hand: inv.onHand,
      reserved: inv.reserved,
      low_stock_threshold: inv.lowStockThreshold,
    };
  }

  private vistaDeInventario(fila: FilaInventario, productVariantId: string) {
    return {
      inventoryId: fila.id,
      productVariantId,
      onHand: fila.on_hand,
      reserved: fila.reserved,
      available: disponibles(fila.on_hand, fila.reserved),
      lowStockThreshold: fila.low_stock_threshold,
    };
  }

  private vistaDeReserva(r: {
    id: string;
    status: string;
    quantity: number;
    productVariantId: string;
    expiresAt: Date;
    requestHash?: string;
  }) {
    // Los segundos restantes se calculan contra el reloj del servidor y viajan
    // ya resueltos. La app no tiene que restar fechas —ni acertarle a la zona
    // horaria— para dibujar el contador.
    const restantes = Math.max(0, Math.floor((r.expiresAt.getTime() - Date.now()) / 1000));
    return {
      reservationId: r.id,
      status: r.status as ReservationStatus,
      productVariantId: r.productVariantId,
      quantity: r.quantity,
      expiresAt: r.expiresAt,
      remainingSeconds: restantes,
      reused: false,
    };
  }

  private async registrarCambio(params: {
    accion: string;
    inventoryId: string;
    productVariantId: string;
    actorId: string;
    antes: FilaInventario;
    despues: FilaInventario;
    motivo?: string;
    delta?: number;
  }) {
    this.events.publish(DomainEvent.inventoryUpdated, {
      entityId: params.inventoryId,
      actorId: params.actorId,
      data: {
        productVariantId: params.productVariantId,
        onHand: params.despues.on_hand,
        available: disponibles(params.despues.on_hand, params.despues.reserved),
      },
    });

    await this.audit.log({
      action: params.accion,
      entityType: 'inventory',
      entityId: params.inventoryId,
      actorId: params.actorId,
      before: { onHand: params.antes.on_hand },
      after: {
        onHand: params.despues.on_hand,
        ...(params.delta !== undefined ? { delta: params.delta } : {}),
        ...(params.motivo ? { motivo: params.motivo } : {}),
      },
    });
  }

  /**
   * Avisa cuando la disponibilidad cruza un límite.
   *
   * Sólo en el CRUCE, no en cada movimiento. Un suscriptor que recibiera
   * "queda poco" en cada venta mientras el stock sigue bajo mandaría diez
   * notificaciones seguidas por lo mismo.
   */
  private avisarCruceDeUmbral(
    productVariantId: string,
    antes: number,
    despues: number,
    inv: FilaInventario,
  ) {
    const umbral = inv.low_stock_threshold ?? env.INVENTORY_LOW_STOCK_THRESHOLD;
    const cruce = cruzoUmbral(antes, despues, umbral);
    if (!cruce) return;

    const evento = {
      low: DomainEvent.inventoryLow,
      out: DomainEvent.inventoryOutOfStock,
      back: DomainEvent.inventoryBackInStock,
    }[cruce];

    this.events.publish(evento, {
      entityId: inv.id,
      actorId: null,
      data: { productVariantId, available: despues },
    });
  }
}
