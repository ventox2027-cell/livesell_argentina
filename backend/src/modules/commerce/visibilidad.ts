import type { Prisma } from '@prisma/client';

/**
 * Qué hace que un producto sea visible para quien compra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNA SOLA DEFINICIÓN, USADA EN TODOS LADOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un producto se muestra en cinco lugares distintos: el feed, la búsqueda, la
 * vidriera de la tienda, el catálogo del vivo y la ficha del producto. Cada uno
 * tenía su propio `where` copiado a mano.
 *
 * Eso funciona hasta que se agrega una condición nueva. Cuando apareció el
 * ocultamiento por moderación, había que sumar `hiddenAt: null` en cinco
 * lugares — y olvidarse de uno significa que un producto ocultado por contenido
 * prohibido **sigue apareciendo** en la búsqueda mientras el equipo cree que lo
 * bajó.
 *
 * Con la definición acá, agregar una condición es una línea y no hay dónde
 * olvidarse.
 *
 * ─── La búsqueda tiene una copia, y está bien ───
 *
 * La búsqueda usa SQL a mano y no puede importar esto: su `WHERE` repite las
 * condiciones. Pero **la garantía no depende de esa copia**: la búsqueda
 * devuelve sólo IDS, y la consulta que arma la respuesta los vuelve a filtrar
 * con `PRODUCTO_COMPRABLE`.
 *
 * O sea que la copia en SQL es un filtro TEMPRANO —evita traer ids que después
 * se van a descartar— y las dos capas se cubren entre sí.
 *
 * Se comprobó quitando cada una por separado: sin la de Prisma, un producto
 * oculto vuelve al feed y el test lo ve; sin la de SQL, no cambia nada porque
 * la de Prisma lo atrapa.
 */

/**
 * Las tres condiciones que hacen visible a un producto.
 *
 *   · publicado por el vendedor (`ACTIVE`, no borrador ni pausado);
 *   · no borrado;
 *   · no oculto por moderación.
 *
 * `hiddenAt` es DISTINTO de `status: PAUSED`. Pausar lo decide el vendedor y lo
 * puede revertir cuando quiera; ocultar lo decide la moderación y sólo lo
 * revierte el equipo. Fundirlos en un solo campo haría que el vendedor pudiera
 * deshacer una sanción despausando.
 */
export const PRODUCTO_VISIBLE = {
  status: 'ACTIVE',
  deletedAt: null,
  hiddenAt: null,
} as const satisfies Prisma.ProductWhereInput;

/**
 * Lo mismo, más que la tienda y el vendedor estén operando.
 *
 * Los tres filtros no son redundantes: un vendedor suspendido puede tener
 * productos que quedaron activos, y sin el tercero seguirían apareciendo
 * después de la suspensión — que es exactamente lo que la suspensión impide.
 */
export const PRODUCTO_COMPRABLE = {
  ...PRODUCTO_VISIBLE,
  store: { status: 'ACTIVE', seller: { status: 'ACTIVE' } },
} as const satisfies Prisma.ProductWhereInput;
