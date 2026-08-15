import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { OwnershipService } from '@/modules/commerce/ownership.service';
import { IdempotencyKeySchema } from '@/modules/inventory/dto/inventory.dto';
import { DomainError } from '@/shared/errors/domain.error';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { RUTA_WEBHOOK_MERCADOPAGO } from '@/shared/http/rutas-webhook';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { AddressesService } from './addresses.service';
import {
  AplicarCuponSchema,
  CreateOrderSchema,
  CreatePaymentAttemptSchema,
  ConfirmarEntregaSchema,
  FulfillmentSchema,
  OrderPageQuerySchema,
  UpsertAddressSchema,
  type AplicarCuponDto,
  type CreateOrderDto,
  type CreatePaymentAttemptDto,
  type ConfirmarEntregaDto,
  type FulfillmentDto,
  type OrderPageQueryDto,
  type UpsertAddressDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';
import { PaymentProvider } from './payment-provider';
import { OrderPaymentsService } from './payments.service';
import { OrdersWebhookService } from './webhook.service';

/**
 * API de órdenes y pagos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO EXISTE `POST /orders/:id/mark-paid`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ni va a existir. Una orden pasa a pagada por un solo camino: porque el
 * backend le preguntó a Mercado Pago y Mercado Pago dijo que hay plata.
 *
 * Un endpoint que deje al cliente declarar un pago es un endpoint donde
 * cualquiera se lleva lo que quiera gratis. Y aparece de la forma más
 * inocente: "para poder probar sin tarjeta".
 */
@Controller({ version: '1' })
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: OrderPaymentsService,
    private readonly addresses: AddressesService,
    private readonly ownership: OwnershipService,
    private readonly provider: PaymentProvider,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // COMPRADOR — ÓRDENES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Crea una orden a partir de una reserva.
   *
   * El cuerpo tiene dos campos y ninguno es plata. El precio, la comisión y el
   * total salen del producto real; el vendedor, de la tienda del producto.
   */
  @RateLimit({ limit: 30, windowSec: 60, bucket: 'orders:create' })
  @Post('orders')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    /**
     * La cabecera se exige aunque la garantía real la dé el índice único sobre
     * `reservationId`.
     *
     * Es disciplina: el cliente va a necesitar idempotencia sí o sí en el
     * cobro, donde no hay ninguna reserva que sirva de ancla. Que la costumbre
     * empiece acá evita que alguien la descubra en el endpoint donde
     * olvidarla cuesta plata.
     */
    const clave = IdempotencyKeySchema.safeParse(idempotencyKey ?? '');
    if (!clave.success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Falta la cabecera Idempotency-Key', {
        reason: clave.error.issues[0]?.message,
      });
    }

    return this.orders.create({
      buyerId: user.id,
      reservationId: dto.reservationId,
      addressId: dto.addressId,
      retiraEnPersona: dto.retiraEnPersona,
      liveSessionId: dto.liveSessionId,
      cupon: dto.cupon,
    });
  }

  @Get('orders')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(OrderPageQuerySchema)) query: OrderPageQueryDto,
  ) {
    return this.orders.listForBuyer(user.id, query);
  }

  /** Una orden propia. Ajena = 404, no 403. */
  @Get('orders/:id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.forBuyer(id, user.id);
  }

  @Delete('orders/:id')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.cancelByBuyer(id, user.id);
  }

  /**
   * Aplica un cupón a un pedido que todavía no se pagó.
   *
   * Existe además del campo de `POST /orders` porque el checkout crea el
   * pedido apenas se abre —para que la persona vea el total mientras decide— y
   * el cupón se escribe después, en el resumen.
   *
   * ⚠️ Viaja el **código**, nunca el descuento.
   */
  @Post('orders/:id/coupon')
  aplicarCupon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AplicarCuponSchema)) dto: AplicarCuponDto,
  ) {
    return this.orders.aplicarCupon(id, user.id, dto.codigo);
  }

  @Delete('orders/:id/coupon')
  quitarCupon(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.quitarCupon(id, user.id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMPRADOR — COBROS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Intenta cobrar.
   *
   * ─── El límite es bajo a propósito ───
   *
   * Diez por minuto y por persona. Un comprador legítimo prueba dos o tres
   * tarjetas como mucho; un número más alto le daría a un script margen para
   * probar tarjetas robadas contra nuestra cuenta de Mercado Pago, que es una
   * forma conocida de validar listas de tarjetas y que nos costaría la cuenta.
   *
   * Va por usuario autenticado, no por IP: detrás del CGNAT de una operadora
   * hay un barrio entero.
   */
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'orders:pay' })
  @Post('orders/:id/payment-attempts')
  async pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreatePaymentAttemptSchema)) dto: CreatePaymentAttemptDto,
  ) {
    const { attempt, orderStatus } = await this.payments.cobrar({
      orderId,
      buyerId: user.id,
      cardToken: dto.cardToken,
      installments: dto.installments,
      paymentMethodId: dto.paymentMethodId,
    });

    // Del intento sale lo que la app necesita mostrar y nada más. El id del
    // pago en Mercado Pago y la respuesta cruda se quedan del lado del
    // servidor.
    return {
      attemptId: attempt.id,
      status: attempt.status,
      orderStatus,
      brand: attempt.brand,
      lastFour: attempt.lastFour,
      message: attempt.failureMessageSafe,
    };
  }

  @Get('orders/:id/payment-attempts')
  async attempts(@CurrentUser() user: AuthenticatedUser, @Param('id') orderId: string) {
    const orden = await this.orders.forBuyer(orderId, user.id);
    return orden.attempts;
  }

  /**
   * Clave pública del proveedor, para que el formulario de tarjeta arranque.
   *
   * En `/checkout/` y no en `/payments/`: ese prefijo lo ocupa el módulo del
   * Sprint 0B, que sigue montado mientras se lo pueda usar para diagnosticar
   * contra Mercado Pago. El de producción es este.
   */
  @Get('checkout/config')
  config() {
    return {
      provider: this.provider.nombre,
      publicKey: this.provider.clavePublica,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DIRECCIONES
  // ═══════════════════════════════════════════════════════════════════════

  @Get('addresses')
  listAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.addresses.list(user.id);
  }

  @Post('addresses')
  createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpsertAddressSchema)) dto: UpsertAddressDto,
  ) {
    return this.addresses.create(user.id, dto);
  }

  @Patch('addresses/:id')
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpsertAddressSchema)) dto: UpsertAddressDto,
  ) {
    return this.addresses.update(user.id, id, dto);
  }

  @Delete('addresses/:id')
  removeAddress(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.addresses.remove(user.id, id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VENDEDOR
  // ═══════════════════════════════════════════════════════════════════════

  /** Las ventas. Sólo las del vendedor autenticado: `sellerId` sale del token. */
  @Get('seller/orders')
  async sellerOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(OrderPageQuerySchema)) query: OrderPageQueryDto,
  ) {
    const seller = await this.ownership.sellerOf(user.id);
    return this.orders.listForSeller(seller.id, query);
  }

  /**
   * Avanza la preparación.
   *
   * Sólo el vendedor. El comprador no puede tocar estos estados: "ya lo
   * empaqueté" es una declaración sobre el mundo físico que sólo puede hacer
   * quien tiene el paquete.
   */
  @Patch('seller/orders/:id/fulfillment')
  async fulfillment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(FulfillmentSchema)) dto: FulfillmentDto,
  ) {
    const seller = await this.ownership.sellerOf(user.id, { requireActive: true });
    return this.orders.advanceFulfillment(orderId, seller.id, dto.status);
  }

  /**
   * Confirma la entrega con el código que tiene quien compró.
   *
   * ⛔ **Es el único camino a `DELIVERED`.** `PATCH .../fulfillment` no lo
   * acepta: "entregado" es una afirmación sobre el mundo físico y no puede
   * hacerla unilateralmente quien tiene interés en que sea cierta.
   *
   * El límite es bajo y va por vendedor: cinco intentos por pedido ya frenan
   * la fuerza bruta, y esto frena al que prueba números sobre muchos pedidos a
   * la vez.
   */
  @RateLimit({ limit: 20, windowSec: 300, bucket: 'orders:delivery' })
  @Post('seller/orders/:id/delivery-confirmation')
  async confirmarEntrega(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ConfirmarEntregaSchema)) dto: ConfirmarEntregaDto,
  ) {
    const seller = await this.ownership.sellerOf(user.id, { requireActive: true });
    return this.orders.confirmarEntrega(orderId, seller.id, dto.code);
  }
}

/**
 * Receptor de notificaciones de Mercado Pago.
 *
 * ─── Sin autenticación, a propósito ───
 *
 * Quien llama es Mercado Pago, que no tiene nuestro token. Su credencial es la
 * firma HMAC, que se verifica adentro. Un guard acá haría que ninguna
 * notificación entrara nunca.
 *
 * ─── Fuera del versionado ───
 *
 * La URL se carga a mano en el panel de Mercado Pago. Si algún día saliera
 * `/api/v2/`, nadie va a ir a actualizarla.
 *
 * ⚠️ La ruta se arma con `RUTA_WEBHOOK_MERCADOPAGO`, la misma constante que
 * `http-setup.ts` excluye del prefijo y que `env.schema.ts` exige en
 * `MP_NOTIFICATION_URL`. Escribirla a mano acá fue exactamente el origen del
 * problema: el controlador decía `webhooks/orders/mercadopago`, la exclusión
 * del prefijo sólo listaba `webhooks/mercadopago`, y la ruta real terminó
 * siendo `/api/webhooks/orders/mercadopago` sin que nadie lo notara.
 */
@Public()
@Controller({ path: RUTA_WEBHOOK_MERCADOPAGO, version: VERSION_NEUTRAL })
export class OrdersWebhookController {
  constructor(private readonly webhooks: OrdersWebhookService) {}

  /**
   * Siempre 200, salvo que el fallo sea NUESTRO.
   *
   * Un 401 por firma inválida haría que Mercado Pago reintentara en bucle algo
   * que nunca vamos a aceptar. Un 500 por un pago que no existe haría lo
   * mismo. El único caso donde conviene el reintento es cuando nuestra
   * consulta a su API falló: ahí el aviso era bueno y el problema es
   * transitorio de este lado.
   */
  // La ruta completa ya está en el `@Controller`. Acá va vacío para que exista
  // un solo lugar donde leerla.
  @Post()
  @HttpCode(200)
  async handle(@Req() req: FastifyRequest) {
    const resultado = await this.webhooks.recibir({
      headers: req.headers,
      query: (req.query ?? {}) as Record<string, string | undefined>,
      body: (req.body ?? {}) as Record<string, unknown>,
    });
    return { received: true, ...resultado };
  }
}
