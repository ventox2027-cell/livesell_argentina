/**
 * Cuándo volver a intentar un push que falló.
 *
 * Módulo puro, sin Prisma ni reloj propio: la política de reintentos es una
 * decisión que hay que poder leer y probar de un vistazo, y meterla adentro del
 * servicio la convierte en tres líneas perdidas en medio de una consulta.
 */

/**
 * Después de esto se deja de intentar.
 *
 * Cinco intentos repartidos en poco más de un cuarto de hora. Más que eso no
 * sirve para un aviso: una notificación de "tu pedido está listo" que llega a
 * la hora ya no le cambia el día a nadie, y el aviso sigue estando en el centro
 * de notificaciones dentro de la app, que es donde la persona lo va a ver
 * igual.
 */
export const MAX_INTENTOS = 5;

/**
 * Espera creciente entre intentos, en segundos.
 *
 * ─── Por qué crece ───
 *
 * Si Firebase está caído, reintentar cada diez segundos con miles de avisos
 * pendientes es exactamente lo que su límite de tasa castiga: cuando vuelva,
 * nos encuentra con la cuota agotada. Espaciar da tiempo a que se recupere.
 *
 * ─── Por qué no hay azar ───
 *
 * En un sistema con muchas instancias, la espera fija hace que todas reintenten
 * en el mismo instante. Acá el barrido es periódico y toma un lote acotado, así
 * que la dispersión ya la da el propio barrido. Agregar azar haría que dos
 * corridas del mismo caso den resultados distintos, y eso complica los tests
 * sin resolver un problema que tengamos.
 */
const ESPERAS_SEGUNDOS = [30, 120, 300, 900];

/**
 * Cuándo toca el siguiente intento, o `null` si ya no hay que reintentar.
 *
 * `intentosHechos` incluye el que acaba de fallar.
 */
export function proximoIntento(intentosHechos: number, ahora: Date): Date | null {
  if (intentosHechos >= MAX_INTENTOS) return null;

  // La última espera se repite si la tabla es más corta que `MAX_INTENTOS`:
  // así los dos números se pueden tocar por separado sin que uno rompa al otro.
  const ultima = ESPERAS_SEGUNDOS[ESPERAS_SEGUNDOS.length - 1] ?? 900;
  const espera = ESPERAS_SEGUNDOS[intentosHechos - 1] ?? ultima;

  return new Date(ahora.getTime() + espera * 1_000);
}

/** ¿Este fallo agota los intentos? */
export function seAgoto(intentosHechos: number): boolean {
  return intentosHechos >= MAX_INTENTOS;
}
