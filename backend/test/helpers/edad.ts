/**
 * La edad en los tests.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE ARCHIVO EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VendoX es 18+ y el backend lo exige antes de comprar y antes de crear una
 * tienda. Casi todos los tests crean gente para probar otra cosa —el stock, el
 * ranking, las notificaciones— y ninguno tiene nada que ver con la edad.
 *
 * Sin un lugar común, cada uno resolvería lo mismo a su manera y la fecha
 * quedaría escrita a mano en veinte archivos. El día que la regla cambie —una
 * categoría con otra edad mínima, por ejemplo— habría que buscarlas todas.
 *
 * ⚠️ Los tests que prueban la regla NO usan esto. Ver `edad.spec.ts` y el
 * bloque de mayoría de edad en `orders-flow.spec.ts`: ahí las fechas se
 * escriben a propósito, porque son el objeto de la prueba.
 */

/**
 * Alguien nacido en 1990. Mayor de edad en cualquier momento en que se corra la
 * suite, y lo va a seguir siendo.
 *
 * Un cálculo del tipo "hoy menos 25 años" sería más robusto en teoría y peor en
 * la práctica: haría que el dato de un test dependa del reloj, y un fallo que
 * sólo aparece cierto día del año es de los peores de diagnosticar.
 */
export const NACIMIENTO_ADULTO = new Date(Date.UTC(1990, 4, 20));

/** La misma fecha, como la manda la app. */
export const NACIMIENTO_ADULTO_ISO = '1990-05-20';

/**
 * Los dos campos que hay que escribir al crear a alguien directo con Prisma.
 *
 * Van juntos a propósito: `birthDateDeclaredAt` es la constancia de que se
 * preguntó, y una fila con fecha pero sin constancia describe un estado que la
 * aplicación no puede producir.
 */
export function datosDeAdulto() {
  return {
    birthDate: NACIMIENTO_ADULTO,
    birthDateDeclaredAt: new Date(),
  };
}
