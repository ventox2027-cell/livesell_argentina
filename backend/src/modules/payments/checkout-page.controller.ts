import { Controller, Get, Query, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { env } from '@/config/env.schema';

import { renderCheckoutPage } from './checkout-page';

/**
 * Sirve la página de tokenización que la app abre en un WebView.
 *
 * ─── Sin guard, y está bien ───
 *
 * Quien la abre es un WebView, que no puede sostener el header `x-spike-key` en
 * las subpeticiones. Y no hace falta: la página no lee ni escribe nada. Lo
 * único que expone es `MP_PUBLIC_KEY`, que es pública por diseño — su función
 * es exactamente ir embebida en una página. Con ella no se puede cobrar, sólo
 * crear tokens de un solo uso.
 *
 * El módulo entero está detrás de `PAYMENTS_SPIKE_ENABLED`, que no puede estar
 * encendido en producción.
 *
 * ─── VERSION_NEUTRAL ───
 *
 * La URL la arma la app y la carga un navegador embebido. Dejarla fuera del
 * versionado evita que un futuro /api/v2/ rompa el checkout.
 */
@Controller({ path: 'checkout', version: VERSION_NEUTRAL })
export class CheckoutPageController {
  @Get()
  page(
    @Query('orderId') orderId: string | undefined,
    @Query('amount') amount: string | undefined,
    @Query('email') email: string | undefined,
    @Query('desc') desc: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const html = renderCheckoutPage({
      publicKey: env.MP_PUBLIC_KEY ?? '',
      orderId: orderId ?? '',
      amount: Number(amount ?? 0),
      buyerEmail: email ?? '',
      description: desc ?? 'Compra',
    });

    reply
      .type('text/html; charset=utf-8')
      // La página trae la public key y el monto a mostrar: que no quede en
      // ninguna caché intermedia.
      .header('cache-control', 'no-store')
      // El SDK de Mercado Pago monta iframes propios; todo lo demás bloqueado.
      .header(
        'content-security-policy',
        [
          "default-src 'none'",
          "script-src 'unsafe-inline' https://sdk.mercadopago.com https://*.mercadopago.com https://*.mlstatic.com",
          "style-src 'unsafe-inline'",
          "connect-src https://api.mercadopago.com https://*.mercadopago.com https://*.mlstatic.com",
          "frame-src https://*.mercadopago.com https://*.mlstatic.com",
          "img-src data: https://*.mercadopago.com https://*.mlstatic.com",
          "form-action 'none'",
        ].join('; '),
      )
      .send(html);
  }
}
