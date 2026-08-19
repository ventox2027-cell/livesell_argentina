import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';

import { limitesDe, puedePublicarUnoMas } from './membresias';

/**
 * Cuántos productos puede tener publicados un vendedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO SE VALIDA EN EL SERVIDOR, Y NO ES UNA FORMALIDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La app va a esconder el botón cuando el vendedor llegue al tope, y eso está
 * bien: es lo que hace que la restricción se entienda antes de chocarla. Pero
 * esconder un botón no es una regla. `POST /products` y `PATCH /products/:id`
 * son dos peticiones HTTP que cualquiera puede repetir con curl.
 *
 * Si el límite viviera sólo en Flutter, el plan Free sería una sugerencia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EN LA TRANSICIÓN, NO EN LA CREACIÓN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Se comprueba cuando un producto PASA a `ACTIVE`. Crear borradores es libre y
 * gratis: alguien en Free puede cargar cuarenta productos con sus fotos y sus
 * variantes, y elegir cuáles tres muestra.
 *
 * Frenarlo al cargar sería otra cosa —y peor—: el trabajo de armar la ficha se
 * perdería, y nadie vuelve de eso.
 */

export class LimiteDeCatalogoError extends DomainError {
  constructor(limite: number, publicados: number) {
    super(
      'PLAN_LIMIT_REACHED',
      `Llegaste al límite de ${limite} productos publicados del plan Free. ` +
        `Pasate a VendoX Pro para ampliar tu catálogo.`,
      { limite, publicados, recurso: 'productos_publicados' },
    );
  }
}

export interface EstadoDelCatalogo {
  /** Cuántos tiene publicados ahora. */
  readonly publicados: number;
  /** El techo de su plan. `null` = sin techo. */
  readonly limite: number | null;
  /** Si puede publicar uno más. */
  readonly puedePublicar: boolean;
}

@Injectable()
export class LimiteDeCatalogo {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cuántos productos publicados tiene, contando TODAS sus tiendas.
   *
   * Por vendedor y no por tienda: si contara por tienda, abrir una segunda
   * multiplicaría el límite y la regla no diría nada.
   *
   * `deletedAt: null` porque un producto borrado no está en ninguna vidriera.
   * Sin ese filtro, borrar tres productos publicados dejaría al vendedor sin
   * poder publicar nunca más, y el motivo sería invisible.
   */
  private async publicadosDe(
    sellerId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return tx.product.count({
      where: { store: { sellerId }, status: 'ACTIVE', deletedAt: null },
    });
  }

  /** Lo que necesita la app para mostrar «2 de 3 productos publicados». */
  async estado(sellerId: string): Promise<EstadoDelCatalogo> {
    const membresia = await this.prisma.sellerMembership.findUnique({
      where: { sellerId },
      select: { plan: true, vigenteHasta: true },
    });
    const limite = limitesDe(membresia).productosPublicados;
    const publicados = await this.publicadosDe(sellerId);

    return { publicados, limite, puedePublicar: puedePublicarUnoMas(limite, publicados) };
  }

  /**
   * Corta si ya llegó al tope.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ HAY UN CERROJO Y NO ALCANZA CON CONTAR
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «Contar y después escribir» es una carrera. Dos publicaciones simultáneas
   * del mismo vendedor —dos toques rápidos, o dos peticiones a mano— leen 2,
   * las dos concluyen que pueden, y las dos publican: queda en 4.
   *
   * En el resto del sistema esto se resuelve con un UPDATE condicional atómico,
   * que no sirve acá: la condición no es sobre la fila que se escribe, es sobre
   * cuántas OTRAS filas cumplen algo. No hay WHERE que exprese eso.
   *
   * `pg_advisory_xact_lock` serializa a ese vendedor consigo mismo durante la
   * transacción. No bloquea a nadie más —la clave es el `sellerId`— y se suelta
   * solo al terminar, incluso si algo lanza.
   *
   * ⚠️ Por eso `exigirPoderPublicar` sólo sirve DENTRO de una transacción que
   * después haga la escritura. Llamarlo suelto comprueba y suelta el cerrojo
   * antes de escribir, que es exactamente el bug que evita.
   */
  async exigirPoderPublicar(
    tx: Prisma.TransactionClient,
    sellerId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`catalogo:${sellerId}`}))`;

    const membresia = await tx.sellerMembership.findUnique({
      where: { sellerId },
      select: { plan: true, vigenteHasta: true },
    });
    const limite = limitesDe(membresia).productosPublicados;
    if (limite === null) return;

    const publicados = await this.publicadosDe(sellerId, tx);
    if (!puedePublicarUnoMas(limite, publicados)) {
      throw new LimiteDeCatalogoError(limite, publicados);
    }
  }
}
