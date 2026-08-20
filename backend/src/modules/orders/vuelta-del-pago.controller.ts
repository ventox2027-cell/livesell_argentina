import { Controller, Get, Param, Query, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '@/modules/auth/auth.guard';

/**
 * A dónde vuelve la persona cuando termina en Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTA PÁGINA CASI NUNCA SE VE, Y TIENE QUE EXISTIR IGUAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vendox.com.ar` está declarado en el `AndroidManifest` como App Link
 * verificado, sin prefijo de ruta. O sea que cuando Mercado Pago redirige acá,
 * Android **abre VendoX directamente** y esta página nunca se dibuja.
 *
 * Se dibuja en los casos de borde, que son los que hay que cubrir:
 *
 *   · la persona pagó desde el navegador de una computadora;
 *   · desinstaló la app entre que empezó a pagar y volvió;
 *   · la verificación del App Link falló en ese teléfono.
 *
 * En todos, lo que NO puede pasar es una pantalla en blanco o un 404 justo
 * después de pagar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL ESTADO QUE VIENE EN LA URL NO DECIDE NADA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ `?estado=aprobado` lo escribe Mercado Pago al redirigir, y lo puede
 * escribir cualquiera: es una URL. Acá sólo sirve para elegir qué texto
 * mostrar mientras tanto.
 *
 * Quién decide si la orden está paga es el webhook, que es la única fuente de
 * verdad del sistema. Por eso esta página **no consulta ni modifica nada**: no
 * toca la base, no confirma órdenes, no le cree a la URL.
 */
@Public()
@Controller({ path: 'pago', version: VERSION_NEUTRAL })
export class VueltaDelPagoController {
  @Get(':orderId')
  pagina(
    @Param('orderId') _orderId: string,
    @Query('estado') estado: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    reply
      .type('text/html; charset=utf-8')
      // Sin caché: el estado de un pago cambia, y una copia guardada podría
      // decirle a alguien que su compra falló cuando ya está confirmada.
      .header('cache-control', 'no-store')
      .send(paginaDeVuelta(estado));
  }
}

/** Qué se le dice a alguien que vuelve de pagar, según lo que dijo el enlace. */
export function textoDeVuelta(estado: string | undefined): { titulo: string; detalle: string } {
  switch (estado) {
    case 'aprobado':
      return {
        titulo: 'Listo, pagaste',
        detalle:
          'Abrí VendoX para ver tu pedido. Si tardás en verlo confirmado, es que todavía se está acreditando.',
      };
    case 'pendiente':
      return {
        titulo: 'Tu pago está en camino',
        detalle:
          'Mercado Pago todavía lo está procesando. Abrí VendoX: te avisamos ahí cuando se acredite.',
      };
    case 'rechazado':
      return {
        titulo: 'El pago no se hizo',
        detalle: 'No se te cobró nada. Abrí VendoX y probá de nuevo, con este u otro medio de pago.',
      };
    default:
      /**
       * Sin estado, o con uno que no conocemos.
       *
       * Pasa cuando alguien toca «Volver» antes de terminar. ⚠️ No se dice ni
       * que pagó ni que falló: no lo sabemos, y las dos afirmaciones son
       * peores que admitirlo.
       */
      return {
        titulo: 'Volviste a VendoX',
        detalle: 'Abrí la app para ver cómo quedó tu pedido.',
      };
  }
}

function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paginaDeVuelta(estado: string | undefined): string {
  const { titulo, detalle } = textoDeVuelta(estado);

  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)} · VendoX</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 28px 20px;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #16181d;
    display: grid; place-items: center; min-height: 70vh; text-align: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0e0d12; color: #ecebf0; }
    .caja { background: #17161c; }
    p { color: #9b98a6; }
  }
  .caja { background: #fff; border-radius: 14px; padding: 26px 22px; max-width: 22rem; }
  h1 { font-size: 19px; margin: 0 0 10px; }
  p { font-size: 14.5px; line-height: 1.55; color: #555; margin: 0; }
</style>
</head>
<body>
  <div class="caja">
    <h1>${escapar(titulo)}</h1>
    <p>${escapar(detalle)}</p>
  </div>
</body>
</html>`;
}
