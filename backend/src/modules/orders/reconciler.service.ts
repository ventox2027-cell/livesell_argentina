import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { corresTareasPeriodicas } from '@/shared/app-role';

import { OrdersService } from './orders.service';
import { OrderPaymentsService } from './payments.service';
import { PaymentProvider, ProviderPaymentNotFoundError } from './payment-provider';
import { PrismaService } from '@/shared/prisma/prisma.service';

/**
 * El conciliador de pagos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ DEJÓ DE SER UN BOTÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En el spike la conciliación era un endpoint que alguien tenía que llamar a
 * mano. Estaba anotado como deuda y esta es la razón por la que había que
 * saldarla: **lo que este job resuelve es plata de gente real que quedó en un
 * estado indeterminado**, y eso no puede depender de que alguien se acuerde.
 *
 * Tres cosas que sólo se arreglan acá:
 *
 *   1. **Cobros en estado desconocido.** Se mandó el cobro, se cortó la red,
 *      no sabemos si se procesó. Sin esto, la orden queda trabada para siempre
 *      y el comprador no puede reintentar ni le devolvemos nada.
 *   2. **Devoluciones fallidas.** Mercado Pago tuvo un mal momento y la
 *      devolución no salió. Sin reintento, la plata se queda acá y nadie se
 *      entera.
 *   3. **Órdenes sin pagar.** Se vencen para que el panel del vendedor no se
 *      llene de carritos abandonados.
 *
 * ─── La verdad sigue siendo PostgreSQL y el proveedor ───
 *
 * El job es EJECUCIÓN, no autoridad. No decide nada por su cuenta: le pregunta
 * a Mercado Pago y aplica lo que le respondan por el mismo camino que usa la
 * respuesta directa. Si Redis se cae, esto sigue funcionando — no depende de
 * ninguna cola.
 */
@Injectable()
export class OrdersReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersReconciler.name);

  private timer?: NodeJS.Timeout;
  private corriendo = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly payments: OrderPaymentsService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    if (!env.ORDERS_RECONCILER_ENABLED) {
      this.logger.warn('conciliador de órdenes apagado');
      return;
    }

    /**
     * En un proceso `web` no se arranca el temporizador: lo corre el worker.
     *
     * Acá importa más que en inventario. Lo que este barrido resuelve es plata
     * de gente real en estado indeterminado, y con escalado a cero un
     * `setInterval` en el proceso web se apaga de madrugada — que es justo
     * cuando nadie va a notar que dejó de correr. Ver `shared/app-role.ts`.
     */
    if (!corresTareasPeriodicas()) {
      this.logger.log('rol web: la conciliación de pagos la corre el worker');
      return;
    }

    this.timer = setInterval(() => {
      void this.barrer();
    }, env.ORDERS_RECONCILER_INTERVAL_MS);

    // `unref` para que un proceso que sólo tiene esto pendiente pueda terminar.
    this.timer.unref();
    this.logger.log(
      `conciliador de órdenes cada ${env.ORDERS_RECONCILER_INTERVAL_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un barrido completo. Público para que los tests no dependan del reloj. */
  async barrer(): Promise<{
    cobrosResueltos: number;
    devolucionesReintentadas: number;
    ordenesVencidas: number;
  }> {
    if (this.corriendo) {
      return { cobrosResueltos: 0, devolucionesReintentadas: 0, ordenesVencidas: 0 };
    }
    this.corriendo = true;

    try {
      const cobrosResueltos = await this.resolverCobrosInciertos();
      const devolucionesReintentadas = await this.reintentarDevoluciones();
      const { vencidas } = await this.orders.expireStale();

      if (cobrosResueltos + devolucionesReintentadas + vencidas > 0) {
        this.logger.log({
          msg: 'conciliación completada',
          cobrosResueltos,
          devolucionesReintentadas,
          ordenesVencidas: vencidas,
        });
      }

      return { cobrosResueltos, devolucionesReintentadas, ordenesVencidas: vencidas };
    } catch (err) {
      // Nunca propaga: una excepción sin capturar dentro de `setInterval`
      // tumba el proceso de Node.
      this.logger.error({
        msg: 'falló la conciliación',
        error: err instanceof Error ? err.message : String(err),
      });
      return { cobrosResueltos: 0, devolucionesReintentadas: 0, ordenesVencidas: 0 };
    } finally {
      this.corriendo = false;
    }
  }

  /**
   * Le pregunta al proveedor por los cobros que quedaron sin resolver.
   *
   * ─── Cuando ni siquiera se guardó el id del pago ───
   *
   * Si la red se cortó ANTES de recibir la respuesta, no hay
   * `providerPaymentId`: no sabemos con qué preguntar. Para eso está la
   * búsqueda por referencia externa, que es nuestro id de orden y viaja en
   * cada cobro justamente por esto.
   *
   * Es el único camino que puede encontrar un pago del que no quedó ningún
   * rastro local más allá de la fila del intento.
   */
  private async resolverCobrosInciertos(limite = 100): Promise<number> {
    const inciertos = await this.prisma.paymentAttempt.findMany({
      where: { status: { in: ['PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION'] } },
      select: { id: true, orderId: true, providerPaymentId: true, status: true },
      // Los que hace más que no se consultan, primero.
      orderBy: { lastCheckedAt: 'asc' },
      take: limite,
    });

    let resueltos = 0;

    for (const intento of inciertos) {
      const { resuelto, error } = await this.conciliarIntento(intento);
      if (resuelto) resueltos += 1;

      if (error) {
        // Uno que falla no puede frenar a los demás.
        this.logger.error({
          msg: 'no se pudo conciliar un cobro',
          attemptId: intento.id,
          error,
        });
      }
    }

    return resueltos;
  }

  /**
   * Concilia UN intento contra el proveedor.
   *
   * ─── Por qué es público ───
   *
   * Lo llama el panel de administración cuando alguien de soporte aprieta
   * "conciliar ahora" sobre un pago trabado. Ese botón **no puede tener su
   * propia lógica**: si el panel decidiera por su cuenta qué hacer con un pago
   * en estado desconocido, habría dos sistemas de conciliación con dos
   * criterios, y el día que difieran nadie va a saber cuál tiene razón.
   *
   * Es la misma función que corre cada minuto en el worker. La diferencia
   * entre el barrido automático y el botón es sólo quién la dispara.
   *
   * ─── Idempotente ───
   *
   * Se le puede pegar al botón diez veces seguidas. No decide nada por su
   * cuenta: le pregunta al proveedor y aplica lo que responda, por el mismo
   * camino que usa la respuesta directa del cobro. Preguntar dos veces da la
   * misma respuesta, y `aplicarResultado` tiene su propia guarda de monotonía.
   */
  async conciliarIntento(intento: {
    id: string;
    orderId: string;
    providerPaymentId: string | null;
  }): Promise<{ resuelto: boolean; error?: string }> {
    try {
      const pago = intento.providerPaymentId
        ? await this.provider.consultar(intento.providerPaymentId)
        : (await this.provider.buscarPorReferencia(intento.orderId))[0];

      if (!pago) {
        /**
         * El proveedor no conoce ningún pago para esta orden.
         *
         * Entonces el cobro nunca llegó a existir: la red se cortó antes. Se
         * cancela el intento y la orden vuelve a poder pagarse, que es lo que
         * el comprador necesita.
         */
        await this.prisma.$transaction([
          this.prisma.paymentAttempt.update({
            where: { id: intento.id },
            data: { status: 'CANCELLED', lastCheckedAt: new Date() },
          }),
          this.prisma.order.updateMany({
            where: { id: intento.orderId, status: 'PROCESSING_PAYMENT' },
            data: { status: 'PENDING_PAYMENT', statusReason: null },
          }),
        ]);
        return { resuelto: true };
      }

      await this.payments.aplicarResultado(intento.id, pago, 'reconciler');
      return { resuelto: true };
    } catch (err) {
      if (err instanceof ProviderPaymentNotFoundError) {
        // Igual que arriba: ese pago no existe del otro lado.
        await this.prisma.paymentAttempt.update({
          where: { id: intento.id },
          data: { status: 'CANCELLED', lastCheckedAt: new Date() },
        });
        return { resuelto: true };
      }

      // Se marca la consulta para no volver a este intento en el mismo barrido.
      await this.prisma.paymentAttempt.update({
        where: { id: intento.id },
        data: { lastCheckedAt: new Date() },
      });

      return { resuelto: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Reintenta las devoluciones que fallaron.
   *
   * Con tope: si Mercado Pago rechaza la devolución por algo estructural,
   * reintentarla para siempre esconde el problema en vez de escalarlo. Después
   * del tope queda registrada como fallida y hace falta intervención humana —
   * que es lo correcto cuando hay plata de alguien trabada.
   */
  private async reintentarDevoluciones(limite = 50): Promise<number> {
    const pendientes = await this.prisma.refund.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED', 'PROCESSING'] },
        attempts: { lt: env.REFUND_MAX_ATTEMPTS },
      },
      select: { id: true, attempts: true, orderId: true },
      orderBy: { updatedAt: 'asc' },
      take: limite,
    });

    let reintentadas = 0;

    for (const devolucion of pendientes) {
      try {
        await this.payments.ejecutarDevolucion(devolucion.id);
        reintentadas += 1;
      } catch (err) {
        this.logger.error({
          msg: 'falló el reintento de una devolución',
          refundId: devolucion.id,
          orderId: devolucion.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Las que agotaron los intentos se registran una vez, fuerte, para que
    // aparezcan en cualquier alerta que se monte sobre los logs.
    const agotadas = await this.prisma.refund.count({
      where: { status: 'FAILED', attempts: { gte: env.REFUND_MAX_ATTEMPTS } },
    });
    if (agotadas > 0) {
      this.logger.error({
        msg: '⚠️ hay devoluciones que agotaron los reintentos y necesitan intervención manual',
        cantidad: agotadas,
      });
    }

    return reintentadas;
  }
}
