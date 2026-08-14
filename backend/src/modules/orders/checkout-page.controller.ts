import { Controller, Get, Query, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';
import { renderCheckoutPage } from '@/modules/payments/checkout-page';

import { centavosAMonto } from './pricing';
import { PaymentProvider } from './payment-provider';

/**
 * La página del formulario de tarjeta, en producción.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EL NÚMERO DE TARJETA NO PASA POR NUESTRO CÓDIGO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El CardForm de Mercado Pago corre con `iframe: true`: los campos del número
 * y del código de seguridad son **iframes servidos por ellos**. El PAN no pasa
 * por nuestro DOM, ni por Dart, ni por nuestro backend.
 *
 * Eso mantiene el alcance PCI en **SAQ-A**. Si los campos fueran nuestros, el
 * sistema entraría en SAQ-D: auditoría anual, escaneos trimestrales y
 * segmentación de red. Para un equipo de esta escala eso no es caro, es
 * inviable.
 *
 * Verificado sobre datos reales en el Sprint 0B: cero filas con datos de
 * tarjeta en base, auditoría, webhooks y logs.
 *
 * ─── Sin autenticación, y está bien ───
 *
 * La abre un WebView, que no puede sostener el encabezado de sesión en las
 * subpeticiones. Y no hace falta: la página no lee ni escribe nada nuestro. Lo
 * único que expone es la clave pública, que es pública por diseño —su función
 * es exactamente ir embebida en una página— y con la que no se puede cobrar,
 * sólo crear tokens de un solo uso.
 *
 * El cobro real necesita el token Y una sesión válida en
 * `POST /orders/:id/payment-attempts`.
 *
 * ─── Fuera del versionado ───
 *
 * La URL la arma la app y la carga un navegador embebido. Dejarla fuera evita
 * que un futuro `/api/v2/` rompa el checkout de las apps ya instaladas.
 */
@Public()
@Controller({ path: 'checkout', version: VERSION_NEUTRAL })
export class CheckoutPageController {
  constructor(private readonly provider: PaymentProvider) {}

  /**
   * Los parámetros son sólo para MOSTRAR.
   *
   * El monto que se cobra sale de la orden en el backend, no de acá: si esta
   * página dijera $1 y la orden $8.900, se cobrarían $8.900. La página no
   * puede cambiar lo que se cobra, sólo lo que se lee en pantalla.
   */
  @Get('card')
  page(
    @Query('orderId') orderId: string | undefined,
    @Query('amount') amount: string | undefined,
    @Query('email') email: string | undefined,
    @Query('desc') desc: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const centavos = Number(amount ?? 0);

    const html = renderCheckoutPage({
      publicKey: this.provider.clavePublica,
      orderId: orderId ?? '',
      // El renderizador espera unidades; el resto del proyecto usa centavos.
      amount: centavosAMonto(Number.isFinite(centavos) ? centavos : 0),
      buyerEmail: email ?? '',
      description: desc ?? 'Compra en VendoX',
    });

    reply.type('text/html; charset=utf-8').send(html);
  }
}
