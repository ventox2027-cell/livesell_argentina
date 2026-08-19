import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { evaluarRiesgo, type NivelDeRiesgo, type SenalesDeRiesgo } from './risk.rules';
import { ventasConfirmadasDe } from './volumen';

/**
 * Mide las señales y aplica las reglas.
 *
 * La separación con `risk.rules.ts` es deliberada: allá están las decisiones y
 * son puras; acá están las consultas y no deciden nada. Probar "qué pasa con un
 * vendedor que tiene tres devoluciones y el documento duplicado" no requiere
 * montar ese vendedor en PostgreSQL.
 */

const DIA_MS = 86_400_000;

/**
 * Qué puede hacer un vendedor según su riesgo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LÍMITES, NO BLOQUEOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un vendedor en riesgo alto **puede vender**. Con techo, pero puede.
 *
 * La alternativa —frenar automáticamente por señales indirectas— dejaría sin
 * trabajar a gente honesta por haber cambiado de teléfono o por vender mucho en
 * un vivo que salió bien. El costo de un falso positivo acá es que alguien no
 * pueda facturar, y eso es grave.
 *
 * Lo que frena de verdad es una decisión humana: suspender o bloquear. El
 * riesgo alto sirve para poner el caso arriba en el panel, no para reemplazar
 * el criterio de alguien.
 *
 * ─── Configurables, no repartidos por el código ───
 *
 * Los números viven acá y se pueden ajustar por variable de entorno. Un
 * `if (ordenes > 10)` dentro del servicio de órdenes sería imposible de cambiar
 * sin desplegar, e imposible de encontrar cuando alguien pregunte por qué a un
 * vendedor le rebotó una venta.
 */
export interface LimitesDeVendedor {
  /** Órdenes que puede recibir por día. `null` = sin techo. */
  ordenesPorDia: number | null;
  /** Cuánto puede facturar por día, en centavos. `null` = sin techo. */
  brutoDiarioCentavos: number | null;
  /** Si necesita revisión antes de que sus productos se publiquen. */
  requiereRevision: boolean;
}

function limitesPorDefecto(): Record<NivelDeRiesgo, LimitesDeVendedor> {
  return {
    LOW: {
      ordenesPorDia: null,
      brutoDiarioCentavos: null,
      requiereRevision: false,
    },
    MEDIUM: {
      ordenesPorDia: env.SELLER_LIMIT_MEDIUM_ORDERS_PER_DAY,
      brutoDiarioCentavos: env.SELLER_LIMIT_MEDIUM_GMV_PER_DAY,
      requiereRevision: false,
    },
    HIGH: {
      ordenesPorDia: env.SELLER_LIMIT_HIGH_ORDERS_PER_DAY,
      brutoDiarioCentavos: env.SELLER_LIMIT_HIGH_GMV_PER_DAY,
      requiereRevision: true,
    },
  };
}

@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mide las señales de un vendedor y guarda el veredicto.
   *
   * ─── Cuándo se llama ───
   *
   * Cuando cambia algo que lo afecta: se envía o resuelve una verificación, se
   * conecta una cuenta de cobro, se suspende, se cambia un dato crítico. No en
   * cada lectura: son ocho consultas, y hacerlas por fila en un listado de
   * veinte vendedores serían ciento sesenta.
   *
   * **Nunca lanza.** El riesgo es información para decidir, no una invariante:
   * que falle recalcularlo no puede tumbar la operación que lo disparó — que
   * suele ser algo más importante, como aprobar una verificación.
   */
  async recalcular(sellerId: string): Promise<{ nivel: NivelDeRiesgo; motivos: string[] } | null> {
    try {
      const senales = await this.medir(sellerId);
      if (!senales) return null;

      const veredicto = evaluarRiesgo(senales);

      await this.prisma.seller.update({
        where: { id: sellerId },
        data: {
          riskLevel: veredicto.nivel,
          riskReasons: veredicto.motivos,
          riskComputedAt: new Date(),
        },
      });

      return veredicto;
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo recalcular el riesgo',
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async medir(sellerId: string): Promise<SenalesDeRiesgo | null> {
    const vendedor = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      include: { user: true, verification: true, paymentAccounts: true },
    });
    if (!vendedor) return null;

    const ahora = Date.now();
    const hace30 = new Date(ahora - 30 * DIA_MS);
    const hace7 = new Date(ahora - 7 * DIA_MS);
    const hace14 = new Date(ahora - 14 * DIA_MS);

    const [
      ordenesCompletadas,
      cancelacionesRecientes,
      devolucionesRecientes,
      suspensionesHistoricas,
      cambiosCriticosRecientes,
      brutoUltimaSemana,
      brutoSemanaAnterior,
      documentoDuplicado,
    ] = await Promise.all([
      /**
       * Qué cuenta como venta lo decide `volumen.ts`. Antes esta lista estaba
       * escrita a mano acá y otra igual en `admin.service.ts`, sin que nada
       * garantizara que siguieran coincidiendo.
       */
      this.prisma.order.count({ where: ventasConfirmadasDe(sellerId) }),
      this.prisma.order.count({
        where: { sellerId, status: 'CANCELLED', cancelledAt: { gte: hace30 } },
      }),
      this.prisma.refund.count({
        where: { order: { sellerId }, createdAt: { gte: hace30 } },
      }),
      /**
       * Las suspensiones salen de la BITÁCORA, no de un contador.
       *
       * No hay columna `vecesSuspendido` a propósito: un contador se
       * desincroniza en cuanto alguien corrige un estado a mano, y además no
       * dice cuándo ni por qué. La bitácora es append-only y ya tiene toda esa
       * información — el contador sería una segunda verdad peor.
       */
      this.prisma.auditLog.count({
        where: { entityType: 'seller', entityId: sellerId, action: 'admin.seller_suspended' },
      }),
      this.prisma.auditLog.count({
        where: {
          entityType: 'seller',
          entityId: sellerId,
          action: { in: CAMBIOS_CRITICOS },
          createdAt: { gte: hace7 },
        },
      }),
      this.prisma.order.aggregate({
        where: { sellerId, status: { notIn: ['CANCELLED', 'EXPIRED'] }, createdAt: { gte: hace7 } },
        _sum: { grossAmount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          sellerId,
          status: { notIn: ['CANCELLED', 'EXPIRED'] },
          createdAt: { gte: hace14, lt: hace7 },
        },
        _sum: { grossAmount: true },
      }),
      vendedor.verification?.docNumberHash
        ? this.prisma.sellerVerification.count({
            where: {
              docNumberHash: vendedor.verification.docNumberHash,
              sellerId: { not: sellerId },
            },
          })
        : Promise.resolve(0),
    ]);

    const semanaActual = brutoUltimaSemana._sum.grossAmount ?? 0;
    const semanaPrevia = brutoSemanaAnterior._sum.grossAmount ?? 0;

    /**
     * El multiplicador de crecimiento es `null` cuando no hay con qué comparar.
     *
     * Si la semana anterior fue cero, cualquier venta sería "infinitas veces
     * más" y todo vendedor nuevo dispararía la alerta de crecimiento anormal en
     * su primera venta. `null` significa "no se puede saber", y la regla no
     * aplica — que es distinto de "no creció".
     */
    const multiplicadorDeCrecimiento =
      semanaPrevia > 0 ? semanaActual / semanaPrevia : null;

    return {
      identidadVerificada: vendedor.verificationStatus === 'VERIFIED',
      telefonoVerificado: vendedor.user.phoneVerified,
      cuentaDeCobroConectada: vendedor.paymentAccounts.some((c) => c.status === 'CONNECTED'),
      antiguedadDias: Math.floor((ahora - vendedor.createdAt.getTime()) / DIA_MS),
      ordenesCompletadas,
      cancelacionesRecientes,
      devolucionesRecientes,
      suspensionesHistoricas,
      cambiosCriticosRecientes,
      multiplicadorDeCrecimiento,
      documentoDuplicado: documentoDuplicado > 0,
    };
  }

  /** Los límites vigentes de un vendedor. */
  async limitesDe(sellerId: string): Promise<LimitesDeVendedor & { nivel: NivelDeRiesgo }> {
    const v = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { riskLevel: true },
    });

    const nivel = v?.riskLevel ?? 'MEDIUM';
    return { nivel, ...limitesPorDefecto()[nivel] };
  }

  /**
   * ¿Este vendedor puede recibir una orden más hoy?
   *
   * Lo consulta el módulo de órdenes antes de crear una. Devuelve el motivo en
   * vez de un booleano: el comprador tiene que ver algo mejor que "no se pudo".
   */
  async puedeRecibirOrden(
    sellerId: string,
    montoCentavos: number,
  ): Promise<{ permitido: true } | { permitido: false; motivo: string }> {
    const limites = await this.limitesDe(sellerId);

    if (limites.ordenesPorDia === null && limites.brutoDiarioCentavos === null) {
      return { permitido: true };
    }

    const desdeMedianoche = new Date();
    desdeMedianoche.setHours(0, 0, 0, 0);

    const hoy = await this.prisma.order.aggregate({
      where: {
        sellerId,
        createdAt: { gte: desdeMedianoche },
        status: { notIn: ['CANCELLED', 'EXPIRED'] },
      },
      _count: true,
      _sum: { grossAmount: true },
    });

    if (limites.ordenesPorDia !== null && hoy._count >= limites.ordenesPorDia) {
      return {
        permitido: false,
        motivo: 'Este vendedor alcanzó su límite de ventas por hoy. Probá mañana.',
      };
    }

    const brutoHoy = hoy._sum.grossAmount ?? 0;
    if (
      limites.brutoDiarioCentavos !== null &&
      brutoHoy + montoCentavos > limites.brutoDiarioCentavos
    ) {
      return {
        permitido: false,
        motivo: 'Este vendedor alcanzó su límite de monto por hoy. Probá mañana.',
      };
    }

    return { permitido: true };
  }
}

/**
 * Qué cuenta como cambio crítico.
 *
 * Cambiar el teléfono principal o la cuenta donde entra la plata **invalida la
 * confianza previa**: el patrón de una cuenta comprada o robada es exactamente
 * ese — entrar y cambiar dónde se cobra.
 *
 * ⚠️ **`seller.verification_submitted` NO está en esta lista**, y estuvo.
 *
 * Enviar los datos por primera vez no es cambiar nada: es el acto de
 * verificarse. Con ese evento adentro, el primer envío disparaba
 * `cambio_critico_reciente` y dejaba al vendedor en riesgo ALTO — o sea que
 * intentar verificarse empeoraba su situación durante una semana. Exactamente
 * al revés de lo que el sistema debería incentivar.
 *
 * Lo encontró un test de integración: un vendedor nuevo que envía su
 * verificación debía quedar en riesgo medio y quedaba en alto.
 *
 * Reenviar tras un rechazo tampoco cuenta: la persona está corrigiendo un dato
 * mal tipeado. Y reenviar estando ya verificado no puede pasar — el servicio lo
 * rechaza.
 *
 * El día que se permita editar datos YA verificados, ese caso sí es crítico y
 * va con su propio evento (`seller.verified_data_changed`).
 */
export const CAMBIOS_CRITICOS = [
  'seller.payment_account_changed',
  'seller.verified_data_changed',
  'user.phone_changed',
];
