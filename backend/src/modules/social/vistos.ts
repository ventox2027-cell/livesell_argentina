/**
 * Vistos recientemente, y guardados.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DOS LISTAS QUE PARECEN LA MISMA Y NO LO SON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | | Guardados | Vistos recientemente |
 * |---|---|---|
 * | quién la arma | la persona, a propósito | el sistema, mirando |
 * | qué significa | «esto me interesa» | «pasé por acá» |
 * | cuánto dura | hasta que lo saque | 30 días |
 * | se puede notificar | sí | **no** |
 *
 * La última fila es la que importa. Un aviso de «volvió al stock» sobre algo
 * que alguien GUARDÓ es un favor. El mismo aviso sobre algo que apenas MIRÓ
 * es perseguirlo por la app, y es lo que hace que la gente apague las
 * notificaciones para siempre.
 *
 * Por eso son dos tablas y no una con una bandera: con una bandera, la
 * próxima consulta que se escriba se olvida de filtrarla.
 */

/**
 * Cuántos días quedan los vistos.
 *
 * Treinta. Es lo que dura la utilidad real —«¿cómo se llamaba esa tienda que
 * vi la semana pasada?»— y a partir de ahí la lista deja de ser una ayuda y
 * pasa a ser un historial de navegación de meses, que es exactamente lo que
 * esta función no quiere ser.
 *
 * Es el mismo plazo que el chat del vivo, y por el mismo motivo: lo que deja
 * de servir se borra.
 */
export const VISTOS_RETENCION_DIAS = 30;

/**
 * Cuántos se muestran.
 *
 * Veinte. Una lista de «recientes» de doscientos elementos no es reciente: es
 * un historial, y nadie scrollea un historial buscando algo.
 */
export const VISTOS_EN_PANTALLA = 20;

/**
 * Cuántos se guardan por persona.
 *
 * ⚠️ Cincuenta, y se podan los más viejos al pasarse.
 *
 * Sin tope, la tabla crece con cada scroll de cada persona para siempre. Con
 * cien mil usuarios navegando, «vistos recientemente» sería la tabla más
 * grande del sistema por varios órdenes de magnitud — y el 99 % serían filas
 * que nadie va a leer nunca, porque sólo se muestran veinte.
 *
 * El margen entre 50 y 20 existe para que la lista siga completa después de
 * que la retención borre los más viejos.
 */
export const VISTOS_MAXIMO_POR_PERSONA = 50;
