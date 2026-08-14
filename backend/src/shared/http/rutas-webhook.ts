/**
 * Las rutas de webhook, en un módulo SIN IMPORTS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTÁN ACÁ Y NO EN `http-setup.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque `env.schema.ts` necesita validar que `MP_NOTIFICATION_URL` apunte a
 * la ruta correcta, y `http-setup.ts` importa `env`. Ponerlas allá cerraría el
 * ciclo `env.schema → http-setup → env.schema`.
 *
 * Es el mismo motivo por el que existe `deployment-provider.ts`: cuando un
 * valor lo necesitan la configuración y el arranque, el valor va en un archivo
 * que no depende de ninguno de los dos.
 *
 * ─── Quiénes las usan ───
 *
 *   · `http-setup.ts` — para excluirlas del prefijo `/api` y del versionado.
 *   · `env.schema.ts` — para rechazar el arranque si la URL de notificación
 *     configurada no termina en la ruta canónica.
 *   · Los controladores y los tests — para no escribir la cadena a mano.
 */

/**
 * ⚠️ LA RUTA PRODUCTIVA. Es la que se carga en el panel de Mercado Pago.
 *
 * Sin `/api` y sin `/v1`: la URL la escribe una persona en un formulario de un
 * proveedor externo, y el día que saliera `/api/v2/` nadie va a ir a
 * actualizarla.
 */
export const RUTA_WEBHOOK_MERCADOPAGO = 'webhooks/orders/mercadopago';

/**
 * El webhook del spike. **No es productivo y no puede existir en producción**:
 * su módulo está detrás de `PAYMENTS_SPIKE_ENABLED`, que `env.schema.ts`
 * prohíbe fuera de desarrollo.
 *
 * El segmento `spike` está en la ruta a propósito. Antes ocupaba
 * `webhooks/mercadopago` —la más corta y la más creíble de las dos— y era la
 * que alguien iba a pegar en el panel por error, acreditando pagos contra una
 * tabla que el flujo real de pedidos no usa.
 */
export const RUTA_WEBHOOK_SPIKE = 'webhooks/spike/mercadopago';

/** El webhook de LiveKit. Misma lógica: URL cargada a mano en su panel. */
export const RUTA_WEBHOOK_LIVEKIT = 'webhooks/livekit';

/**
 * El callback del OAuth de Mercado Pago.
 *
 * Misma lógica que los webhooks: la URL se carga a mano en el panel de
 * aplicaciones de Mercado Pago y tiene que coincidir carácter por carácter.
 * Bajo `/api/v1/`, el día que exista `/api/v2/` habría que entrar al panel a
 * cambiarla, y mientras tanto cada vendedor que intente conectar vería un
 * error de Mercado Pago que no dice cuál es el problema.
 */
export const RUTA_OAUTH_MERCADOPAGO = 'oauth/mercadopago';
