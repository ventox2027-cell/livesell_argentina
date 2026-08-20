import { Module } from '@nestjs/common';

import { CommerceModule } from '@/modules/commerce/commerce.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { SellerOAuthModule } from '@/modules/payments/seller-oauth.module';
import { SellersModule } from '@/modules/sellers/sellers.module';
import { MercadoPagoService } from '@/modules/payments/mp.client';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainEventBus } from '@/shared/events/domain-events';

import { AddressesService } from './addresses.service';
import { CheckoutPageController } from './checkout-page.controller';
import { MercadoPagoPaymentProvider } from './mercadopago.provider';
import { OrdersController, OrdersWebhookController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentProvider } from './payment-provider';
import { OrderPaymentsService } from './payments.service';
import { OrdersReconciler } from './reconciler.service';
import { VueltaDelPagoController } from './vuelta-del-pago.controller';
import { OrdersWebhookService } from './webhook.service';

/**
 * Órdenes, cobros y devoluciones.
 *
 * ─── El proveedor de pago se elige acá y en ningún otro lado ───
 *
 * Los servicios dependen de la clase abstracta `PaymentProvider`. Cambiar
 * Mercado Pago por otro procesador —o por su API de Orders, que ya está
 * marcada como recomendada— es cambiar esta línea.
 *
 * `MercadoPagoService` es el cliente HTTP del Sprint 0B: ya funciona contra
 * Mercado Pago real y no se reescribe. Se le agregó `refundPayment` y se lo
 * envuelve para que el módulo de órdenes nunca vea un tipo con `Mp` en el
 * nombre.
 *
 * ─── Por qué importa `InventoryModule` ───
 *
 * Por `consume()` y `consumeAvailableStockAfterLatePayment()`. La dirección de
 * la flecha importa: órdenes conoce inventario, nunca al revés. Inventario
 * tiene que poder existir sin que haya ventas.
 */
@Module({
  // `SellerOAuthModule` para poder cobrar en la cuenta del vendedor. La
  // dirección de la flecha importa: órdenes conoce la conexión de pago, nunca
  // al revés.
  imports: [CommerceModule, InventoryModule, SellerOAuthModule, SellersModule],
  controllers: [
    OrdersController,
    OrdersWebhookController,
    CheckoutPageController,
    VueltaDelPagoController,
  ],
  providers: [
    OrdersService,
    OrderPaymentsService,
    OrdersWebhookService,
    OrdersReconciler,
    AddressesService,

    // El cliente HTTP del spike, promovido a producción.
    MercadoPagoService,
    MercadoPagoPaymentProvider,
    {
      provide: PaymentProvider,
      useExisting: MercadoPagoPaymentProvider,
    },

    // Sin estado: cada módulo tiene su instancia.
    AuditService,
    DomainEventBus,
  ],
  // OrdersReconciler se exporta para que el panel de administración pueda
  // conciliar un pago puntual con la MISMA lógica que corre en el worker.
  exports: [OrdersService, OrderPaymentsService, OrdersReconciler],
})
export class OrdersModule {}
