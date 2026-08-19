import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { tasaPara, type TasaAplicable } from './comision-por-volumen';
import { planVigente } from './membresias';
import { medirVolumenDe } from './volumen';

/**
 * Qué comisión le corresponde a un vendedor, ahora.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTE SERVICIO CONSULTA. NO DECIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Junta tres datos —el plan vigente, el volumen de la ventana y la tasa de
 * devolución— y se los pasa a `tasaPara`, que es puro y es donde está la
 * regla. La separación es la misma que hay entre `risk.service` y `risk.rules`,
 * y por el mismo motivo: probar «un Business con 15 % de devoluciones no accede
 * al 3 %» no puede requerir montar ese vendedor en PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ NUNCA LANZA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Esto corre en el camino de crear una orden. Que falle una consulta de volumen
 * no puede impedir una compra: se cae a la tasa base, se registra el error, y
 * la venta sigue.
 *
 * La caída es a la tasa BASE, o sea a favor de VendoX. Es la única dirección
 * defendible: un fallo no puede otorgar un descuento que nadie verificó. El
 * vendedor que quedó sin su tramo por un error puntual tiene un reclamo con
 * respuesta —el motivo queda guardado en la orden—; un descuento regalado por
 * un timeout no se puede deshacer, porque la comisión ya se congeló.
 */
@Injectable()
export class TasaDeComision {
  private readonly logger = new Logger(TasaDeComision.name);

  constructor(private readonly prisma: PrismaService) {}

  async para(sellerId: string, ahora: Date = new Date()): Promise<TasaAplicable> {
    const bpsBase = env.VENDOX_PLATFORM_FEE_BPS;

    try {
      const membresia = await this.prisma.sellerMembership.findUnique({
        where: { sellerId },
        select: { plan: true, vigenteHasta: true },
      });
      const plan = planVigente(membresia, ahora);

      /**
       * Sólo Business paga la consulta de volumen.
       *
       * Para Free y Pro el resultado no puede cambiar, así que medir sería un
       * escaneo de 28 días de órdenes por cada compra que se crea, en la enorme
       * mayoría de los casos, para llegar siempre al mismo número.
       */
      if (plan !== 'BUSINESS') {
        return tasaPara({
          plan,
          bpsBase,
          medicion: {
            brutoConfirmado: 0,
            devuelto: 0,
            volumenElegible: 0,
            promedioSemanal: 0,
            tasaDeDevolucionBps: 0,
          },
          umbralDeDevolucionesBps: env.VENDOX_BUSINESS_MAX_REFUND_BPS,
        });
      }

      const medicion = await medirVolumenDe(this.prisma, sellerId, ahora);

      return tasaPara({
        plan,
        bpsBase,
        medicion,
        umbralDeDevolucionesBps: env.VENDOX_BUSINESS_MAX_REFUND_BPS,
      });
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo calcular la tasa por volumen; se cobra la base',
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        bps: bpsBase,
        motivo: 'PLAN_SIN_TRAMOS',
        promedioSemanal: 0,
        tasaDeDevolucionBps: 0,
        bpsQueHabriaTenido: null,
      };
    }
  }
}
