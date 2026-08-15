import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Public, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { AgendaService } from './agenda.service';
import { ChatModeracionService } from './chat-moderacion.service';
import { LiveService } from './live.service';

/** Programar un vivo. La fecha viaja en ISO: es lo que no se malinterpreta. */
const ProgramarSchema = z.object({
  title: z.string().trim().min(2).max(120),
  cuando: z.string().datetime(),
  coverUrl: z.string().url().max(500).optional(),
  productIds: z.array(z.string().max(40)).max(50).optional(),
});
type ProgramarDto = z.infer<typeof ProgramarSchema>;

/**
 * El precio exclusivo del vivo.
 *
 * ⚠️ En CENTAVOS, como todo el dinero del sistema. Y `null` significa «sacá el
 * descuento», que es distinto de no mandar el campo: por eso es `nullable` y no
 * `optional`.
 */
const PrecioDeVivoSchema = z.object({
  precioCentavos: z.number().int().min(100).max(1_000_000_000).nullable(),
  desde: z.string().datetime().nullish(),
  hasta: z.string().datetime().nullish(),
});
type PrecioDeVivoDto = z.infer<typeof PrecioDeVivoSchema>;

const PrepararSchema = z.object({
  title: z.string().trim().min(3).max(120),
  coverUrl: z.string().url().max(500).optional(),
  /** La bandeja del vivo. Se puede empezar vacía y agregar después. */
  productIds: z.array(z.string().max(64)).max(50).default([]),
});
type PrepararDto = z.infer<typeof PrepararSchema>;

const DestacarSchema = z.object({
  /** `null` deja de destacar. */
  variantId: z.string().max(64).nullable(),
});
type DestacarDto = z.infer<typeof DestacarSchema>;

const BandejaSchema = z.object({
  /** La bandeja completa, en orden. Se reemplaza entera, no se edita de a uno. */
  productIds: z.array(z.string().max(64)).max(50),
});
type BandejaDto = z.infer<typeof BandejaSchema>;

@Controller({ path: 'live', version: '1' })
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly agenda: AgendaService,
  ) {}

  // ─── Espectador ────────────────────────────────────────────────────────────

  /**
   * Los vivos activos.
   *
   * Público: alguien que todavía no se registró tiene que poder ver qué hay en
   * vivo. La cuenta se pide cuando quiere comprar o comentar, no antes.
   */
  @Public()
  @Get()
  activos(
    @Query('limit') limit: string | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    /**
     * `@CurrentUser()` es opcional acá: la ruta es pública y muchas veces no
     * hay sesión. Con sesión, el feed esconde a quienes esta persona bloqueó.
     */
    return this.live.activos(Math.min(Number(limit) || 20, 50), user?.id);
  }

  /**
   * Entrar a un vivo.
   *
   * Requiere sesión porque devuelve un token de LiveKit, que es una credencial
   * con nombre y apellido: se emite para una identidad concreta y con permisos
   * de sólo suscripción.
   */
  @Get(':id')
  ver(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.paraEspectador(id, user.id);
  }

  // ─── Vendedor ──────────────────────────────────────────────────────────────

  /**
   * Prepara una transmisión. **No enciende la cámara en público.**
   *
   * Devuelve el token de broadcaster para que la app pueda conectarse y mostrar
   * la vista previa. Salir al aire es el paso siguiente.
   */
  @RateLimit({ limit: 20, windowSec: 3600, bucket: 'live:prepare' })
  // ─── Vivos programados ─────────────────────────────────────────────────────

  /**
   * Anunciar un vivo para más adelante.
   *
   * Un vivo sin anuncio arranca con quien justo estaba en la app; uno anunciado
   * arranca con quien decidió estar. Para el vendedor es la diferencia entre
   * transmitirle a tres personas y a treinta.
   */
  @RateLimit({ limit: 20, windowSec: 3600, bucket: 'live:schedule' })
  @Post('scheduled')
  programar(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ProgramarSchema)) dto: ProgramarDto,
  ) {
    return this.agenda.programar(user.id, {
      title: dto.title,
      cuando: new Date(dto.cuando),
      coverUrl: dto.coverUrl,
      productIds: dto.productIds,
    });
  }

  /** Los próximos vivos de un vendedor. Público: es su cartelera. */
  @Public()
  @Get('scheduled/seller/:sellerId')
  proximosDe(
    @CurrentUser() user: AuthenticatedUser | null,
    @Param('sellerId') sellerId: string,
  ) {
    return this.agenda.proximosDe(sellerId, user?.id);
  }

  /**
   * «Recordarme». Interruptor, igual que el corazón.
   *
   * ⚠️ Es distinto de seguir al vendedor: alguien puede querer ver ESTE vivo
   * sin querer que le suene el teléfono en cada transmisión de esa tienda.
   */
  @RateLimit({ limit: 60, windowSec: 3600, bucket: 'live:remind' })
  @Post('scheduled/:id/remind')
  recordarme(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.agenda.alternarRecordatorio(user.id, id);
  }

  @Post()
  preparar(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PrepararSchema)) dto: PrepararDto,
  ) {
    return this.live.preparar(user.id, dto);
  }

  /**
   * ¿Tengo un vivo abierto?
   *
   * Va ANTES de `:id` a propósito: Nest resuelve por orden de declaración, y
   * declarada después, `GET /live/mine` entraría por `GET /live/:id` con
   * `id = 'mine'` y devolvería 404 siempre.
   */
  @Get('mine')
  mio(@CurrentUser() user: AuthenticatedUser) {
    return this.live.miVivoAbierto(user.id);
  }

  /** Todo lo que la pantalla del vendedor necesita mientras transmite. */
  @Get(':id/panel')
  panel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.panelDelVendedor(user.id, id);
  }

  /** Cambia qué productos están en la bandeja y en qué orden. */
  @Put(':id/products')
  bandeja(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BandejaSchema)) dto: BandejaDto,
  ) {
    return this.live.actualizarBandeja(user.id, id, dto.productIds);
  }

  @Post(':id/start')
  iniciar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.iniciar(user.id, id);
  }

  /**
   * Volví después de un corte.
   *
   * Sin límite apretado: quien está transmitiendo con mala señal puede
   * reconectar varias veces seguidas, y frenarlo ahí lo dejaría marcado como
   * "reconectando" con el video ya funcionando.
   */
  @RateLimit({ limit: 60, windowSec: 60, bucket: 'live:resume' })
  @Post(':id/resume')
  reanudar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.reanudar(user.id, id);
  }

  @Post(':id/end')
  terminar(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.live.terminar(user.id, id);
  }

  /**
   * Destaca un producto.
   *
   * Sin límite de peticiones apretado: durante un vivo el vendedor cambia de
   * producto seguido, y es la interacción más frecuente que tiene. Un límite
   * bajo acá se sentiría como que la app no responde.
   */
  @RateLimit({ limit: 120, windowSec: 60, bucket: 'live:feature' })
  /**
   * El precio exclusivo de un producto en este vivo.
   *
   * Un `precioCentavos` en `null` lo saca y vuelve al precio de lista.
   *
   * ⚠️ El límite es alto porque bajar y subir precios EN VIVO es lo que hace un
   * vendedor durante una transmisión — «los últimos tres a diez mil»— y frenarlo
   * sería frenar la función.
   */
  @RateLimit({ limit: 120, windowSec: 3600, bucket: 'live:price' })
  @Put(':id/products/:productId/price')
  ponerPrecioDeVivo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(PrecioDeVivoSchema)) dto: PrecioDeVivoDto,
  ) {
    return this.live.ponerPrecioDeVivo(user.id, id, productId, {
      precioCentavos: dto.precioCentavos,
      desde: dto.desde ? new Date(dto.desde) : null,
      hasta: dto.hasta ? new Date(dto.hasta) : null,
    });
  }

  @Post(':id/feature')
  destacar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DestacarSchema)) dto: DestacarDto,
  ) {
    return this.live.destacar(user.id, id, dto.variantId);
  }
}

const SilenciarSchema = z.object({
  userId: z.string().min(1).max(64),
  /**
   * Obligatorio, y con mínimo real.
   *
   * Un silencio sin motivo no se puede revisar ni defender. Y `min(3)` en vez
   * de `min(1)`: un motivo de un carácter es lo mismo que no tenerlo.
   */
  reason: z.string().trim().min(3).max(300),
  /**
   * Cuánto. El vendedor tiene un tope de 24 horas: más que eso ya no es
   * "durante mi vivo", y una expulsión de la plataforma la decide moderación.
   */
  minutos: z.coerce.number().int().min(1).max(60 * 24).default(15),
});
type SilenciarDto = z.infer<typeof SilenciarSchema>;

/**
 * Moderar el chat de un vivo, desde el lado del vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL VENDEDOR MANDA EN SU SALA, NO EN LA PLATAFORMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Puede borrar un mensaje de su vivo y callar a alguien durante un rato. No
 * puede silenciar para siempre, ni en otros vivos, ni suspender una cuenta:
 * eso son sanciones de plataforma y las decide VendoX.
 *
 * ⛔ Ninguna de estas acciones la toma un filtro automático. El filtro frena el
 * mensaje y lo registra; sancionar lo decide una persona.
 */
@Controller({ path: 'live/:liveId/chat', version: '1' })
export class ChatModeracionController {
  constructor(private readonly moderacion: ChatModeracionService) {}

  /**
   * El chat completo, con lo borrado y lo frenado por el filtro.
   *
   * Sólo el dueño del vivo. Es lo que necesita para moderar y para entender por
   * qué a alguien no le salió un mensaje.
   */
  @Get()
  async historial(
    @CurrentUser() user: AuthenticatedUser,
    @Param('liveId') liveId: string,
    @Query('limit') limit?: string,
  ) {
    await this.moderacion.exigirSerDuenoDelVivo(liveId, user.id);
    return this.moderacion.historial(liveId, limit ? Number(limit) : undefined);
  }

  @Delete('messages/:messageId')
  borrarMensaje(
    @CurrentUser() user: AuthenticatedUser,
    @Param('messageId') messageId: string,
  ) {
    return this.moderacion.borrarMensaje({ mensajeId: messageId, porUserId: user.id });
  }

  /**
   * Callar a alguien durante este vivo.
   *
   * El límite es alto —cien por hora— a propósito: un vivo con un grupo
   * organizado molestando necesita que el vendedor pueda callar a varios
   * seguidos. Frenarlo ahí sería dejarlo sin herramienta justo cuando la
   * necesita.
   */
  @RateLimit({ limit: 100, windowSec: 3600, bucket: 'chat:mute' })
  @Post('mutes')
  silenciar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('liveId') liveId: string,
    @Body(new ZodValidationPipe(SilenciarSchema)) dto: SilenciarDto,
  ) {
    return this.moderacion.silenciar({
      liveSessionId: liveId,
      aUserId: dto.userId,
      porUserId: user.id,
      motivo: dto.reason,
      minutos: dto.minutos,
    });
  }

  @Delete('mutes/:userId')
  devolverLaVoz(
    @CurrentUser() user: AuthenticatedUser,
    @Param('liveId') liveId: string,
    @Param('userId') userId: string,
  ) {
    return this.moderacion.devolverLaVoz({
      liveSessionId: liveId,
      aUserId: userId,
      porUserId: user.id,
    });
  }
}
