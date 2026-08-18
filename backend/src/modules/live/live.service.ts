import { Injectable, Logger } from '@nestjs/common';

import { LiveKitService } from '@/modules/livekit/livekit.service';
import { SellerOAuthService } from '@/modules/payments/seller-oauth.service';
import { BloqueosService } from '@/modules/moderation/bloqueos.service';
import { AuditService } from '@/shared/audit/audit.service';
import { portadaDe } from '@/shared/storage/url-publica';
import { exigirHabilitada } from '@/shared/config/banderas';

import { AgendaService } from './agenda.service';
import { exigirPrecioDeVivoValido, precioDeVivoActivo, resolverPrecio } from './precio-de-vivo';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { EVENTOS } from './live-events';
import { puedeTransicionar, type EstadoDeVivo } from './live-state';
import { LiveGateway } from './live.gateway';

/**
 * Sesiones en vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL VIDEO ES DE LIVEKIT; TODO LO DEMÁS ES NUESTRO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este servicio decide en qué estado está un vivo, qué producto se está
 * mostrando y quién puede hacer qué. LiveKit sólo transporta audio y video.
 *
 * La consecuencia práctica: **si LiveKit se cae, el vivo no desaparece**.
 * Cambia de estado a `RECONNECTING`, el chat sigue, el producto destacado sigue
 * y —esto es lo importante— **se puede seguir comprando**. El video vuelve
 * cuando vuelve.
 */

export class NoEsTuVivoError extends DomainError {
  constructor() {
    // 404 y no 403: confirmar que la sesión existe le diría a quien prueba que
    // acertó un id ajeno. Misma política que el resto del sistema.
    super('NOT_FOUND', 'No se encontró la transmisión');
  }
}

export class TransicionInvalidaError extends DomainError {
  constructor(desde: string, hacia: string) {
    super('INVALID_TRANSITION', `No se puede pasar de ${desde} a ${hacia}`, { desde, hacia });
  }
}

export class VendedorNoHabilitadoError extends DomainError {
  constructor(estado: string) {
    // `SELLER_NOT_ACTIVE` ya existe y ya está mapeado a 403. Inventar un código
    // nuevo para lo mismo obliga a mantener dos entradas que pueden divergir.
    super('SELLER_NOT_ACTIVE', 'Tu cuenta de vendedor no está habilitada para transmitir', {
      estado,
    });
  }
}

@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
    private readonly gateway: LiveGateway,
    private readonly audit: AuditService,
    private readonly sellerOAuth: SellerOAuthService,
    private readonly bloqueos: BloqueosService,
    private readonly agenda: AgendaService,
  ) {}

  /**
   * Prepara una transmisión. La cámara **no** se enciende todavía.
   *
   * ─── Por qué existe este paso ───
   *
   * Tocar "Iniciar LIVE" no puede encender la cámara en público de una. Quien
   * transmite necesita ver su encuadre, elegir los productos y probar el
   * micrófono antes de que alguien lo vea. Un vendedor que aparece en pantalla
   * acomodándose el pelo con veinte personas mirando no vuelve a transmitir.
   *
   * En `SCHEDULED` la sala de LiveKit ya existe y el token ya está emitido, así
   * que salir al aire es instantáneo: sólo se publica lo que ya estaba
   * conectado.
   */
  async preparar(
    userId: string,
    datos: { title: string; coverUrl?: string; productIds: string[] },
  ) {
    // Interruptor de emergencia. Va primero: si los vivos están apagados no
    // tiene sentido resolver el vendedor ni validar nada.
    exigirHabilitada('LIVE_ENABLED');

    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      include: { stores: { where: { isPrimary: true }, take: 1 } },
    });

    if (!vendedor) throw new NoEsTuVivoError();

    /**
     * Suspendido o bloqueado no transmite.
     *
     * Es el único punto donde el estado del vendedor frena algo del vivo, y
     * tiene que estar acá: una transmisión es la superficie más visible de la
     * plataforma, y alguien suspendido por estafar no puede tener una.
     */
    if (vendedor.status !== 'ACTIVE') {
      throw new VendedorNoHabilitadoError(vendedor.status);
    }

    /**
     * Sin Mercado Pago conectado no hay vivo comercial.
     *
     * Se frena acá, al PREPARAR, y no al salir al aire: enterarse de que no
     * podés transmitir cuando ya tenés la cámara encendida y gente esperando es
     * la peor forma de descubrirlo.
     *
     * Un vivo es la superficie más visible de la plataforma y su único punto
     * es vender. Dejar transmitir sin poder cobrar en la cuenta del vendedor
     * significa que cada venta de ese vivo entra en la nuestra.
     */
    await this.sellerOAuth.exigirParaVender(vendedor.id, 'transmitir');

    const tienda = vendedor.stores[0];
    if (!tienda) throw new NoEsTuVivoError();

    /**
     * Un vivo activo a la vez por vendedor.
     *
     * Dos transmisiones simultáneas del mismo vendedor partirían a su audiencia
     * y dejarían el stock repartido entre dos salas sin que ninguna sepa de la
     * otra. Si hay una abierta, se devuelve esa en vez de crear otra: es lo que
     * quiere alguien que cerró la app y volvió a entrar.
     */
    const abierta = await this.prisma.liveSession.findFirst({
      where: { sellerId: vendedor.id, state: { in: ['SCHEDULED', 'STARTING', 'LIVE', 'RECONNECTING'] } },
      include: { products: true },
    });
    if (abierta) return this.conToken(abierta, userId, 'broadcaster');

    const id = newId('liv');
    const roomName = `live-${id}`;

    // Los productos se validan contra la tienda del vendedor: mandar el id de
    // un producto ajeno no puede meterlo en la bandeja.
    const productos = await this.prisma.product.findMany({
      where: {
        id: { in: datos.productIds.slice(0, 50) },
        store: { sellerId: vendedor.id },
        deletedAt: null,
      },
      select: { id: true },
    });

    const sesion = await this.prisma.liveSession.create({
      data: {
        id,
        sellerId: vendedor.id,
        storeId: tienda.id,
        title: datos.title,
        coverUrl: datos.coverUrl ?? null,
        roomName,
        state: 'SCHEDULED',
        products: {
          create: productos.map((p, i) => ({
            id: newId('lsp'),
            productId: p.id,
            position: i,
          })),
        },
      },
      include: { products: true },
    });

    // La sala se crea desde el backend para que los tiempos y el máximo de
    // participantes sean nuestros y no de quien se conecte primero.
    await this.livekit.ensureRoom(roomName, { emptyTimeoutS: 300 });

    await this.audit.log({
      action: 'live.prepared',
      entityType: 'live_session',
      entityId: sesion.id,
      actorId: userId,
      after: { title: datos.title, productos: productos.length },
    });

    return this.conToken(sesion, userId, 'broadcaster');
  }

  /**
   * Sale al aire.
   *
   * ─── Por qué pasa por `STARTING` y no salta directo a `LIVE` ───
   *
   * `LIVE` significa "hay video publicado". Entre que el vendedor toca el botón
   * y que su cámara está efectivamente transmitiendo pasan uno o dos segundos —
   * la conexión con LiveKit, la negociación, el primer cuadro. Marcar `LIVE` al
   * recibir el toque haría que el vivo apareciera en el feed antes de que
   * hubiera algo que ver, y quien entrara en esa ventana vería una pantalla
   * negra.
   *
   * Hoy las dos transiciones ocurren en esta misma llamada: en `SCHEDULED` la
   * sala ya existe y la app ya está conectada desde la vista previa, así que la
   * ventana es mínima. El estado intermedio existe y se emite igual, para que
   * el día que se enganche el webhook `track_published` de LiveKit —que es
   * cuando `LIVE` va a significar "hay video de verdad"— no haya que cambiar la
   * máquina de estados ni el contrato de la app.
   *
   * ⚠️ El primer intento de esto saltaba `SCHEDULED → LIVE` directo. La máquina
   * lo rechazaba, `transicionar` lo registraba y devolvía, y el endpoint
   * respondía `ok: true` con el vivo todavía en `SCHEDULED`: un fallo
   * silencioso. Lo encontró un test que comprobaba el estado en la base después
   * de iniciar.
   */
  async iniciar(userId: string, liveSessionId: string) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    if (sesion.state === 'LIVE') return { ok: true as const, estado: 'LIVE' as const };

    await this.transicionar(sesion.id, sesion.state, 'STARTING');
    await this.transicionar(sesion.id, 'STARTING', 'LIVE', { startedAt: new Date() });

    await this.audit.log({
      action: 'live.started',
      entityType: 'live_session',
      entityId: sesion.id,
      actorId: userId,
    });

    /**
     * Y se avisa: a los seguidores y a quienes marcaron «recordarme».
     *
     * ⚠️ `void` y no `await`: con cinco mil seguidores esto son cinco mil
     * inserciones, y el vendedor está esperando que la transmisión arranque. El
     * aviso puede tardar unos segundos más; el vivo no.
     *
     * ⚠️ Y el `catch` acá adentro: sin él, un fallo en el aviso sería un
     * rechazo de promesa sin manejar, que en Node tumba el proceso. Que no se
     * avise es malo; que se caiga el servidor a mitad de un vivo es peor.
     */
    void this.agenda.avisarQueArranco(sesion.id).catch((err: unknown) => {
      this.logger.error({
        msg: 'no se pudo avisar el arranque del vivo',
        liveSessionId: sesion.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { ok: true as const, estado: 'LIVE' as const };
  }

  /**
   * Termina la transmisión.
   *
   * ─── El resumen se calcula ACÁ y se guarda ───
   *
   * Y no se recalcula después. Las órdenes de un vivo se pueden cancelar o
   * devolver más adelante, y el resumen tiene que decir qué pasó **durante** la
   * transmisión. Calcularlo un mes más tarde daría otro número, y el vendedor
   * vería que su vivo "vendió menos" con el tiempo.
   */
  async terminar(userId: string, liveSessionId: string) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    if (sesion.state === 'ENDED') return { ok: true as const, yaEstaba: true };

    const ahora = new Date();
    const desde = sesion.startedAt ?? sesion.createdAt;

    const ventas = await this.ventasDesde(sesion.sellerId, desde);

    const duracionSegundos = sesion.startedAt
      ? Math.floor((ahora.getTime() - sesion.startedAt.getTime()) / 1000)
      : null;

    await this.prisma.liveSession.update({
      where: { id: sesion.id },
      data: {
        state: 'ENDED',
        endedAt: ahora,
        totalOrders: ventas.ordenes,
        grossAmount: ventas.brutoCentavos,
      },
    });

    /**
     * La sala de LiveKit se borra, la sesión NO.
     *
     * El vivo terminado sigue existiendo en la base con su vendedor, su tienda
     * y sus productos. Es lo que permite que quien estaba mirando siga
     * comprando después de que se cortó el video — el momento de más intención
     * de compra suele ser justo cuando el vivo termina.
     */
    await this.livekit.deleteRoom(sesion.roomName).catch(() => {
      // Si LiveKit no responde, la sala se limpia sola por inactividad. No
      // puede frenar el cierre.
    });

    this.gateway.emitir(sesion.id, EVENTOS.fin, {
      // Por ahora siempre true: los horarios de tienda son del bloque siguiente.
      tiendaAbierta: true,
      resumen: {
        duracionSegundos,
        espectadoresPico: sesion.peakViewers,
        ordenes: ventas.ordenes,
      },
      fecha: ahora.toISOString(),
    });

    await this.audit.log({
      action: 'live.ended',
      entityType: 'live_session',
      entityId: sesion.id,
      actorId: userId,
      after: { duracionSegundos, ordenes: ventas.ordenes },
    });

    return {
      ok: true as const,
      resumen: {
        duracionSegundos,
        espectadoresPico: sesion.peakViewers,
        ordenes: ventas.ordenes,
        unidades: ventas.unidades,
        brutoCentavos: ventas.brutoCentavos,
      },
    };
  }

  /**
   * Destaca un producto.
   *
   * Un toque durante la transmisión. Por eso la bandeja se prepara antes:
   * buscar en el catálogo entero con la cámara encendida es imposible de hacer
   * bien.
   */

  /**
   * El vendedor pone —o saca— el precio exclusivo de un producto en su vivo.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * UN DESCUENTO ES UNA PROMESA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «$12.500 ~~$18.000~~» le dice a alguien que si compra ahora paga menos que
   * mañana. Todo lo que se valida acá existe para que eso sea cierto:
   *
   *   · el precio de vivo tiene que ser MENOR que el de lista;
   *   · el tachado es el precio real, el que estaba antes;
   *   · fuera de la ventana no se muestra ni se cobra nada distinto.
   *
   * Ver `precio-de-vivo.ts`.
   */
  async ponerPrecioDeVivo(
    userId: string,
    liveSessionId: string,
    productId: string,
    datos: { precioCentavos: number | null; desde?: Date | null; hasta?: Date | null },
  ) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    // La pertenencia va en el WHERE: un producto de otra tienda simplemente no
    // está en la bandeja de este vivo.
    const enBandeja = await this.prisma.liveSessionProduct.findFirst({
      where: { liveSessionId: sesion.id, productId },
      select: {
        id: true,
        product: { select: { basePriceCents: true, name: true } },
      },
    });

    if (!enBandeja) {
      throw new DomainError('PRODUCT_NOT_FOUND', 'Ese producto no está en este vivo');
    }

    // Sacar el descuento: se vuelve al precio de lista.
    if (datos.precioCentavos === null) {
      await this.prisma.liveSessionProduct.update({
        where: { id: enBandeja.id },
        data: { livePriceCents: null, livePriceFrom: null, livePriceUntil: null },
      });

      await this.audit.log({
        action: 'live.price_removed',
        entityType: 'live_session',
        entityId: sesion.id,
        actorId: userId,
        after: { productId },
      });

      return { productId, precioDeVivo: null };
    }

    exigirPrecioDeVivoValido({
      precioDeLista: enBandeja.product.basePriceCents,
      precioDeVivo: datos.precioCentavos,
      desde: datos.desde,
      hasta: datos.hasta,
    });

    await this.prisma.liveSessionProduct.update({
      where: { id: enBandeja.id },
      data: {
        livePriceCents: datos.precioCentavos,
        livePriceFrom: datos.desde ?? null,
        livePriceUntil: datos.hasta ?? null,
      },
    });

    /**
     * ⚠️ Se audita SIEMPRE, con el precio de lista al lado.
     *
     * Es lo que permite responder «¿este descuento existió de verdad?» meses
     * después. Sin el precio de lista en el mismo registro, la bitácora diría
     * que alguien puso $12.500 sin decir contra qué.
     */
    await this.audit.log({
      action: 'live.price_set',
      entityType: 'live_session',
      entityId: sesion.id,
      actorId: userId,
      after: {
        productId,
        precioDeLista: enBandeja.product.basePriceCents,
        precioDeVivo: datos.precioCentavos,
        desde: datos.desde?.toISOString() ?? null,
        hasta: datos.hasta?.toISOString() ?? null,
      },
    });

    /**
     * Y se avisa a la sala en el momento.
     *
     * Un descuento que aparece cuando el vendedor lo anuncia en cámara —«se los
     * dejo a doce mil quinientos»— y no diez segundos después es la mitad de lo
     * que hace funcionar una venta en vivo.
     */
    this.gateway.emitir(sesion.id, EVENTOS.precioActualizado, {
      productId,
      ...resolverPrecio(enBandeja.product.basePriceCents, {
        livePriceCents: datos.precioCentavos,
        livePriceFrom: datos.desde ?? null,
        livePriceUntil: datos.hasta ?? null,
      }),
    });

    return {
      productId,
      precioDeVivo: datos.precioCentavos,
      precioDeLista: enBandeja.product.basePriceCents,
    };
  }

  async destacar(userId: string, liveSessionId: string, variantId: string | null) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    if (variantId === null) {
      await this.prisma.liveSession.update({
        where: { id: sesion.id },
        data: { featuredVariantId: null, featuredAt: new Date() },
      });

      this.gateway.emitir(sesion.id, EVENTOS.productoDestacado, {
        variantId: null,
        productId: null,
        nombre: null,
        variante: null,
        imagenUrl: null,
        precioCentavos: null,
        hayDescuento: false,
        precioDeListaCentavos: null,
        porcentajeDescuento: null,
        disponible: null,
        fecha: new Date().toISOString(),
      });

      return { ok: true as const, destacado: null };
    }

    /**
     * La variante tiene que ser de un producto de ESTE vendedor.
     *
     * La pertenencia va en el `where` y no en un `if` posterior: es la misma
     * disciplina que el resto del sistema. Una variante ajena simplemente no se
     * encuentra, y el 404 sale solo.
     */
    const variante = await this.prisma.productVariant.findFirst({
      where: {
        id: variantId,
        /**
         * Sólo lo que se puede comprar AHORA.
         *
         * Antes alcanzaba con que la variante fuera del vendedor. Eso dejaba
         * destacar un producto pausado o un borrador: la tarjeta aparecía en la
         * pantalla de todo el mundo con su botón de comprar, y la reserva lo
         * rechazaba después. El vendedor quedaba hablando de algo que nadie
         * podía llevarse.
         *
         * La pertenencia y el estado van los dos en el `where`: una variante
         * que no corresponde simplemente no se encuentra, y el 404 sale solo.
         */
        status: 'ACTIVE',
        product: {
          store: { sellerId: sesion.sellerId },
          status: 'ACTIVE',
          deletedAt: null,
        },
        deletedAt: null,
      },
      include: {
        inventory: true,
        options: { select: { optionValueId: true } },
        product: {
          include: { images: { where: { position: 0 }, take: 1 } },
        },
      },
    });

    if (!variante) throw new NoEsTuVivoError();

    await this.prisma.$transaction([
      this.prisma.liveSession.update({
        where: { id: sesion.id },
        data: { featuredVariantId: variantId, featuredAt: new Date() },
      }),
      // Se lleva la cuenta de cuántas veces se destacó cada producto: sirve
      // para el resumen del vivo y para saber qué funcionó.
      this.prisma.liveSessionProduct.updateMany({
        where: { liveSessionId: sesion.id, productId: variante.productId },
        data: { featuredCount: { increment: 1 }, lastFeaturedAt: new Date() },
      }),
    ]);

    const disponible = variante.inventory
      ? variante.inventory.onHand - variante.inventory.reserved
      : null;

    // El mismo precio que verá quien entre al vivo un segundo después.
    const precio = await this.precioEnEsteVivo(
      sesion.id,
      variante.productId,
      variante.priceOverrideCents ?? variante.product.basePriceCents,
    );

    this.gateway.emitir(sesion.id, EVENTOS.productoDestacado, {
      variantId: variante.id,
      productId: variante.productId,
      nombre: variante.product.name,
      // `null` si la variante es la interna del producto. Ver `variantePublica`.
      variante: variante.options.length === 0 ? null : variante.title,
      imagenUrl: portadaDe(variante.product.images),
      precioCentavos: precio.precioCentavos,
      hayDescuento: precio.hayDescuento,
      precioDeListaCentavos: precio.precioDeListaCentavos,
      porcentajeDescuento: precio.porcentaje,
      disponible,
      fecha: new Date().toISOString(),
    });

    return { ok: true as const, destacado: variante.id };
  }

  /**
   * Avisa que cambió el stock de una variante.
   *
   * Lo llama el módulo de inventario cuando una reserva se crea o se libera.
   * **Es un aviso, no una autorización**: la app lo usa para mostrar "últimas 3"
   * y deshabilitar el botón. Quien decide si hay stock sigue siendo el UPDATE
   * condicional de PostgreSQL.
   */
  async avisarStock(variantId: string, disponible: number): Promise<void> {
    const sesiones = await this.prisma.liveSession.findMany({
      where: { featuredVariantId: variantId, state: { in: ['LIVE', 'RECONNECTING'] } },
      select: { id: true },
    });

    for (const s of sesiones) {
      this.gateway.emitir(s.id, EVENTOS.stock, {
        variantId,
        disponible,
        fecha: new Date().toISOString(),
      });
    }
  }

  /** Marca que el broadcaster perdió la conexión. Lo dispara el webhook de LiveKit. */
  async marcarReconectando(liveSessionId: string): Promise<void> {
    const sesion = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: { id: true, state: true },
    });
    if (!sesion || sesion.state !== 'LIVE') return;

    await this.transicionar(sesion.id, 'LIVE', 'RECONNECTING');
  }

  /** Lo que ve un espectador al entrar. */
  async paraEspectador(liveSessionId: string, userId: string) {
    const sesion = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      include: {
        seller: {
          select: { id: true, userId: true, displayName: true, verificationStatus: true },
        },
        store: { select: { id: true, name: true } },
      },
    });

    if (!sesion) throw new NoEsTuVivoError();

    const destacado = sesion.featuredVariantId
      ? await this.variantePublica(sesion.featuredVariantId, sesion.id)
      : null;

    const base = {
      id: sesion.id,
      titulo: sesion.title,
      portada: sesion.coverUrl,
      estado: sesion.state,
      vendedor: {
        id: sesion.seller.id,
        nombre: sesion.seller.displayName,
        identidadVerificada: sesion.seller.verificationStatus === 'VERIFIED',
      },
      tienda: { id: sesion.store.id, nombre: sesion.store.name },
      /**
       * ¿Este vivo es de quien lo está mirando?
       *
       * Lo decide el servidor y no la app comparando ids: así el `userId` del
       * vendedor no tiene que salir en una respuesta pública. Es el mismo
       * criterio que en los bloqueos.
       *
       * La app lo usa para mostrar las opciones de moderación del chat. No es
       * una medida de seguridad —el backend valida cada acción igual— sino de
       * interfaz.
       */
      soyElVendedor: sesion.seller.userId === userId,
      destacado,
      iniciadoEl: sesion.startedAt,
      terminadoEl: sesion.endedAt,
    };

    /**
     * Un vivo terminado NO devuelve token de video.
     *
     * Devuelve todo lo demás: vendedor, tienda, producto destacado. Es lo que
     * permite que quien llega tarde —o quien vuelve de pagar— siga viendo el
     * contexto comercial en vez de una pantalla negra.
     */
    if (sesion.state === 'ENDED' || sesion.state === 'FAILED') {
      return { ...base, video: null };
    }

    const token = await this.livekit.issueToken({
      roomName: sesion.roomName,
      identity: userId,
      role: 'viewer',
    });

    return { ...base, video: { token: token.token, wsUrl: token.wsUrl, sala: token.roomName } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EL LADO DEL QUE TRANSMITE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ¿Este vendedor tiene un vivo abierto?
   *
   * Lo pregunta la app al entrar a "Mi tienda" para decidir si el botón dice
   * "Iniciar LIVE" o "Volver a tu vivo". Sin esto, alguien que cerró la app con
   * la transmisión andando vería el botón de empezar y crearía confusión sobre
   * si hay una o dos transmisiones.
   */
  async miVivoAbierto(userId: string) {
    const sesion = await this.prisma.liveSession.findFirst({
      where: {
        seller: { userId },
        state: { in: ['SCHEDULED', 'STARTING', 'LIVE', 'RECONNECTING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, state: true, startedAt: true },
    });

    if (!sesion) return { vivo: null };

    return {
      vivo: {
        id: sesion.id,
        titulo: sesion.title,
        estado: sesion.state,
        iniciadoEl: sesion.startedAt,
      },
    };
  }

  /**
   * Todo lo que la pantalla del vendedor necesita durante la transmisión.
   *
   * ─── Por qué una sola llamada y no cinco ───
   *
   * Quien transmite está hablando frente a una cámara. La pantalla se refresca
   * cada pocos segundos y cada refresco tiene que costar una petición, no
   * cinco: con red móvil variable, cinco peticiones son cinco oportunidades de
   * que una llegue tarde y el panel muestre datos de momentos distintos —stock
   * de hace diez segundos junto a ventas de ahora.
   *
   * ⚠️ **El stock que sale de acá es de presentación.** Sirve para que el
   * vendedor vea que se está agotando; quien decide si hay unidades sigue
   * siendo el UPDATE condicional del inventario.
   */
  async panelDelVendedor(userId: string, liveSessionId: string) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    const [bandeja, espectadores] = await Promise.all([
      this.prisma.liveSessionProduct.findMany({
        where: { liveSessionId: sesion.id },
        orderBy: { position: 'asc' },
        include: {
          product: {
            include: {
              images: { where: { position: 0 }, take: 1 },
              variants: {
                where: { deletedAt: null, status: 'ACTIVE' },
                include: {
                  inventory: true,
                  options: { select: { optionValueId: true } },
                },
              },
            },
          },
        },
      }),
      this.gateway.contarEspectadores(sesion.id),
    ]);

    const desde = sesion.startedAt ?? sesion.createdAt;
    const ventas = await this.ventasDesde(sesion.sellerId, desde);
    const ahora = new Date();

    return {
      id: sesion.id,
      titulo: sesion.title,
      estado: sesion.state,
      iniciadoEl: sesion.startedAt,
      duracionSegundos: sesion.startedAt
        ? Math.floor((Date.now() - sesion.startedAt.getTime()) / 1000)
        : 0,
      espectadores,
      espectadoresPico: sesion.peakViewers ?? espectadores,
      destacadoVariantId: sesion.featuredVariantId,
      ventas,
      bandeja: bandeja.map((b) => ({
        productId: b.productId,
        nombre: b.product.name,
        imagenUrl: portadaDe(b.product.images),
        posicion: b.position,
        vecesDestacado: b.featuredCount,
        /**
         * Un producto pausado sigue en la bandeja pero no se puede destacar.
         *
         * Sacarlo de la lista sería peor: el vendedor lo preparó y no
         * entendería por qué desapareció. Se muestra apagado, con el motivo.
         */
        vendible: b.product.status === 'ACTIVE' && b.product.deletedAt === null,
        /**
         * Lo que el vendedor cargó, tal cual, para poder editarlo.
         *
         * Acá NO se resuelve la ventana: el panel tiene que mostrar la oferta
         * programada aunque todavía no haya empezado, o el vendedor no podría
         * corregirla. Quien resuelve es la tarjeta del comprador.
         */
        precioDeVivoCentavos: b.livePriceCents,
        precioDeVivoDesde: b.livePriceFrom,
        precioDeVivoHasta: b.livePriceUntil,
        precioDeVivoActivo: precioDeVivoActivo(b, ahora),
        variantes: b.product.variants.map((v) => ({
          id: v.id,
          // `null` cuando es la variante interna. Ver `variantePublica`.
          etiqueta: v.options.length === 0 ? null : v.title,
          precioCentavos: v.priceOverrideCents ?? b.product.basePriceCents,
          disponible: v.inventory ? v.inventory.onHand - v.inventory.reserved : 0,
        })),
      })),
    };
  }

  /**
   * Cambia qué productos están en la bandeja y en qué orden.
   *
   * Reemplaza la lista completa en una transacción, igual que el horario de la
   * tienda: editar de a uno dejaría estados intermedios donde la bandeja tiene
   * un producto que el vendedor ya sacó.
   *
   * Se conservan `featuredCount` y `lastFeaturedAt` de los que siguen: son el
   * historial del vivo y reordenar no puede borrarlo.
   */
  async actualizarBandeja(userId: string, liveSessionId: string, productIds: string[]) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    // Los ids se validan contra la tienda del vendedor: mandar el de un
    // producto ajeno no puede meterlo en la bandeja.
    const propios = await this.prisma.product.findMany({
      where: {
        id: { in: productIds.slice(0, 50) },
        store: { sellerId: sesion.sellerId },
        deletedAt: null,
      },
      select: { id: true },
    });

    const validos = productIds.filter((id) => propios.some((p) => p.id === id));

    await this.prisma.$transaction([
      this.prisma.liveSessionProduct.deleteMany({
        where: { liveSessionId: sesion.id, productId: { notIn: validos } },
      }),
      ...validos.map((productId, i) =>
        this.prisma.liveSessionProduct.upsert({
          where: { liveSessionId_productId: { liveSessionId: sesion.id, productId } },
          create: { id: newId('lsp'), liveSessionId: sesion.id, productId, position: i },
          update: { position: i },
        }),
      ),
    ]);

    return { ok: true as const, productos: validos.length };
  }

  /**
   * El que transmite volvió después de un corte.
   *
   * ─── Por qué no alcanza con `iniciar` ───
   *
   * `iniciar` sale temprano si el estado ya es `LIVE`, así que no sirve para
   * salir de `RECONNECTING`. Y `RECONNECTING → LIVE` es una transición válida
   * que hasta ahora nadie podía disparar: el vivo se quedaba marcado como
   * reconectando para siempre aunque el video hubiera vuelto, y los
   * espectadores seguían viendo el cartel encima de una imagen que ya andaba.
   */
  async reanudar(userId: string, liveSessionId: string) {
    const sesion = await this.deVendedor(userId, liveSessionId);

    if (sesion.state === 'LIVE') return { ok: true as const, estado: 'LIVE' as const };
    if (sesion.state !== 'RECONNECTING') {
      throw new TransicionInvalidaError(sesion.state, 'LIVE');
    }

    await this.transicionar(sesion.id, 'RECONNECTING', 'LIVE');
    return { ok: true as const, estado: 'LIVE' as const };
  }

  /** Ventas del vendedor desde un instante. Compartido por el panel y el cierre. */
  private async ventasDesde(sellerId: string, desde: Date) {
    const [agregado, unidades] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          sellerId,
          createdAt: { gte: desde },
          status: { notIn: ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'] },
        },
        _count: true,
        _sum: { grossAmount: true },
      }),
      this.prisma.orderItem.aggregate({
        where: {
          order: {
            sellerId,
            createdAt: { gte: desde },
            status: { notIn: ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'] },
          },
        },
        _sum: { quantity: true },
      }),
    ]);

    return {
      ordenes: agregado._count,
      brutoCentavos: agregado._sum.grossAmount ?? 0,
      unidades: unidades._sum.quantity ?? 0,
    };
  }

  /**
   * Los vivos activos, para el feed.
   *
   * ─── Sin los vendedores que esta persona bloqueó ───
   *
   * `userId` es opcional porque el feed también se ve sin sesión. Con sesión,
   * los vivos de quien bloqueó no aparecen.
   *
   * Es unilateral: si B bloqueó a A, A sigue viendo los vivos de B. Lo
   * contrario permitiría hacerle desaparecer la tienda a alguien
   * bloqueándolo, que es una forma barata de sabotear a un competidor.
   */
  async activos(limite = 20, userId?: string) {
    const bloqueados = userId ? await this.bloqueos.bloqueadosPor(userId) : [];

    const sesiones = await this.prisma.liveSession.findMany({
      where: {
        state: { in: ['LIVE', 'RECONNECTING'] },
        /**
         * Sólo vendedores en regla.
         *
         * ═══════════════════════════════════════════════════════════════════
         * SANCIONAR NO LE CORTABA LA TRANSMISIÓN
         * ═══════════════════════════════════════════════════════════════════
         *
         * `cambiarEstadoVendedor` pausa las tiendas del sancionado, pero acá
         * no se miraba su estado. Un vendedor bloqueado POR FRAUDE seguía en
         * el feed de todo el mundo en el segundo siguiente a la sanción: se
         * le pausaba el catálogo y se le dejaba el micrófono.
         *
         * El mismo agujero dejaba al aire a quien cerró su cuenta mientras
         * transmitía, ahora con el cartel «Cuenta eliminada» encima.
         *
         * No hace falta cortar la sesión en LiveKit para esto: sacarla del
         * listado la vuelve inalcanzable desde la app, y la sesión termina
         * sola por el camino de siempre.
         *
         * El filtro va en el WHERE y no en un `.filter()` posterior: filtrar
         * después rompe la paginación —se piden veinte y llegan diecisiete— y
         * acá el tope es `take`.
         */
        seller: {
          status: 'ACTIVE',
          ...(bloqueados.length > 0 ? { userId: { notIn: bloqueados } } : {}),
        },
      },
      orderBy: { startedAt: 'desc' },
      take: limite,
      include: {
        seller: { select: { id: true, displayName: true, verificationStatus: true } },
        store: { select: { id: true, name: true } },
      },
    });

    return sesiones.map((s) => ({
      id: s.id,
      titulo: s.title,
      portada: s.coverUrl,
      estado: s.state,
      vendedor: {
        id: s.seller.id,
        nombre: s.seller.displayName,
        identidadVerificada: s.seller.verificationStatus === 'VERIFIED',
      },
      tienda: { id: s.store.id, nombre: s.store.name },
      iniciadoEl: s.startedAt,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * La sesión con su token de LiveKit para quien transmite.
   *
   * El token se emite **cada vez** en vez de guardarse: tiene vencimiento, y
   * uno guardado en la base sería un token válido esperando a que alguien lea
   * esa fila. Emitirlo cuesta una firma HMAC.
   */
  private async conToken(
    sesion: { id: string; title: string; coverUrl: string | null; state: string; roomName: string; featuredVariantId: string | null; products?: Array<{ productId: string; position: number }> },
    userId: string,
    rol: 'broadcaster' | 'viewer',
  ) {
    const token = await this.livekit.issueToken({
      roomName: sesion.roomName,
      identity: userId,
      role: rol,
    });

    return {
      id: sesion.id,
      titulo: sesion.title,
      portada: sesion.coverUrl,
      estado: sesion.state,
      productos: (sesion.products ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((p) => p.productId),
      destacado: sesion.featuredVariantId,
      video: {
        token: token.token,
        wsUrl: token.wsUrl,
        sala: token.roomName,
        venceEl: token.expiresAt,
      },
    };
  }

  private async deVendedor(userId: string, liveSessionId: string) {
    // La pertenencia va en el WHERE: una sesión ajena no se encuentra, y no hay
    // forma de escribir mal el `if` que la comprueba porque no hay `if`.
    const sesion = await this.prisma.liveSession.findFirst({
      where: { id: liveSessionId, seller: { userId } },
    });
    if (!sesion) throw new NoEsTuVivoError();
    return sesion;
  }

  /**
   * Cambia de estado, con la guarda adentro.
   *
   * La condición va en el `where` del `update`: si otro proceso ya cambió el
   * estado, esto afecta cero filas y lo sabemos. Leer, decidir y escribir en
   * tres pasos dejaría una ventana donde dos peticiones concurrentes —el
   * vendedor cerrando y el webhook de LiveKit avisando una desconexión— podrían
   * pisarse.
   */
  private async transicionar(
    id: string,
    desde: EstadoDeVivo,
    hacia: EstadoDeVivo,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!puedeTransicionar(desde, hacia)) throw new TransicionInvalidaError(desde, hacia);

    const { count } = await this.prisma.liveSession.updateMany({
      where: { id, state: desde },
      data: { state: hacia, ...extra },
    });

    if (count === 0) {
      // Otro cambió el estado en el medio. No es un error del que llamó: se
      // registra y se sigue.
      this.logger.warn({ msg: 'la transición no se aplicó: el estado cambió', id, desde, hacia });
      return;
    }

    this.gateway.emitir(id, EVENTOS.estado, {
      estado: hacia,
      fecha: new Date().toISOString(),
    });
  }

  /**
   * El precio de un producto **dentro de este vivo**.
   *
   * Existe para que la tarjeta y el cobro salgan del mismo lugar. Cuando no
   * salían, la tarjeta decía $18.000, la orden cobraba $12.500 y el comprador
   * se enteraba del descuento en el resumen de pago — que es el único momento
   * en que un descuento no sirve para nada.
   *
   * Ver `precio-de-vivo.ts`. Acá sólo se busca la fila de la bandeja.
   */
  private async precioEnEsteVivo(
    liveSessionId: string,
    productId: string,
    precioDeLista: number,
  ) {
    const enBandeja = await this.prisma.liveSessionProduct.findFirst({
      where: { liveSessionId, productId },
      select: { livePriceCents: true, livePriceFrom: true, livePriceUntil: true },
    });

    // Un producto que no está en la bandeja no tiene precio de vivo: se cobra
    // el de lista. `resolverPrecio` ya devuelve eso con la ventana vacía.
    return resolverPrecio(
      precioDeLista,
      enBandeja ?? { livePriceCents: null, livePriceFrom: null, livePriceUntil: null },
    );
  }

  private async variantePublica(variantId: string, liveSessionId: string) {
    const v = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: {
        inventory: true,
        options: { select: { optionValueId: true } },
        product: { include: { images: { where: { position: 0 }, take: 1 } } },
      },
    });
    if (!v) return null;

    const precio = await this.precioEnEsteVivo(
      liveSessionId,
      v.productId,
      v.priceOverrideCents ?? v.product.basePriceCents,
    );

    return {
      variantId: v.id,
      productId: v.productId,
      nombre: v.product.name,
      /**
       * `null` cuando la variante es la interna del producto.
       *
       * En el esquema `title` es `@default("Default")`, así que un producto sin
       * talles ni colores tiene una única variante llamada así. La tarjeta del
       * producto destacado lo mostraba tal cual, al lado del precio, y decía
       * "Campera de lana · Default" en la cara de quien está por comprar.
       *
       * La señal no es el texto —un vendedor podría escribir esa palabra— sino
       * que la variante **no tenga valores de opción**: si no hay nada que
       * elegir, no hay nada que nombrar.
       */
      variante: v.options.length === 0 ? null : v.title,
      imagenUrl: portadaDe(v.product.images),
      precioCentavos: precio.precioCentavos,
      /**
       * El tachado sale sólo cuando hay descuento de verdad.
       *
       * `hayDescuento` es `false` si la oferta venció, si todavía no empezó o
       * si el precio de lista bajó por debajo del de vivo. En esos casos
       * `precioDeListaCentavos` viaja igual, pero la app no lo muestra: es la
       * regla de veracidad, y la app la respeta mirando esta bandera y no
       * comparando los dos números por su cuenta.
       */
      hayDescuento: precio.hayDescuento,
      precioDeListaCentavos: precio.precioDeListaCentavos,
      porcentajeDescuento: precio.porcentaje,
      disponible: v.inventory ? v.inventory.onHand - v.inventory.reserved : null,
    };
  }
}
