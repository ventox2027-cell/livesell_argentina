import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { MembresiasService } from '@/modules/sellers/membresias.service';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  CuponInvalidoError,
  DatosDelCupon,
  MENSAJE_DE_RECHAZO,
  calcularDescuento,
  exigirCuponValido,
  motivoDeRechazo,
  normalizarCodigo,
} from './cupones';

/**
 * Cupones: crearlos, listarlos y canjearlos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL LÍMITE DE USOS SE DECIDE EN LA BASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Quedan 3 usos» leído y después incrementado es la carrera clásica: cuatro
 * personas leen 3 al mismo tiempo, las cuatro escriben 4, y el cupón de 3 usos
 * se usó cuatro veces. En un vivo, donde cien personas escriben el mismo código
 * en el mismo minuto, no es una posibilidad teórica.
 *
 * Acá el cupo se toma con un **UPDATE condicional**: la condición viaja adentro
 * del `WHERE` y la base decide. Si actualizó cero filas, no había cupo. Es la
 * misma disciplina que las reservas de stock.
 *
 * Y una restricción única por (cupón, comprador) impide que la misma persona lo
 * use dos veces, por la misma razón: dos pedidos simultáneos pasarían los dos
 * por cualquier comprobación previa.
 */

export class SinCuponError extends DomainError {
  constructor(mensaje: string, motivo: string) {
    super('COUPON_NOT_APPLICABLE', mensaje, { motivo });
  }
}

/** Lo que se guarda en la orden cuando el cupón se aplicó. */
export interface CuponAplicado {
  couponId: string;
  codigo: string;
  descuentoCentavos: number;
}

@Injectable()
export class CuponesService {
  private readonly logger = new Logger(CuponesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly membresias: MembresiasService,
  ) {}

  private async vendedorDe(userId: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'Todavía no sos vendedor');
    return vendedor.id;
  }

  /**
   * Crea un cupón.
   *
   * Es función de VendoX Pro. La comprobación va acá y no en un decorador de la
   * ruta: no es un permiso de acceso, es una regla de negocio, y tiene que
   * valer también si mañana otro servicio crea cupones.
   */
  async crear(userId: string, datos: DatosDelCupon) {
    const sellerId = await this.vendedorDe(userId);
    await this.membresias.exigirBeneficio(sellerId, 'CUPONES');

    exigirCuponValido(datos);
    const codigo = normalizarCodigo(datos.codigo);

    // El tope del plan. `cuponesActivos` es cuántos puede tener a la vez, no
    // cuántos puede crear en total: los pausados no ocupan lugar.
    const limites = await this.membresias.limitesDe(sellerId);
    const activos = await this.prisma.coupon.count({
      where: { sellerId, activo: true, deletedAt: null },
    });
    if (activos >= limites.cuponesActivos) {
      throw new DomainError(
        'PLAN_LIMIT_REACHED',
        `Tu plan permite ${limites.cuponesActivos} cupones activos a la vez`,
        { limite: limites.cuponesActivos, activos },
      );
    }

    /**
     * El código repetido se detecta por la restricción única, no consultando
     * antes: entre el `SELECT` y el `INSERT` cabe otro pedido del mismo
     * vendedor con el mismo código.
     */
    try {
      const cupon = await this.prisma.coupon.create({
        data: {
          id: newId('cup'),
          sellerId,
          codigo,
          tipo: datos.tipo,
          valor: datos.valor,
          minimoCentavos: datos.minimoCentavos ?? null,
          topeCentavos: datos.topeCentavos ?? null,
          desde: datos.desde ?? null,
          hasta: datos.hasta ?? null,
          usosMaximos: datos.usosMaximos ?? null,
        },
      });

      await this.audit.log({
        action: 'coupon.created',
        entityType: 'coupon',
        entityId: cupon.id,
        actorId: userId,
        after: {
          codigo,
          tipo: datos.tipo,
          valor: datos.valor,
          minimoCentavos: datos.minimoCentavos ?? null,
          topeCentavos: datos.topeCentavos ?? null,
          usosMaximos: datos.usosMaximos ?? null,
        },
      });

      return this.vista(cupon);
    } catch (e) {
      if (esCodigoRepetido(e)) {
        throw new CuponInvalidoError('Ya tenés un cupón con ese código');
      }
      throw e;
    }
  }

  /** Los cupones del vendedor, con cuántas veces se usó cada uno. */
  async mios(userId: string) {
    const sellerId = await this.vendedorDe(userId);
    const cupones = await this.prisma.coupon.findMany({
      where: { sellerId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return cupones.map((c) => this.vista(c));
  }

  /** Pausa o reactiva. No borra: el historial de canjes tiene que seguir. */
  async alternar(userId: string, couponId: string, activo: boolean) {
    const sellerId = await this.vendedorDe(userId);

    // La pertenencia va en el WHERE. Un cupón ajeno simplemente no se
    // encuentra, y el 404 sale solo.
    const { count } = await this.prisma.coupon.updateMany({
      where: { id: couponId, sellerId, deletedAt: null },
      data: { activo },
    });
    if (count === 0) throw new DomainError('NOT_FOUND', 'No existe ese cupón');

    await this.audit.log({
      action: activo ? 'coupon.enabled' : 'coupon.paused',
      entityType: 'coupon',
      entityId: couponId,
      actorId: userId,
      after: { activo },
    });

    return { id: couponId, activo };
  }

  /** Lo archiva. Sigue en la base para que los canjes apunten a algo. */
  async borrar(userId: string, couponId: string) {
    const sellerId = await this.vendedorDe(userId);

    const { count } = await this.prisma.coupon.updateMany({
      where: { id: couponId, sellerId, deletedAt: null },
      data: { activo: false, deletedAt: new Date() },
    });
    if (count === 0) throw new DomainError('NOT_FOUND', 'No existe ese cupón');

    await this.audit.log({
      action: 'coupon.deleted',
      entityType: 'coupon',
      entityId: couponId,
      actorId: userId,
      after: {},
    });

    return { ok: true as const };
  }

  /**
   * Lo que ve el comprador antes de pagar.
   *
   * ⚠️ Esto **no reserva nada**. Entre esta consulta y el pedido, el último uso
   * del cupón se lo puede llevar otro. Es información, no una promesa — igual
   * que el stock disponible.
   *
   * Devuelve el motivo del rechazo y no un `false`: «no se puede usar» hace que
   * la persona lo intente tres veces más; «venció el 10 de agosto» hace que
   * deje de intentar y compre igual.
   */
  async probar(userId: string, sellerId: string, codigo: string, subtotalCentavos: number) {
    const cupon = await this.buscar(sellerId, codigo);

    if (!cupon) {
      return { aplica: false as const, motivo: MENSAJE_DE_RECHAZO.NO_EXISTE };
    }

    const rechazo = motivoDeRechazo(cupon, subtotalCentavos);
    if (rechazo) return { aplica: false as const, motivo: MENSAJE_DE_RECHAZO[rechazo] };

    // El «ya lo usaste» necesita una consulta más, así que va después de todo
    // lo que se resuelve sin tocar la base.
    const yaLoUso = await this.prisma.couponRedemption.findUnique({
      where: { couponId_userId: { couponId: cupon.id, userId } },
      select: { id: true },
    });
    if (yaLoUso) {
      return { aplica: false as const, motivo: MENSAJE_DE_RECHAZO.YA_LO_USASTE };
    }

    return {
      aplica: true as const,
      codigo: cupon.codigo,
      descuentoCentavos: calcularDescuento(cupon, subtotalCentavos),
    };
  }

  /**
   * Toma el cupo del cupón y calcula el descuento.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * SE USA EN DOS PASOS, DENTRO DE LA MISMA TRANSACCIÓN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *   1. `tomarCupo` — antes de crear la orden, porque el descuento entra en el
   *      cálculo del total.
   *   2. `registrarCanje` — después, porque la fila apunta a la orden por clave
   *      foránea y la orden todavía no existe en el paso 1.
   *
   * Los dos van adentro de la transacción que crea la orden: si algo falla en
   * el medio, el cupo vuelve solo porque se deshace todo junto.
   *
   * Lanza cuando el cupón no se puede usar, en vez de ignorarlo y cobrar el
   * precio entero en silencio. Alguien que escribió un código espera ese
   * descuento; enterarse después de que se lo cobraron completo es peor que un
   * error claro antes de pagar.
   */
  async tomarCupo(
    tx: Prisma.TransactionClient,
    datos: {
      userId: string;
      sellerId: string;
      codigo: string;
      subtotalCentavos: number;
    },
  ): Promise<CuponAplicado> {
    const codigo = normalizarCodigo(datos.codigo);

    const cupon = await tx.coupon.findUnique({
      where: { sellerId_codigo: { sellerId: datos.sellerId, codigo } },
    });

    /**
     * ⚠️ La pertenencia al vendedor va en la consulta.
     *
     * Sin eso, alguien podría usar el «VERANO25» de una tienda grande en la
     * compra de otra. El cupón lo paga el vendedor: cobrárselo a quien no lo
     * creó es sacarle plata.
     */
    if (!cupon || cupon.deletedAt) {
      throw new SinCuponError(MENSAJE_DE_RECHAZO.NO_EXISTE, 'NO_EXISTE');
    }

    const rechazo = motivoDeRechazo(cupon, datos.subtotalCentavos);
    if (rechazo) throw new SinCuponError(MENSAJE_DE_RECHAZO[rechazo], rechazo);

    const descuentoCentavos = calcularDescuento(cupon, datos.subtotalCentavos);
    if (descuentoCentavos <= 0) {
      // Con un subtotal por debajo del resto mínimo el recorte da cero. No es
      // un error del comprador, pero tampoco se puede aplicar.
      throw new SinCuponError('Tu compra es muy chica para este cupón', 'NO_LLEGA_AL_MINIMO');
    }

    /**
     * El cupo, con un UPDATE condicional.
     *
     * `usos: { increment: 1 }` con `usos: { lt: usosMaximos }` en el WHERE: la
     * base lee y escribe en la misma operación, así que dos pedidos simultáneos
     * no pueden pasar los dos. Si actualizó cero filas, se agotó en el medio.
     */
    if (cupon.usosMaximos != null) {
      const { count } = await tx.coupon.updateMany({
        where: { id: cupon.id, usos: { lt: cupon.usosMaximos } },
        data: { usos: { increment: 1 } },
      });
      if (count === 0) throw new SinCuponError(MENSAJE_DE_RECHAZO.AGOTADO, 'AGOTADO');
    } else {
      await tx.coupon.update({ where: { id: cupon.id }, data: { usos: { increment: 1 } } });
    }

    return { couponId: cupon.id, codigo: cupon.codigo, descuentoCentavos };
  }

  /**
   * Registra que esta orden usó este cupón.
   *
   * ⚠️ La restricción única por (cupón, comprador) es lo que impide que la
   * misma persona lo use dos veces. Acá no hay `if` que valga: dos pedidos
   * simultáneos pasarían los dos por cualquier comprobación previa, y por eso
   * lo decide la base.
   *
   * Que falle acá deshace la transacción entera —orden incluida—, que es
   * exactamente lo que corresponde: la orden se estaba creando con un descuento
   * al que esa persona no tenía derecho.
   */
  async registrarCanje(
    tx: Prisma.TransactionClient,
    datos: { cupon: CuponAplicado; userId: string; orderId: string },
  ): Promise<void> {
    try {
      await tx.couponRedemption.create({
        data: {
          id: newId('cur'),
          couponId: datos.cupon.couponId,
          userId: datos.userId,
          orderId: datos.orderId,
          descuentoCentavos: datos.cupon.descuentoCentavos,
        },
      });
    } catch (e) {
      if (esCodigoRepetido(e)) {
        throw new SinCuponError(MENSAJE_DE_RECHAZO.YA_LO_USASTE, 'YA_LO_USASTE');
      }
      throw e;
    }
  }

  private async buscar(sellerId: string, codigo: string) {
    return this.prisma.coupon.findFirst({
      where: { sellerId, codigo: normalizarCodigo(codigo), deletedAt: null },
    });
  }

  /** Lo que se le muestra al vendedor. */
  private vista(c: {
    id: string;
    codigo: string;
    tipo: string;
    valor: number;
    minimoCentavos: number | null;
    topeCentavos: number | null;
    desde: Date | null;
    hasta: Date | null;
    usosMaximos: number | null;
    usos: number;
    activo: boolean;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      codigo: c.codigo,
      tipo: c.tipo,
      valor: c.valor,
      minimoCentavos: c.minimoCentavos,
      topeCentavos: c.topeCentavos,
      desde: c.desde,
      hasta: c.hasta,
      usosMaximos: c.usosMaximos,
      usos: c.usos,
      /** Cuántos quedan. `null` cuando es ilimitado: no se inventa un número. */
      usosRestantes: c.usosMaximos == null ? null : Math.max(0, c.usosMaximos - c.usos),
      activo: c.activo,
      createdAt: c.createdAt,
    };
  }
}

/** El error de Prisma cuando choca una restricción única. */
function esCodigoRepetido(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
