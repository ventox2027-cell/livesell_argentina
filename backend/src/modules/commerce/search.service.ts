import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/shared/prisma/prisma.service';

import { prepararBusqueda } from './ranking';

/**
 * Buscar en el catálogo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `$queryRaw` Y NO PRISMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prisma no expone la búsqueda de texto de PostgreSQL con el vector generado ni
 * con `websearch_to_tsquery`. La alternativa —`contains` sobre el nombre— es
 * `ILIKE '%...%'`, que **no usa índice**: recorre la tabla entera en cada
 * búsqueda y no entiende castellano ("zapatos" no encontraría "zapato").
 *
 * Así que esta consulta va en SQL, con parámetros ligados. Es el único lugar del
 * proyecto donde se escribe SQL a mano, y por eso lleva este comentario.
 *
 * ⛔ **Los parámetros van SIEMPRE ligados**, nunca interpolados. Con
 * `Prisma.sql` y `${}` el driver los manda aparte de la consulta: no hay forma
 * de que lo que alguien escriba en el buscador se ejecute.
 */

/**
 * El id se devuelve y después se hidrata con Prisma.
 *
 * Dos consultas en vez de una, a propósito: escribir a mano el `SELECT` con
 * todos los joins del feed —tienda, vendedor, variantes, inventario— sería
 * duplicar en SQL lo que ya está en `PRODUCT_SELECT`, y las dos copias se
 * despegarían en la primera columna nueva.
 */
interface FilaDeBusqueda {
  id: string;
  rank: number;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ids de productos que coinciden, del más relevante al menos.
   *
   * Devuelve una lista vacía si la consulta es demasiado corta: menos de dos
   * caracteres devuelve medio catálogo y no ayuda a nadie.
   */
  async idsQueCoinciden(texto: string, limite = 40): Promise<string[]> {
    const consulta = prepararBusqueda(texto);
    if (!consulta) return [];

    const filas = await this.prisma.$queryRaw<FilaDeBusqueda[]>(Prisma.sql`
      SELECT p.id,
             ts_rank(p.search_vector, websearch_to_tsquery('spanish', ${consulta})) AS rank
      FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN sellers v ON v.id = s.seller_id
      WHERE p.search_vector @@ websearch_to_tsquery('spanish', ${consulta})
        AND p.status = 'ACTIVE'
        AND p.deleted_at IS NULL
        -- Oculto por moderación. Es un filtro TEMPRANO: la consulta que arma
        -- la respuesta vuelve a filtrar con PRODUCTO_COMPRABLE, así que la
        -- garantía no depende de esta línea. Está para no traer ids que se van
        -- a descartar. Ver visibilidad.ts.
        AND p.hidden_at IS NULL
        AND s.status = 'ACTIVE'
        AND v.status = 'ACTIVE'
      ORDER BY rank DESC, p.created_at DESC
      LIMIT ${limite}
    `);

    return filas.map((f) => f.id);
  }

  /**
   * Sugerencias mientras se escribe.
   *
   * ─── Por qué salen de los productos y no de un diccionario ───
   *
   * Un diccionario de términos populares hay que mantenerlo, y arranca vacío.
   * Los nombres de los productos que existen ya son exactamente lo que la gente
   * puede encontrar: sugerir "zapatillas" cuando no vendemos ninguna es
   * prometer un resultado vacío.
   *
   * Se limita a cinco: una lista más larga tapa el teclado.
   */
  async sugerencias(texto: string): Promise<string[]> {
    const consulta = prepararBusqueda(texto);
    if (!consulta) return [];

    const filas = await this.prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT DISTINCT p.name
      FROM products p
      JOIN stores s ON s.id = p.store_id
      WHERE p.search_vector @@ websearch_to_tsquery('spanish', ${consulta})
        AND p.status = 'ACTIVE'
        AND p.deleted_at IS NULL
        AND p.hidden_at IS NULL
        AND s.status = 'ACTIVE'
      ORDER BY p.name
      LIMIT 5
    `);

    return filas.map((f) => f.name);
  }
}
