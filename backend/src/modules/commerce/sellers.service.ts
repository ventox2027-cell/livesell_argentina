import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type ExchangeMode,
  type ProcessorFeeMode,
  type ReturnShippingPayer,
  type Seller,
  type ShippingMode,
  type Store,
} from '@prisma/client';

import {
  costoDeEnvio,
  etiquetaDeEnvio,
  permiteEnvio,
  permiteRetiro,
} from '@/modules/orders/shipping';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { exigirHabilitada } from '@/shared/config/banderas';
import { DomainError } from '@/shared/errors/domain.error';
import { exigirMayoriaDeEdad } from '@/modules/users/edad';
import { env } from '@/config/env.schema';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';
import { slugDisponible } from '@/shared/utils/slug';

import type {
  CreateSellerDto,
  ChangeStoreSlugDto,
  UpdateExchangePolicyDto,
  UpdateSellerDto,
  UpdateShippingPolicyDto,
  UpdateStoreDto,
} from './dto/commerce.dto';
import { TasaDeComision } from '@/modules/sellers/tasa-de-comision.service';
import type { TasaAplicable } from '@/modules/sellers/comision-por-volumen';

import { OwnershipService } from './ownership.service';
import {
  diasEfectivos,
  resumenParaElComprador,
  validarPolitica,
} from './politicas';

/**
 * Vendedores y tiendas.
 *
 * ─── Convertirse en vendedor es un solo paso ───
 *
 * Crear el Seller crea **también la tienda principal**, en la misma
 * transacción. La alternativa —crear el perfil y después pedir "ahora creá tu
 * tienda"— agrega una pantalla que nadie entiende: para el vendedor, su perfil
 * y su tienda son la misma cosa.
 *
 * Además evita el estado intermedio "vendedor sin tienda", que todo el resto
 * del código tendría que contemplar para siempre.
 */

export class SellerAlreadyExistsError extends DomainError {
  constructor() {
    super('SELLER_EXISTS', 'Ya tenés un perfil de vendedor');
  }
}

export class SlugTakenError extends DomainError {
  constructor(slug: string) {
    super('SLUG_TAKEN', 'Ese nombre de tienda ya está ocupado', { slug });
  }
}

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly tasaDeComision: TasaDeComision,
  ) {}

  /**
   * Convierte un usuario en vendedor.
   *
   * Seller + Store en una transacción: o queda todo o no queda nada. Un
   * vendedor sin tienda sería un estado que hay que contemplar en cada
   * consulta posterior.
   */
  async create(userId: string, dto: CreateSellerDto): Promise<{ seller: Seller; store: Store }> {
    // Interruptor de emergencia: frena el alta, no toca a quien ya vende.
    exigirHabilitada('SELLER_SIGNUP_ENABLED');

    const existente = await this.prisma.seller.findUnique({ where: { userId } });
    if (existente) throw new SellerAlreadyExistsError();

    /**
     * Vender en VendoX es 18+.
     *
     * Es más importante que del lado del comprador: detrás de una tienda hay
     * una cuenta bancaria, retenciones y responsabilidad fiscal. Un menor
     * vendiendo deja obligaciones a nombre de alguien sin capacidad para
     * contraerlas.
     *
     * La fecha es DECLARADA. Ver `users/edad.ts` antes de asumir que está
     * verificada — no lo está.
     */
    const persona = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { birthDate: true },
    });
    exigirMayoriaDeEdad(persona.birthDate, 'vender');

    const slugSeller = dto.slug
      ? await this.verificarSlugLibre(dto.slug)
      : await slugDisponible(dto.displayName, (s) => this.slugSellerLibre(s));

    const nombreTienda = dto.storeName ?? dto.displayName;
    const slugStore = await slugDisponible(nombreTienda, (s) => this.slugStoreLibre(s));

    try {
      const { seller, store } = await this.prisma.$transaction(async (tx) => {
        const seller = await tx.seller.create({
          data: {
            id: newId('sel'),
            userId,
            displayName: dto.displayName,
            slug: slugSeller,
            bio: dto.bio ?? null,
          },
        });

        const store = await tx.store.create({
          data: {
            id: newId('sto'),
            sellerId: seller.id,
            name: nombreTienda,
            slug: slugStore,
            isPrimary: true,
          },
        });

        // El rol del usuario pasa a `seller`. Es lo que le habilita las
        // pantallas de vendedor en la app, y se lee de la base en cada
        // petición — no del token — así que tiene efecto inmediato.
        await tx.user.update({ where: { id: userId }, data: { role: 'seller' } });

        return { seller, store };
      });

      // Los eventos se publican DESPUÉS de cometer. Publicar adentro haría que
      // un suscriptor reaccionara a un vendedor que todavía no existe para
      // nadie más, o peor, a uno cuya transacción se revirtió.
      this.events.publish(DomainEvent.sellerCreated, {
        entityId: seller.id,
        actorId: userId,
        data: { slug: seller.slug, storeId: store.id },
      });
      this.events.publish(DomainEvent.storeCreated, {
        entityId: store.id,
        actorId: userId,
        data: { slug: store.slug, sellerId: seller.id },
      });

      await this.audit.log({
        action: 'seller.created',
        entityType: 'seller',
        entityId: seller.id,
        actorId: userId,
        after: { displayName: seller.displayName, slug: seller.slug },
      });

      return { seller, store };
    } catch (err) {
      // Carrera con otro registro simultáneo: el índice UNIQUE la resuelve y
      // acá sólo se traduce a un mensaje que se entienda.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const campo = (err.meta?.target as string[] | undefined)?.join(',') ?? '';
        if (campo.includes('user_id')) throw new SellerAlreadyExistsError();
        throw new SlugTakenError(slugSeller);
      }
      throw err;
    }
  }

  /** Perfil propio. Se permite aunque esté suspendido: la persona tiene que poder ver qué le pasó. */
  async me(userId: string) {
    const seller = await this.ownership.sellerOf(userId);
    const store = await this.prisma.store.findFirst({
      where: { sellerId: seller.id, isPrimary: true },
    });

    const productos = store
      ? await this.prisma.product.count({ where: { storeId: store.id, deletedAt: null } })
      : 0;

    return { seller: this.publicSeller(seller), store, stats: { productos } };
  }

  async update(userId: string, dto: UpdateSellerDto) {
    const seller = await this.ownership.sellerOf(userId, { requireActive: true });

    const actualizado = await this.prisma.seller.update({
      where: { id: seller.id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
      },
    });

    await this.audit.logDiff({
      action: 'seller.updated',
      entityType: 'seller',
      entityId: seller.id,
      actorId: userId,
      before: { ...seller },
      after: { ...actualizado },
    });
    this.events.publish(DomainEvent.sellerUpdated, { entityId: seller.id, actorId: userId });

    return this.publicSeller(actualizado);
  }

  /**
   * Perfil público de un vendedor.
   *
   * Sólo se muestran los activos. Un vendedor suspendido no puede tener una
   * vidriera pública, y responder 404 evita confirmar que la cuenta existe.
   */
  async publicBySlug(slug: string) {
    const seller = await this.prisma.seller.findFirst({
      where: { slug, status: 'ACTIVE' },
      include: {
        stores: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!seller) throw new DomainError('SELLER_NOT_FOUND', 'Vendedor no encontrado');

    return {
      ...this.publicSeller(seller),
      store: seller.stores[0]
        ? {
            id: seller.stores[0].id,
            name: seller.stores[0].name,
            slug: seller.stores[0].slug,
            description: seller.stores[0].description,
            logoUrl: seller.stores[0].logoUrl,
            coverUrl: seller.stores[0].coverUrl,
          }
        : null,
    };
  }

  // ─── Tiendas ──────────────────────────────────────────────────────────────

  async myStore(userId: string) {
    const { store } = await this.ownership.primaryStoreOf(userId);

    /**
     * Las tasas viajan con la tienda propia.
     *
     * El editor de producto necesita mostrarle al vendedor cuánto se lleva
     * VendoX y cuánto estima que le queda, mientras escribe el precio. Ese
     * cálculo se hace en la app —se recalcula en cada tecla, sin ir al
     * servidor— pero las TASAS no se copian: es la misma decisión que se tomó
     * para la pantalla de políticas, y por el mismo motivo.
     *
     * Escritas a mano en el Dart, el día que cambie la comisión el vendedor
     * seguiría leyendo la vieja. Ya pasó una vez.
     */
    /**
     * ⚠️ La comisión que se devuelve es la de ESTE vendedor, no la de la
     * configuración.
     *
     * Un Business con volumen paga 3 % o 3,5 %, no el 4 % del `.env`. Devolver
     * la tasa general le mostraría al vendedor que más paga un desglose que no
     * es el suyo — y el error saldría a la luz recién al comparar con lo que
     * efectivamente se le cobró, que es la peor manera de descubrirlo.
     */
    const tasa = await this.tasaDeComision.para(store.sellerId);

    return {
      ...store,
      comisionBps: tasa.bps,
      costoDelProcesadorBps: env.PROCESSOR_FEE_ESTIMATE_BPS,
      comision: this.detalleDeLaTasa(tasa),
    };
  }

  /**
   * Lo que la app necesita para explicar la comisión sin recalcularla.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * VIENE ARMADO DEL SERVIDOR, INCLUIDA LA ETIQUETA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `etiqueta` es «Comisión VendoX (4%)» o «Comisión VendoX Business (3,5%)»,
   * ya formateada. Podría armarla Flutter con el plan y los bps, pero eso
   * significaría un `switch` sobre motivos de tasa dentro de la app: dos copias
   * de la misma regla, y la del teléfono desactualizada hasta que alguien
   * publique una versión nueva.
   *
   * `bajoPorVolumen` es un booleano y no una comparación contra 400: la app no
   * tiene que saber cuál es la tasa base para poder decir «tu comisión bajó».
   */
  private detalleDeLaTasa(tasa: TasaAplicable) {
    const porcentaje = (tasa.bps / 100)
      .toFixed(2)
      .replace(/\.?0+$/, '')
      .replace('.', ',');
    const bajoPorVolumen = tasa.motivo === 'VOLUMEN_BUSINESS';

    return {
      bps: tasa.bps,
      etiqueta: `Comisión VendoX${bajoPorVolumen ? ' Business' : ''} (${porcentaje}%)`,
      bajoPorVolumen,
      /**
       * El aviso, cuando hay algo que avisar.
       *
       * `null` en el caso normal: una pantalla que siempre dice algo sobre la
       * comisión convierte el mensaje en decoración, y cuando de verdad haya
       * novedades nadie lo va a leer.
       *
       * ⚠️ En `DEVOLUCIONES_ALTAS` se le dice al vendedor **por qué** no accedió
       * al descuento y qué hacer. Callarlo sería lo peor de los dos mundos:
       * paga más y no sabe que hay algo que puede corregir.
       */
      aviso:
        tasa.motivo === 'VOLUMEN_BUSINESS'
          ? 'Tu comisión bajó por volumen de ventas.'
          : tasa.motivo === 'DEVOLUCIONES_ALTAS'
            ? 'Tenés el volumen para una comisión más baja, pero tu tasa de devoluciones ' +
              'está por encima del límite. Cuando baje, el descuento vuelve solo.'
            : null,
    };
  }

  async updateStore(userId: string, storeId: string, dto: UpdateStoreDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });

    const actualizada = await this.prisma.store.update({
      where: { id: store.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.storefrontEnabled !== undefined
            ? { storefrontEnabled: dto.storefrontEnabled }
            : {}),
      },
    });

    await this.audit.logDiff({
      action: 'store.updated',
      entityType: 'store',
      entityId: store.id,
      actorId: userId,
      before: { ...store },
      after: { ...actualizada },
    });
    this.events.publish(DomainEvent.storeUpdated, { entityId: store.id, actorId: userId });

    return actualizada;
  }

  /**
   * Define cómo cobra el envío esta tienda y quién paga el medio de pago.
   *
   * ─── Por qué no afecta a las órdenes ya creadas ───
   *
   * Cada orden guarda su propia foto (`shippingModeSnapshot`,
   * `processorFeeModeSnapshot`). Cambiar esto hoy no le cambia el total a nadie
   * que ya compró: quien pagó $12.400 con envío incluido tiene que seguir
   * viendo $12.400 con envío incluido para siempre, aunque mañana la tienda
   * pase a retiro únicamente.
   *
   * ─── Por qué se audita entero ───
   *
   * Es el registro de "en esta fecha esta tienda pasó a trasladar el costo del
   * procesador". Si un comprador reclama que le cobraron un recargo que no
   * esperaba, esta es la única forma de reconstruir qué política estaba vigente
   * cuando compró.
   */
  async updateShippingPolicy(userId: string, storeId: string, dto: UpdateShippingPolicyDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });

    const actualizada = await this.prisma.store.update({
      where: { id: store.id },
      data: {
        shippingMode: dto.shippingMode,
        shippingFlatAmount: dto.shippingFlatAmount,
        processorFeeMode: dto.processorFeeMode,
        ...(dto.shippingNote !== undefined ? { shippingNote: dto.shippingNote } : {}),
      },
    });

    await this.audit.logDiff({
      action: 'store.shipping_policy_updated',
      entityType: 'store',
      entityId: store.id,
      actorId: userId,
      before: {
        shippingMode: store.shippingMode,
        shippingFlatAmount: store.shippingFlatAmount,
        shippingNote: store.shippingNote,
        processorFeeMode: store.processorFeeMode,
      },
      after: {
        shippingMode: actualizada.shippingMode,
        shippingFlatAmount: actualizada.shippingFlatAmount,
        shippingNote: actualizada.shippingNote,
        processorFeeMode: actualizada.processorFeeMode,
      },
    });

    // Es el camino del vendedor: acá sí viaja su comisión efectiva.
    return this.politicaDeEnvio(actualizada, await this.tasaDeComision.para(store.sellerId));
  }

  /**
   * La política tal como la ve el vendedor y tal como la ve quien compra.
   *
   * ⚠️ `comisionBps` sólo viaja cuando se pide explícitamente, y sólo se pide
   * desde el camino del vendedor.
   *
   * Antes salía siempre, también en la vidriera pública. Con una comisión única
   * era información sin dueño; con tramos por volumen pasa a decir qué plan
   * tiene cada vendedor y cuánto factura por semana — un comprador podría leer
   * «3 %» y deducir que esa tienda vende más de cinco millones semanales.
   *
   * Eso no es de nadie más que del vendedor.
   */
  private politicaDeEnvio(
    store: {
      shippingMode: ShippingMode;
      shippingFlatAmount: number;
      shippingNote: string | null;
      processorFeeMode: ProcessorFeeMode;
    },
    tasa?: TasaAplicable,
  ) {
    const politica = { modo: store.shippingMode, montoFijo: store.shippingFlatAmount };
    return {
      shippingMode: store.shippingMode,
      shippingFlatAmount: store.shippingFlatAmount,
      shippingNote: store.shippingNote,
      processorFeeMode: store.processorFeeMode,
      // Derivados, para que la app no reimplemente las reglas y se desincronice.
      permiteEnvio: permiteEnvio(store.shippingMode),
      permiteRetiro: permiteRetiro(store.shippingMode),
      etiquetaEnvio: etiquetaDeEnvio(politica, false),
      costoEnvio: costoDeEnvio(politica, false),
      /**
       * ¿Este servidor permite trasladarle al comprador el costo de Mercado
       * Pago?
       *
       * `false` en la beta. La app usa esto para deshabilitar la opción
       * "Sumarlo al total" en vez de ocultarla: el vendedor que ya la tenía
       * elegida tiene que poder ver qué pasó con su configuración, no
       * encontrarse con que desapareció.
       *
       * El valor guardado en `processorFeeMode` no se toca. Vuelve a tener
       * efecto el día que se encienda `BUYER_PROCESSOR_SURCHARGE_ENABLED`.
       */
      recargoAlCompradorDisponible: env.BUYER_PROCESSOR_SURCHARGE_ENABLED,
      /**
       * Las dos tasas que la pantalla de políticas necesita para estimar.
       *
       * Estaban escritas a mano en el Dart —600 y 619, los mismos números que
       * hay acá por omisión— así que el ejemplo daba bien de casualidad. El día
       * que alguien cambie `VENDOX_PLATFORM_FEE_BPS` en el servidor, el
       * vendedor sigue viendo «6 %» y una resta que ya no es la suya, sin que
       * nada falle ni avise.
       *
       * Van derivadas por el mismo motivo que las de arriba: la app no
       * reimplementa reglas.
       *
       * `costoDelProcesadorBps` es una ESTIMACIÓN y la pantalla lo dice. La
       * tasa real la informa Mercado Pago después de cobrar y depende del
       * plazo de acreditación y del medio de pago.
       */
      ...(tasa
        ? {
            comisionBps: tasa.bps,
            costoDelProcesadorBps: env.PROCESSOR_FEE_ESTIMATE_BPS,
            comision: this.detalleDeLaTasa(tasa),
          }
        : {}),
    };
  }


  /**
   * Define qué ofrece la tienda en cambios y devoluciones.
   *
   * ─── El piso legal se valida tres veces, y está bien ───
   *
   * En el esquema de Zod, acá con `validarPolitica`, y en un CHECK de la base.
   * No es redundancia por miedo: cada capa cubre un camino distinto. Zod cubre
   * el endpoint, esto cubre cualquier otro llamador dentro del backend, y el
   * CHECK cubre un UPDATE escrito a mano en una consola de producción.
   *
   * Lo que está en juego no es un dato mal cargado: una tienda que publica
   * "no se aceptan devoluciones" está publicando una cláusula nula, y quien
   * aloja esa publicación responde junto con ella.
   *
   * ─── No afecta a los pedidos ya hechos ───
   *
   * Cada orden se rige por la política vigente cuando se compró. Endurecerla
   * hoy no le saca el derecho a nadie que ya compró — y ampliarla tampoco se lo
   * agrega, porque el vendedor no se comprometió a eso cuando vendió.
   */
  async updateExchangePolicy(userId: string, storeId: string, dto: UpdateExchangePolicyDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });

    const propuesta = {
      modo: dto.exchangeMode,
      diasParaCambiar: dto.exchangeWindowDays,
      quienPagaElEnvio: dto.returnShippingPaidBy,
      nota: dto.exchangeNote ?? null,
    };

    const veredicto = validarPolitica(propuesta);
    if (!veredicto.ok) {
      throw new DomainError('EXCHANGE_POLICY_INVALID', veredicto.motivo);
    }

    const actualizada = await this.prisma.store.update({
      where: { id: store.id },
      data: {
        exchangeMode: dto.exchangeMode,
        exchangeWindowDays: dto.exchangeWindowDays,
        returnShippingPaidBy: dto.returnShippingPaidBy,
        ...(dto.exchangeNote !== undefined ? { exchangeNote: dto.exchangeNote } : {}),
      },
    });

    /**
     * Se audita entero.
     *
     * Es el registro de "en esta fecha esta tienda pasó a ofrecer sólo el
     * mínimo legal". Si un comprador reclama que le prometieron treinta días,
     * esta es la única forma de reconstruir qué decía la publicación cuando
     * compró.
     */
    await this.audit.logDiff({
      action: 'store.exchange_policy_updated',
      entityType: 'store',
      entityId: store.id,
      actorId: userId,
      before: {
        exchangeMode: store.exchangeMode,
        exchangeWindowDays: store.exchangeWindowDays,
        returnShippingPaidBy: store.returnShippingPaidBy,
        exchangeNote: store.exchangeNote,
      },
      after: {
        exchangeMode: actualizada.exchangeMode,
        exchangeWindowDays: actualizada.exchangeWindowDays,
        returnShippingPaidBy: actualizada.returnShippingPaidBy,
        exchangeNote: actualizada.exchangeNote,
      },
    });

    return this.politicaDeCambios(actualizada);
  }

  /**
   * La política tal como la ve el vendedor y tal como la ve quien compra.
   *
   * El texto se arma acá y no en Flutter para que diga exactamente lo mismo en
   * la app, en el detalle del pedido y en el mail. Tres textos escritos por
   * separado terminan diciendo tres cosas distintas, y la que vale legalmente
   * es la más favorable al comprador — o sea, siempre perdemos.
   */
  private politicaDeCambios(store: {
    exchangeMode: ExchangeMode;
    exchangeWindowDays: number;
    returnShippingPaidBy: ReturnShippingPayer;
    exchangeNote: string | null;
  }) {
    const politica = {
      modo: store.exchangeMode,
      diasParaCambiar: store.exchangeWindowDays,
      quienPagaElEnvio: store.returnShippingPaidBy,
      nota: store.exchangeNote,
    };

    return {
      exchangeMode: store.exchangeMode,
      exchangeWindowDays: store.exchangeWindowDays,
      returnShippingPaidBy: store.returnShippingPaidBy,
      exchangeNote: store.exchangeNote,
      /** Los días que valen de verdad, con el piso legal aplicado. */
      diasEfectivos: diasEfectivos(store.exchangeWindowDays),
      /** El texto ya armado, para mostrar sin reescribirlo. */
      resumen: resumenParaElComprador(politica),
    };
  }

  /**
   * Cambia el slug de la tienda.
   *
   * Endpoint aparte del resto de la edición a propósito: cambiar el slug rompe
   * todos los enlaces que la gente ya compartió. Merece una confirmación
   * explícita en la interfaz, y separarlo obliga a que exista.
   */
  async changeStoreSlug(userId: string, storeId: string, dto: ChangeStoreSlugDto) {
    const { store } = await this.ownership.storeOf(userId, storeId, { requireActive: true });
    if (store.slug === dto.slug) return store;

    if (!(await this.slugStoreLibre(dto.slug))) throw new SlugTakenError(dto.slug);

    try {
      const actualizada = await this.prisma.store.update({
        where: { id: store.id },
        data: { slug: dto.slug },
      });
      await this.audit.log({
        action: 'store.slug_changed',
        entityType: 'store',
        entityId: store.id,
        actorId: userId,
        before: { slug: store.slug },
        after: { slug: dto.slug },
      });
      return actualizada;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new SlugTakenError(dto.slug);
      }
      throw err;
    }
  }

  /** Vidriera pública de una tienda. */
  /**
   * La tienda que corresponde a un slug.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ES LO QUE ABRE `vendox.com.ar/t/<slug>`
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Los enlaces que se comparten llevan el slug, porque un slug se lee y un id
   * no. El catálogo y el horario, en cambio, resuelven por id. Acá se traduce.
   *
   * ⚠️ Y NO ES SÓLO UNA TRADUCCIÓN: se decide **si esa tienda se puede
   * mostrar**. Tienda ACTIVE y vendedor ACTIVE. Si la app resolviera el slug
   * por su cuenta, bastaría con tener un enlace guardado para seguir viendo
   * —y comprando— lo de alguien suspendido.
   */
  async storeBySlug(slug: string) {
    const store = await this.prisma.store.findFirst({
      where: { slug, status: 'ACTIVE', seller: { status: 'ACTIVE' } },
      include: { seller: true },
    });
    if (!store) throw new DomainError('STORE_NOT_FOUND', 'Tienda no encontrada');

    /**
     * Si el vendedor está transmitiendo AHORA.
     *
     * Va en esta misma respuesta y no en un pedido aparte: quien llega por un
     * enlace compartido no sabe si hay alguien mostrando esto en este momento,
     * y es lo primero que le sirve saber. Pedirlo por separado serían dos
     * viajes a otro continente para dibujar una sola pantalla.
     *
     * `null` cuando no transmite, y la app no muestra «EN VIVO» sin esto: un
     * aviso de transmisión sobre alguien offline manda a la persona a buscar
     * algo que no existe.
     */
    const vivo = await this.prisma.liveSession.findFirst({
      where: { sellerId: store.sellerId, state: { in: ['LIVE', 'RECONNECTING'] } },
      select: { id: true, title: true },
    });

    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      description: store.description,
      logoUrl: store.logoUrl,
      coverUrl: store.coverUrl,
      seller: this.publicSeller(store.seller),
      enVivo: vivo ? { id: vivo.id, titulo: vivo.title } : null,
      // Quien mira la vidriera tiene que saber cuánto sale el envío ANTES de
      // llegar al checkout. Enterarse del costo con la tarjeta en la mano es la
      // razón número uno por la que alguien abandona una compra.
      envio: this.politicaDeEnvio(store),
      // Cambios y devoluciones antes de comprar. El derecho de arrepentimiento
      // va SIEMPRE, elija lo que elija el vendedor.
      cambios: this.politicaDeCambios(store),
    };
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async verificarSlugLibre(slug: string): Promise<string> {
    if (!(await this.slugSellerLibre(slug))) throw new SlugTakenError(slug);
    return slug;
  }

  private async slugSellerLibre(slug: string): Promise<boolean> {
    return (await this.prisma.seller.count({ where: { slug } })) === 0;
  }

  private async slugStoreLibre(slug: string): Promise<boolean> {
    return (await this.prisma.store.count({ where: { slug } })) === 0;
  }

  /**
   * Proyección pública.
   *
   * Se enumeran los campos que salen en vez de borrar los que no. Con un
   * `delete seller.userId`, agregar una columna sensible a la tabla la expone
   * sin que nadie lo note.
   */
  private publicSeller(seller: Seller) {
    return {
      id: seller.id,
      displayName: seller.displayName,
      slug: seller.slug,
      bio: seller.bio,
      avatarUrl: seller.avatarUrl,
      coverUrl: seller.coverUrl,
      status: seller.status,
      verificationStatus: seller.verificationStatus,
      createdAt: seller.createdAt,
    };
  }
}

/** Slug propuesto por el vendedor, ya validado por el DTO. */
export type { CreateSellerDto };
