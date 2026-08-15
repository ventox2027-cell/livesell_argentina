import { DomainError } from '@/shared/errors/domain.error';

/**
 * El requisito para vender: tener Mercado Pago conectado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ES UN BLOQUEO Y NO UN AVISO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Si un vendedor puede publicar sin conectar su cuenta, el cobro entra en la de
 * VendoX. Eso nos convierte en intermediarios del dinero de terceros —con lo
 * que eso implica legalmente— y cada venta acumulada así es plata que le
 * debemos a alguien y que hay que girar a mano, una por una.
 *
 * Un aviso no alcanza porque el vendedor lo ignora hasta que vende. Para
 * entonces ya hay plata de por medio y el problema es nuestro.
 *
 * ─── Lo que SÍ puede hacer sin conectar ───
 *
 * Crear su cuenta, crear la tienda, cargar productos en borrador, subir fotos,
 * definir envío y devoluciones, configurar horarios. Todo el trabajo pesado de
 * arrancar.
 *
 * Lo único que no puede es **publicar un producto vendible** e **iniciar un
 * vivo comercial**. La diferencia importa: alguien que se sienta una tarde a
 * cargar cuarenta productos no se topa con el bloqueo hasta el final, cuando ya
 * tiene todo hecho y le queda un solo paso.
 *
 * ─── Módulo puro ───
 *
 * La regla se va a discutir y a ajustar. Tiene que poder leerse de un vistazo y
 * probarse sin base de datos.
 */

/**
 * Qué acción se está intentando. Cambia el mensaje, no la regla.
 *
 * Un mensaje genérico —"conectá Mercado Pago"— deja a la persona sin saber qué
 * estaba haciendo cuando la frenaron, sobre todo si tocó "publicar" en una
 * lista de veinte productos.
 */
export type AccionQueRequiereMp = 'publicar' | 'transmitir';

export class RequiereMercadoPagoError extends DomainError {
  constructor(accion: AccionQueRequiereMp) {
    super('MP_ACCOUNT_REQUIRED', mensajeDe(accion), { accion });
  }
}

function mensajeDe(accion: AccionQueRequiereMp): string {
  switch (accion) {
    case 'publicar':
      return (
        'Para publicar un producto necesitás conectar tu cuenta de Mercado Pago. ' +
        'Es donde va a entrar el dinero de tus ventas. Lo hacés una sola vez.'
      );
    case 'transmitir':
      return (
        'Para hacer un vivo necesitás conectar tu cuenta de Mercado Pago. ' +
        'Es donde va a entrar el dinero de tus ventas. Lo hacés una sola vez.'
      );
  }
}

/**
 * ¿Se puede vender?
 *
 * Los tres estados posibles, y por qué cada uno decide lo que decide:
 *
 *   · **La regla está apagada** → sí. Es el interruptor de incidente: si el
 *     OAuth se cae, poder apagarlo sin desplegar es la diferencia entre una
 *     tarde mala y un día perdido.
 *   · **El OAuth no está configurado en este servidor** → sí. Exigir conectar
 *     algo que no se puede conectar dejaría la app inservible, y no es culpa
 *     del vendedor.
 *   · **Está configurado y la regla encendida** → hace falta la cuenta.
 */
export function puedeVender(params: {
  /** `SELLER_MUST_CONNECT_MP`. */
  reglaActiva: boolean;
  /** Si este servidor tiene credenciales de OAuth cargadas. */
  oauthDisponible: boolean;
  /** Si este vendedor ya conectó su cuenta. */
  cuentaConectada: boolean;
}): boolean {
  if (!params.reglaActiva) return true;
  if (!params.oauthDisponible) return true;
  return params.cuentaConectada;
}

/**
 * Lanza si no se puede. Para usar en los puntos donde hay que frenar.
 *
 * Se separa de `puedeVender` porque la app también necesita PREGUNTAR sin que
 * eso sea un error: la pantalla de "Mi tienda" muestra el estado, y para eso
 * hace falta la respuesta, no una excepción.
 */
export function exigirMercadoPago(
  accion: AccionQueRequiereMp,
  params: Parameters<typeof puedeVender>[0],
): void {
  if (!puedeVender(params)) throw new RequiereMercadoPagoError(accion);
}
