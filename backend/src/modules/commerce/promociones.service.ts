import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  DuracionEnHoras,
  POSICIONES_PROMOCIONADAS,
  SinCreditosError,
  TipoDePromocion,
  costoDe,
  exigirDuracionValida,
} from './promociones';

/**
 * Promociones: comprarlas, cancelarlas y consultarlas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL SALDO SE CALCULA, NO SE GUARDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No hay una columna `creditos` en `Seller`. El saldo es la suma del libro
 * mayor, y eso hace imposible el peor error posible acá: un saldo que quedó mal
 * por un `UPDATE` a medias y que nadie puede reconstruir.
 *
 * Cobrar es insertar una fila negativa. Se hace dentro de la misma transacción
 * que crea la promoción, con el saldo releído **adentro** —ver `comprar`—, así
 * que dos compras simultáneas no pueden gastar los mismos créditos.
 */

@Injectable()
export class PromocionesService {
  private readonly logger = new Logger(PromocionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async vendedorDe(userId: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'Todavía no sos vendedor');
    return vendedor.id;
  }

  /** El saldo, sumando el libro mayor. */
  async saldoDe(sellerId: string): Promise<number> {
    const { _sum } = await this.prisma.promotionCredit.aggregate({
      where: { sellerId },
      _sum: { delta: true },
    });
    return _sum.delta ?? 0;
  }

  /**
   * Lo que ve el vendedor: su saldo, sus promociones y cuánto sale cada opción.
   *
   * ⚠️ El costo viaja en CRÉDITOS. No hay un precio en pesos en ningún lado —la
   * conversión es una decisión comercial que todavía no está tomada, y mostrar
   * un número que después cambia es peor que no mostrar ninguno.
   */
  async panel(userId: string) {
    const sellerId = await this.vendedorDe(userId);
    const ahora = new Date();

    const [saldo, promociones] = await Promise.all([
      this.saldoDe(sellerId),
      this.prisma.promotion.findMany({
        where: { sellerId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      saldoEnCreditos: saldo,
      /** Cuántos lugares del feed son promocionados. Se dice, no se esconde. */
      posicionesPorPagina: POSICIONES_PROMOCIONADAS.length,
      promociones: promociones.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        targetId: p.targetId,
        desde: p.desde,
        hasta: p.hasta,
        creditos: p.creditos,
        cancelada: p.cancelada,
        corriendo:
          !p.cancelada && ahora >= p.desde && ahora < p.hasta,
      })),
    };
  }

  /**
   * Compra una promoción.
   *
   * El objetivo tiene que ser **del vendedor**: la pertenencia va en el `where`
   * de la consulta que lo busca, no en un `if` posterior. Promocionar el
   * producto de otro le daría visibilidad a alguien que no la pidió y le
   * cobraría los créditos a quien no corresponde.
   */
  async comprar(
    userId: string,
    datos: { tipo: TipoDePromocion; targetId: string; horas: number },
  ) {
    const sellerId = await this.vendedorDe(userId);
    exigirDuracionValida(datos.horas);
    const horas: DuracionEnHoras = datos.horas;

    await this.exigirObjetivoPropio(sellerId, datos.tipo, datos.targetId);

    const creditos = costoDe(datos.tipo, horas);
    const desde = new Date();
    const hasta = new Date(desde.getTime() + horas * 3_600_000);
    const promotionId = newId('pro');

    await this.prisma.$transaction(async (tx) => {
      /**
       * El saldo se relee ACÁ ADENTRO.
       *
       * Leerlo antes de la transacción y confiar en ese número es la carrera
       * clásica: dos compras simultáneas ven el mismo saldo y las dos pasan.
       */
      const { _sum } = await tx.promotionCredit.aggregate({
        where: { sellerId },
        _sum: { delta: true },
      });
      const saldo = _sum.delta ?? 0;

      if (saldo < creditos) throw new SinCreditosError(creditos, saldo);

      await tx.promotion.create({
        data: { id: promotionId, sellerId, tipo: datos.tipo, targetId: datos.targetId, desde, hasta, creditos },
      });

      // El gasto, como fila negativa del libro mayor.
      await tx.promotionCredit.create({
        data: {
          id: newId('pcr'),
          sellerId,
          delta: -creditos,
          motivo: `Promoción ${datos.tipo} por ${horas} h`,
          promotionId,
        },
      });
    });

    await this.audit.log({
      action: 'promotion.purchased',
      entityType: 'promotion',
      entityId: promotionId,
      actorId: userId,
      after: { tipo: datos.tipo, targetId: datos.targetId, horas, creditos },
    });

    return { id: promotionId, tipo: datos.tipo, desde, hasta, creditos };
  }

  /**
   * Cancela una promoción en curso.
   *
   * ⚠️ **No devuelve créditos.** Ya se mostró: el vendedor consumió parte de lo
   * que compró y no hay forma honesta de calcular cuánto. Devolver el total
   * sería regalar la exposición que ya tuvo; devolver una parte proporcional
   * sería inventar una cuenta que nadie pactó.
   *
   * Sirve para sacar del feed algo que el vendedor ya no quiere mostrar —un
   * producto que se le agotó, por ejemplo—.
   */
  async cancelar(userId: string, promotionId: string) {
    const sellerId = await this.vendedorDe(userId);

    // La pertenencia va en el WHERE: una promoción ajena no se encuentra.
    const { count } = await this.prisma.promotion.updateMany({
      where: { id: promotionId, sellerId, cancelada: false },
      data: { cancelada: true, canceladaEl: new Date() },
    });
    if (count === 0) throw new DomainError('NOT_FOUND', 'No existe esa promoción');

    await this.audit.log({
      action: 'promotion.cancelled',
      entityType: 'promotion',
      entityId: promotionId,
      actorId: userId,
      after: {},
    });

    return { id: promotionId, cancelada: true };
  }

  /**
   * Otorga créditos. Sólo desde el panel de administración.
   *
   * No hay compra de créditos en la app: igual que con VendoX Pro, el cobro
   * está desacoplado. El día que exista, va a llamar a esto.
   */
  async otorgarCreditos(
    sellerId: string,
    cantidad: number,
    motivo: string,
    otorgadoPor: string,
  ) {
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new DomainError('VALIDATION_FAILED', 'La cantidad tiene que ser un entero positivo');
    }

    const vendedor = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'No existe ese vendedor');

    await this.prisma.promotionCredit.create({
      data: { id: newId('pcr'), sellerId, delta: cantidad, motivo, otorgadoPor },
    });

    /**
     * ⚠️ Se audita SIEMPRE. Es la función que regala exposición, y sin registro
     * un crédito de cortesía es indistinguible de uno puesto por error.
     */
    await this.audit.log({
      action: 'promotion.credits_granted',
      entityType: 'seller',
      entityId: sellerId,
      actorId: otorgadoPor,
      after: { cantidad, motivo, saldo: await this.saldoDe(sellerId) },
    });

    return { sellerId, saldoEnCreditos: await this.saldoDe(sellerId) };
  }

  /**
   * Los productos promocionados que corren ahora, en orden de compra.
   *
   * Devuelve ids: quien arma el feed ya tiene la consulta de productos y no
   * conviene duplicarla acá. Ver `products.service.ts`.
   */
  async productosPromocionadosAhora(limite = 20): Promise<string[]> {
    const ahora = new Date();
    const filas = await this.prisma.promotion.findMany({
      where: {
        tipo: 'PRODUCTO_EN_FEED',
        cancelada: false,
        desde: { lte: ahora },
        hasta: { gt: ahora },
      },
      // El más viejo primero: quien compró antes ocupa el mejor lugar. Es la
      // regla más simple de explicar y la única que no se puede manipular
      // pagando más.
      orderBy: { createdAt: 'asc' },
      take: limite,
      select: { targetId: true },
    });

    return filas.map((f) => f.targetId);
  }

  /** El objetivo tiene que ser del vendedor y estar vendible. */
  private async exigirObjetivoPropio(
    sellerId: string,
    tipo: TipoDePromocion,
    targetId: string,
  ): Promise<void> {
    if (tipo === 'PRODUCTO_EN_FEED') {
      const producto = await this.prisma.product.findFirst({
        where: {
          id: targetId,
          store: { sellerId },
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { id: true },
      });
      /**
       * Pausado o borrador tampoco: promocionar algo que no se puede comprar es
       * cobrarle al vendedor por mandar gente a una pantalla sin botón.
       */
      if (!producto) throw new DomainError('PRODUCT_NOT_FOUND', 'Ese producto no se puede promocionar');
      return;
    }

    const vivo = await this.prisma.liveSession.findFirst({
      where: { id: targetId, sellerId },
      select: { id: true },
    });
    if (!vivo) throw new DomainError('SESSION_NOT_FOUND', 'Ese vivo no se puede promocionar');
  }
}
