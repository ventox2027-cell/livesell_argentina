import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';

/**
 * Los interruptores de emergencia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PARA QUÉ SIRVEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Son cuatro llaves de luz para apagar una parte del sistema sin desplegar
 * nada. El caso que las justifica es siempre el mismo y siempre urgente:
 *
 *   · Mercado Pago está devolviendo pagos duplicados → apagar el checkout
 *     antes de cobrarle dos veces a diez personas más;
 *   · LiveKit se cayó y cada vivo que empieza es una sala que no conecta →
 *     apagar los vivos en vez de dejar que la gente lo intente;
 *   · alguien encontró cómo subir un ejecutable disfrazado de imagen →
 *     apagar las subidas mientras se arregla;
 *   · una campaña de cuentas falsas está abriendo tiendas en serie →
 *     apagar el alta de vendedores.
 *
 * En los cuatro, la alternativa sin banderas es desplegar un parche con el
 * sistema roto y gente perdiendo plata mientras tanto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SON VARIABLES DE ENTORNO Y NO UNA TABLA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una tabla con un botón en el panel se apagaría más rápido —un clic contra
 * un reinicio de unos segundos— y sería un segundo mecanismo de configuración
 * conviviendo con el que ya existe. Todo lo demás que enciende y apaga partes
 * del sistema (`SELLER_MUST_CONNECT_MP`, `PUSH_ENABLED`, `DEMO_LOGIN_ENABLED`)
 * ya vive en `env.schema.ts`, validado al arrancar.
 *
 * Con dos mecanismos, la pregunta «¿por qué no anda el checkout?» pasa a tener
 * dos lugares donde buscar, y en una emergencia eso cuesta más que los
 * segundos que ahorra el botón.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE UNA BANDERA APAGADA **NO** HACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⛔ **No rompe lo que ya está en curso.** Apagar el checkout no cancela las
 * órdenes pagas, no frena los webhooks de Mercado Pago y no impide entregar.
 * Apagar los vivos no corta el que está transmitiendo. Una bandera cierra la
 * puerta de entrada; lo que está adentro sigue su curso, porque abandonar a
 * medio camino a quien ya pagó es peor que el problema que se está apagando.
 *
 * Por eso cada bandera se aplica en el punto donde algo EMPIEZA, y nunca en
 * los caminos de conciliación, webhooks o cierre.
 */

export const BANDERAS = {
  /** Preparar y arrancar transmisiones. No corta las que están al aire. */
  LIVE: 'LIVE_ENABLED',
  /** Crear órdenes e iniciar pagos. No toca las órdenes que ya existen. */
  CHECKOUT: 'CHECKOUT_ENABLED',
  /** Convertirse en vendedor. No suspende a los que ya lo son. */
  SELLER_SIGNUP: 'SELLER_SIGNUP_ENABLED',
  /** Crear productos y subir imágenes. No oculta los que ya están. */
  PRODUCT_UPLOAD: 'PRODUCT_UPLOAD_ENABLED',
} as const;

export type Bandera = (typeof BANDERAS)[keyof typeof BANDERAS];

/**
 * Qué se le dice a la persona.
 *
 * No dice «bandera», no dice «deshabilitado por configuración» y no dice qué
 * se rompió. Dice qué no se puede hacer ahora y que es temporal, que es todo
 * lo que quien está del otro lado puede hacer algo con ello.
 *
 * Tampoco promete un horario: una emergencia no tiene fecha de resolución, y
 * un «volvé en una hora» que no se cumple es peor que no decir nada.
 */
const MENSAJES: Record<Bandera, string> = {
  LIVE_ENABLED: 'Los vivos están pausados por unos minutos. Volvé a intentar en un rato.',
  CHECKOUT_ENABLED:
    'Las compras están pausadas por unos minutos. Tu carrito no se pierde: volvé a intentar en un rato.',
  SELLER_SIGNUP_ENABLED:
    'El alta de vendedores está pausada por unos minutos. Volvé a intentar en un rato.',
  PRODUCT_UPLOAD_ENABLED:
    'La carga de productos está pausada por unos minutos. Volvé a intentar en un rato.',
};

export class FuncionPausadaError extends DomainError {
  constructor(bandera: Bandera) {
    /**
     * 503 y no 403.
     *
     * No es que esta persona no tenga permiso: es que el servicio no está
     * disponible para nadie, y es temporal. La app distingue los dos casos —
     * un 403 la manda a explicar un problema de cuenta que no existe— y los
     * monitoreos externos leen un 503 como «servicio degradado», que es
     * exactamente lo que está pasando.
     */
    super('FEATURE_PAUSED', MENSAJES[bandera], { bandera });
  }
}

/** ¿Está encendida? */
export function estaHabilitada(bandera: Bandera): boolean {
  switch (bandera) {
    case 'LIVE_ENABLED':
      return env.LIVE_ENABLED;
    case 'CHECKOUT_ENABLED':
      return env.CHECKOUT_ENABLED;
    case 'SELLER_SIGNUP_ENABLED':
      return env.SELLER_SIGNUP_ENABLED;
    case 'PRODUCT_UPLOAD_ENABLED':
      return env.PRODUCT_UPLOAD_ENABLED;
  }
}

/**
 * Falla si está apagada.
 *
 * ⚠️ Lee `env` en cada llamada y no una vez al construir el servicio: los
 * tests apagan y encienden banderas sobre el objeto de configuración, y con el
 * valor capturado en el constructor cambiarlo no tendría efecto — o sea que
 * los tests pasarían sin probar nada.
 */
export function exigirHabilitada(bandera: Bandera): void {
  if (!estaHabilitada(bandera)) throw new FuncionPausadaError(bandera);
}

/** El estado de las cuatro, para que la app esconda lo que no se puede usar. */
export function estadoDeLasBanderas(): Record<Bandera, boolean> {
  return {
    LIVE_ENABLED: estaHabilitada('LIVE_ENABLED'),
    CHECKOUT_ENABLED: estaHabilitada('CHECKOUT_ENABLED'),
    SELLER_SIGNUP_ENABLED: estaHabilitada('SELLER_SIGNUP_ENABLED'),
    PRODUCT_UPLOAD_ENABLED: estaHabilitada('PRODUCT_UPLOAD_ENABLED'),
  };
}
