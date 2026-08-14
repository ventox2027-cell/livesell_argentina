import { Injectable } from '@nestjs/common';
import type { SupportCategory } from '@prisma/client';

/**
 * Quién contesta un ticket de soporte automáticamente.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA INTERFAZ EXISTE PARA QUE EL MODELO SEA REEMPLAZABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hoy la implementación son respuestas guionadas. Mañana puede ser un modelo de
 * lenguaje. Lo que NO cambia es lo que está fuera de esta interfaz: qué escala,
 * qué no puede prometerse, y que la plata siempre va a una persona.
 *
 * Esa separación es la que hace que conectar un modelo sea una decisión
 * reversible. Con las reglas adentro del prompt, cambiar de proveedor
 * significaría reescribir la política de escalada.
 *
 * ─── Por qué las respuestas guionadas no son un placeholder ───
 *
 * Son lo que corre en producción hasta que haya credenciales de un proveedor de
 * IA —otra decisión que no se toma sin el dueño del producto delante— y además
 * son el respaldo permanente: cuando el proveedor esté caído, esto contesta
 * igual en vez de dejar el ticket sin respuesta.
 *
 * Y para las diez preguntas que son el 80 % del volumen real de un marketplace
 * —"dónde está mi pedido", "cómo cambio un talle"— una respuesta guionada
 * correcta le gana a una generada que puede inventar.
 */

export interface ContextoDelTicket {
  categoria: SupportCategory;
  mensaje: string;
  /** Cuántas veces ya contestó el asistente. */
  vueltasPrevias: number;
  /** Si la consulta menciona un pedido concreto. */
  tieneOrden: boolean;
}

export interface RespuestaDelAsistente {
  /** El texto, o `null` si no sabe qué contestar. */
  texto: string | null;
  /**
   * Si el propio asistente pide escalar.
   *
   * Distinto de que las reglas lo obliguen: esto es "no sé la respuesta", y las
   * reglas son "no me corresponde responder". Los dos terminan en una persona,
   * pero el motivo que se registra es distinto y sirve para saber qué falta
   * automatizar.
   */
  noSabe: boolean;
}

export abstract class SupportAgent {
  /** Cómo se llama en la conversación. */
  abstract get nombre(): string;

  abstract responder(ctx: ContextoDelTicket): Promise<RespuestaDelAsistente>;
}

/**
 * El asistente guionado.
 *
 * Contesta las preguntas frecuentes con información que **siempre es cierta**:
 * dónde mirar en la app, qué dice la política, cuánto tarda un proceso. Nunca
 * afirma nada sobre un pedido concreto —"tu paquete salió ayer"— porque para
 * eso habría que consultar datos, y una respuesta desactualizada sobre un
 * pedido es peor que no contestar.
 */
@Injectable()
export class AsistenteGuionado extends SupportAgent {
  get nombre(): string {
    return 'Asistente de VendoX';
  }

  responder(ctx: ContextoDelTicket): Promise<RespuestaDelAsistente> {
    const texto = this.guion(ctx.categoria, ctx.tieneOrden);
    return Promise.resolve({ texto, noSabe: texto === null });
  }

  /**
   * ⚠️ Ninguna de estas respuestas afirma nada sobre un pedido concreto.
   *
   * Dicen dónde mirar y qué esperar. "Tu paquete salió ayer" necesitaría
   * consultar el estado real, y una respuesta desactualizada sobre un pedido
   * —porque el vendedor lo despachó entre la consulta y la respuesta— es peor
   * que no contestar nada.
   */
  private guion(categoria: SupportCategory, tieneOrden: boolean): string | null {
    switch (categoria) {
      case 'ENVIO':
        return (
          'El estado de tu pedido lo ves en **Mis pedidos**, dentro de tu perfil. ' +
          'Ahí figura si el vendedor ya lo preparó, si lo despachó y el código que ' +
          'tenés que decir cuando lo recibas.\n\n' +
          (tieneOrden
            ? 'Si pasaron más de 5 días desde que lo despacharon y no llegó, contame y lo vemos.'
            : 'Si me decís de qué pedido hablás, lo miro con vos.')
        );

      case 'CAMBIOS':
        return (
          'Cada tienda tiene su política de cambios, y la ves en la página del ' +
          'producto antes de comprar.\n\n' +
          'Además, por ley tenés **10 días corridos** desde que recibís el producto ' +
          'para arrepentirte de una compra online, sin dar motivos y sin costo. ' +
          'Eso no depende del vendedor.\n\n' +
          'Para empezar un cambio, entrá al pedido en **Mis pedidos** y escribile al ' +
          'vendedor desde ahí.'
        );

      case 'CUENTA':
        return (
          'Para entrar podés usar tu correo o tu cuenta de Google, desde la pantalla ' +
          'de inicio.\n\n' +
          'Si querés cerrar la sesión de un teléfono que ya no usás, mirá **Sesiones ' +
          'activas** en tu perfil.\n\n' +
          'Si el problema es otro, contame qué te aparece exactamente y lo vemos.'
        );

      case 'VENDEDOR':
        return (
          'Para vender, entrá a **Mi tienda** desde tu perfil. Ahí cargás productos, ' +
          'definís tu envío y arrancás un vivo con el botón **Iniciar LIVE**.\n\n' +
          'VendoX cobra **6 % de comisión sobre el precio del producto**. No cobramos ' +
          'comisión sobre el envío ni sobre el costo del cobro.\n\n' +
          '¿Sobre qué parte querés que te cuente más?'
        );

      case 'PROBLEMA_TECNICO':
        return (
          'Contame qué pantalla estabas usando y qué pasó exactamente, así lo ' +
          'reproducimos. Si te aparece un mensaje de error, copiámelo tal cual.\n\n' +
          'Mientras tanto, cerrar y volver a abrir la app resuelve la mayoría de ' +
          'estos casos.'
        );

      /**
       * Estas dos no llegan nunca acá: las reglas de escalada las atajan antes.
       *
       * El `return null` es la segunda red. Si algún día alguien cambia el
       * orden y una consulta de plata llega hasta el asistente, la respuesta es
       * "no sé" —que escala— y no una improvisación.
       */
      case 'PAGOS':
      case 'DISPUTA':
        return null;

      case 'OTRO':
        return null;
    }
  }
}
