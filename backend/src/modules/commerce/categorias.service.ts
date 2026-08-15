import { Injectable } from '@nestjs/common';

import { PrismaService } from '@/shared/prisma/prisma.service';

import { CategoriaInexistenteError } from './categorias';

/**
 * Las categorías, leídas de la base.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO SE SIRVE LA CONSTANTE DIRECTAMENTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CATALOGO` en `categorias.ts` es la semilla: lo que la migración escribió.
 * Servirlo de ahí sería más rápido y estaría mal — apagar una categoría en
 * producción es un `UPDATE`, y con la constante como fuente la app seguiría
 * ofreciéndola.
 *
 * La constante es de dónde salen los datos la primera vez. La base es lo que
 * hay ahora.
 */
@Injectable()
export class CategoriasService {
  /**
   * El caché es del proceso y no expira.
   *
   * Catorce filas que cambian una vez por trimestre, consultadas en cada carga
   * del formulario de producto y en cada navegación por rubro. Un caché con
   * TTL agregaría una fecha de vencimiento a algo que no vence.
   *
   * Apagar una categoría exige reiniciar el backend para que desaparezca del
   * selector. Es aceptable: son minutos, no es una operación urgente, y la
   * alternativa —invalidación distribuida entre instancias— es infraestructura
   * para catorce filas.
   */
  private memoria: { id: string; slug: string; nombre: string }[] | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Las activas, en orden de presentación. */
  async listar() {
    if (this.memoria) return this.memoria;

    const filas = await this.prisma.category.findMany({
      where: { active: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      select: { id: true, slug: true, name: true },
    });

    this.memoria = filas.map((c) => ({ id: c.id, slug: c.slug, nombre: c.name }));
    return this.memoria;
  }

  /**
   * Falla si la categoría no existe o está apagada.
   *
   * ⚠️ Sin esto, `categoryId` era texto libre de hasta 40 caracteres que se
   * escribía tal cual en la columna. La clave foránea rebotaba un id inventado
   * con un P2003 —un 500 con traza de Prisma en la respuesta— en lugar de un
   * 404 con un mensaje. Y no hay clave foránea que detecte una categoría
   * apagada.
   */
  async exigirQueExista(categoriaId: string): Promise<void> {
    const activas = await this.listar();
    if (!activas.some((c) => c.id === categoriaId)) throw new CategoriaInexistenteError();
  }

  /** Para los tests: obliga a la próxima lectura a ir a la base. */
  olvidar(): void {
    this.memoria = null;
  }
}
