import { Controller, Delete, Get, Post, Query, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';

import { SellerOAuthService } from './seller-oauth.service';

/**
 * Conectar y desconectar la cuenta de Mercado Pago del vendedor.
 *
 * ─── Tres endpoints con sesión, uno sin ───
 *
 * Iniciar, consultar y desconectar los llama la app con su token. El callback
 * lo llama el NAVEGADOR del vendedor siguiendo una redirección de Mercado
 * Pago, sin encabezado de autorización — no puede llevarlo.
 *
 * La identidad de ese cuarto endpoint sale del `state`. Ver el comentario
 * largo en `completar()` del servicio.
 */
@Controller({ version: '1' })
export class SellerOAuthController {
  constructor(private readonly oauth: SellerOAuthService) {}

  /**
   * Devuelve la URL a la que la app tiene que mandar al vendedor.
   *
   * ⚠️ La app abre esa URL en un navegador **del sistema**, no en un WebView
   * propio. Mercado Pago pide la contraseña ahí adentro: en un WebView de
   * nuestra app, esa contraseña pasa por una vista que nosotros controlamos, y
   * aunque no la leamos, no hay forma de que el vendedor sepa que no la
   * leemos. Un navegador del sistema muestra la barra de direcciones con el
   * dominio real y el candado.
   *
   * Con límite: cada toque invalida el `state` anterior y crea una fila.
   */
  @RateLimit({ limit: 10, windowSec: 600, bucket: 'mp:oauth:start' })
  @Post('sellers/me/payment-account/connect')
  iniciar(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.iniciar(user.id);
  }

  /** Si puede cobrar, con qué cuenta y hasta cuándo. **Sin tokens.** */
  @Get('sellers/me/payment-account')
  estado(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.estado(user.id);
  }

  @Delete('sellers/me/payment-account')
  desconectar(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.desconectar(user.id);
  }
}

/**
 * El callback de Mercado Pago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FUERA DEL VERSIONADO Y DEL PREFIJO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Esta URL se carga **a mano** en el panel de aplicaciones de Mercado Pago y
 * tiene que coincidir carácter por carácter. Si viviera bajo `/api/v1/`, el día
 * que exista `/api/v2/` habría que entrar al panel a cambiarla, y mientras
 * tanto cada vendedor que intente conectar vería un error de Mercado Pago que
 * no dice cuál es el problema.
 *
 * Es la misma razón por la que el webhook está fuera del versionado.
 *
 * ⚠️ La ruta se declara en `shared/http/rutas-webhook.ts` y `main.ts` la excluye
 * del prefijo global desde ahí. **No escribirla suelta en dos lados**: ya pasó
 * cuatro veces y las cuatro terminó en tests verdes sobre un servidor que no
 * existe.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEVUELVE HTML, NO JSON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Del otro lado hay un navegador con una persona mirándolo. Un `{"ok":true}` en
 * pantalla, después de haber puesto su contraseña de Mercado Pago, se lee como
 * que algo salió mal.
 */
@Public()
@Controller({ path: 'oauth/mercadopago', version: VERSION_NEUTRAL })
export class SellerOAuthCallbackController {
  constructor(private readonly oauth: SellerOAuthService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // El vendedor apretó "cancelar" en Mercado Pago. No es un fallo nuestro.
    if (error) {
      return this.responder(reply, {
        ok: false,
        titulo: 'No se conectó',
        detalle: 'Cancelaste la autorización. Podés intentarlo de nuevo cuando quieras.',
      });
    }

    if (!code || !state) {
      return this.responder(reply, {
        ok: false,
        titulo: 'Faltan datos',
        detalle: 'El enlace está incompleto. Volvé a intentar desde la app.',
      });
    }

    try {
      await this.oauth.completar(state, code);
      return this.responder(reply, {
        ok: true,
        titulo: 'Listo',
        detalle: 'Tu cuenta de Mercado Pago quedó conectada. Ya podés volver a la app.',
      });
    } catch (err) {
      /**
       * El motivo NO se muestra.
       *
       * Distinguir "el state venció" de "el state no existe" le confirma a
       * quien esté probando un ataque qué parte de su intento funcionó. Y para
       * el vendedor legítimo la acción es la misma en los dos casos: volver a
       * la app y tocar conectar.
       */
      return this.responder(reply, {
        ok: false,
        titulo: 'No pudimos conectar',
        detalle: 'Volvé a la app y probá de nuevo.',
        mensaje: err instanceof Error ? undefined : undefined,
      });
    }
  }

  /**
   * Una página mínima, sin recursos externos.
   *
   * Nada de CDN ni fuentes remotas: esta página se abre justo después de una
   * pantalla de Mercado Pago, y una petición a un tercero desde acá sería una
   * baliza que le cuenta a alguien más que este vendedor acaba de conectar su
   * cuenta.
   */
  private responder(
    reply: FastifyReply,
    p: { ok: boolean; titulo: string; detalle: string; mensaje?: string },
  ): void {
    const color = p.ok ? '#25C26E' : '#FF3B5C';
    const icono = p.ok ? '✓' : '✕';

    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VendoX</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0B0B0E; color: #F2F2F5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  .caja { max-width: 340px; text-align: center; }
  .icono {
    width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 50%;
    display: grid; place-items: center; font-size: 30px; font-weight: 700;
    background: ${color}22; color: ${color};
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14.5px; line-height: 1.5; color: #A0A0AB; margin: 0; }
</style>
</head>
<body>
  <div class="caja">
    <div class="icono">${icono}</div>
    <h1>${p.titulo}</h1>
    <p>${p.detalle}</p>
  </div>
</body>
</html>`;

    // 200 incluso en el caso de error: del otro lado hay un navegador, y un
    // 4xx hace que algunos muestren su propia página de error en vez de esta.
    reply.status(200).type('text/html; charset=utf-8').send(html);
  }
}
