import type { SupportCategory } from '@prisma/client';

/**
 * Cuándo el asistente automático NO puede contestar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA IA NO DECIDE NADA SOBRE PLATA. NUNCA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que determine quién se queda con el dinero —una devolución, un cobro
 * duplicado, una disputa entre comprador y vendedor— va a una persona. No
 * porque el modelo sea malo, sino porque una respuesta equivocada ahí no es una
 * molestia: es plata de alguien.
 *
 * Y hay algo peor que equivocarse: **prometer**. Un asistente que dice "ya te
 * devolvemos la plata" crea una expectativa que después el equipo tiene que
 * romper, y quien la recibió tiene razón en enojarse. La escalada no es una
 * limitación técnica, es la política.
 *
 * ─── Por qué es un módulo puro ───
 *
 * Estas reglas se van a discutir, y cuando se discutan hay que poder leerlas
 * enteras en una pantalla y probarlas sin base de datos. Enterradas dentro de
 * un servicio, la respuesta a "¿en qué casos escala?" sería leer trescientas
 * líneas de consultas.
 */

/**
 * Categorías donde SIEMPRE va una persona, sin importar qué diga el mensaje.
 *
 * No es una lista de "temas difíciles": es la lista de temas donde una
 * respuesta automática puede costar plata.
 */
export const CATEGORIAS_QUE_SIEMPRE_ESCALAN: readonly SupportCategory[] = [
  'PAGOS',
  'DISPUTA',
] as const;

/**
 * Palabras que disparan escalada aunque la categoría no la exija.
 *
 * ─── Por qué una lista de palabras y no un clasificador ───
 *
 * Porque el costo de los dos errores no es simétrico. Escalar de más cuesta
 * unos minutos del equipo; no escalar cuando hacía falta puede costar un
 * reclamo formal. Con esa asimetría, una lista tosca que se equivoca hacia el
 * lado seguro le gana a un modelo que acierta más pero falla en los dos
 * sentidos.
 *
 * Cuando haya volumen real y se pueda medir, esto se reemplaza. Hoy no hay
 * datos para entrenar nada, y una heurística honesta es mejor que una
 * sofisticada inventada.
 *
 * Sin acentos y en minúsculas: se comparan contra el texto normalizado.
 */
const PALABRAS_QUE_ESCALAN = [
  // Plata
  'reembolso',
  'devolucion del dinero',
  'devuelvan la plata',
  'me cobraron',
  'cobro duplicado',
  'doble cobro',
  'no me acreditaron',
  'estafa',
  'fraude',
  'robo',
  // Vías formales
  'defensa del consumidor',
  'abogado',
  'demanda',
  'denuncia',
  'reclamo formal',
  // Personas en problemas
  'amenaza',
  'acoso',
  'me insulto',
  'datos personales',
];

export type MotivoDeEscalada =
  | 'categoria_sensible'
  | 'palabra_sensible'
  | 'sin_respuesta_automatica'
  | 'lo_pidio_la_persona'
  | 'demasiadas_vueltas';

/**
 * Después de esto va una persona, conteste lo que conteste el asistente.
 *
 * Cuatro idas y vueltas. Si en cuatro respuestas automáticas el problema no se
 * resolvió, no se va a resolver en la quinta: lo que hay es alguien cada vez
 * más frustrado hablándole a una máquina.
 */
export const MAX_VUELTAS_AUTOMATICAS = 4;

export interface DecisionDeEscalada {
  escalar: boolean;
  motivo?: MotivoDeEscalada;
  /** Lo que se le dice a la persona al escalar. */
  aviso?: string;
}

/**
 * Quita acentos y baja a minúsculas, para comparar texto escrito a mano.
 *
 * "Devolución", "devolucion" y "DEVOLUCIÓN" son la misma palabra para alguien
 * que escribe desde el teléfono. Comparar sin normalizar haría que la escalada
 * dependa de si la persona usó el teclado con acentos.
 */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * ¿Este mensaje tiene que ir a una persona?
 *
 * Se evalúa ANTES de generar cualquier respuesta automática. Un asistente que
 * primero contesta y después escala ya dijo algo que no debía.
 */
export function decidirEscalada(params: {
  categoria: SupportCategory;
  mensaje: string;
  /** Cuántas veces ya contestó el asistente en este ticket. */
  vueltasPrevias: number;
}): DecisionDeEscalada {
  if (CATEGORIAS_QUE_SIEMPRE_ESCALAN.includes(params.categoria)) {
    return {
      escalar: true,
      motivo: 'categoria_sensible',
      aviso:
        'Esto lo tiene que ver una persona del equipo. Ya le pasamos tu consulta ' +
        'y te vamos a responder por acá.',
    };
  }

  const texto = normalizar(params.mensaje);

  if (PALABRAS_QUE_ESCALAN.some((p) => texto.includes(p))) {
    return {
      escalar: true,
      motivo: 'palabra_sensible',
      aviso:
        'Por lo que contás, prefiero que lo vea una persona del equipo. ' +
        'Ya le pasamos tu consulta.',
    };
  }

  /**
   * Pedir hablar con una persona SIEMPRE se respeta.
   *
   * Sin excepciones y sin intentar convencer a nadie de que la máquina puede
   * resolverlo. Un asistente que insiste después de que le pidieron un humano
   * es la peor experiencia de soporte que existe, y encima suele terminar en el
   * humano igual, con la persona ya enojada.
   */
  if (
    texto.includes('hablar con una persona') ||
    texto.includes('hablar con alguien') ||
    texto.includes('atencion humana') ||
    texto.includes('un humano') ||
    texto.includes('una persona real')
  ) {
    return {
      escalar: true,
      motivo: 'lo_pidio_la_persona',
      aviso: 'Listo, le paso tu consulta a alguien del equipo.',
    };
  }

  if (params.vueltasPrevias >= MAX_VUELTAS_AUTOMATICAS) {
    return {
      escalar: true,
      motivo: 'demasiadas_vueltas',
      aviso:
        'No estoy pudiendo resolverlo. Le paso tu consulta a una persona del equipo.',
    };
  }

  return { escalar: false };
}

/**
 * Lo que el asistente NO puede decir nunca.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES UNA RED, NO LA DEFENSA PRINCIPAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La defensa principal es que las categorías de plata ni llegan al asistente.
 * Esto atrapa lo que se escape: una respuesta que promete algo que no podemos
 * cumplir, en un ticket que parecía inofensivo.
 *
 * Si dispara, la respuesta NO se manda y el ticket escala. Es preferible que
 * alguien espere veinte minutos a que reciba una promesa que después hay que
 * romper.
 */
const PROMESAS_PROHIBIDAS = [
  'te devolvemos',
  'te vamos a devolver',
  'te reintegramos',
  'ya te acreditamos',
  'cancelo tu pedido',
  'cancele tu pedido',
  'ya lo cancele',
  'te doy un cupon',
  'te damos un descuento',
  'garantizo',
  'te aseguro que',
];

export function respuestaProhibida(respuesta: string): boolean {
  const texto = normalizar(respuesta);
  return PROMESAS_PROHIBIDAS.some((p) => texto.includes(p));
}

/**
 * La categoría que se le sugiere a la persona, mirando lo que escribió.
 *
 * Es una **sugerencia**: la persona la puede cambiar en la app. Adivinar mal y
 * no dejar corregir sería mandarle una consulta de pagos al flujo equivocado.
 *
 * El orden importa: se comprueba primero lo que escala, para que un mensaje que
 * habla de un envío Y de un cobro caiga del lado seguro.
 */
export function sugerirCategoria(mensaje: string): SupportCategory {
  const t = normalizar(mensaje);

  const tiene = (...palabras: string[]) => palabras.some((p) => t.includes(p));

  // Primero lo que escala. Un mensaje ambiguo va al lado seguro.
  if (tiene('cobr', 'pago', 'plata', 'dinero', 'tarjeta', 'acredit', 'reembolso')) {
    return 'PAGOS';
  }
  if (tiene('estafa', 'fraude', 'no me responde', 'vendedor no', 'comprador no')) {
    return 'DISPUTA';
  }

  if (tiene('envio', 'llego', 'llega', 'correo', 'paquete', 'entrega', 'demora')) {
    return 'ENVIO';
  }
  if (tiene('cambio', 'cambiar', 'devolver', 'talle', 'arrepent')) return 'CAMBIOS';
  if (tiene('entrar', 'contrasena', 'clave', 'sesion', 'cuenta', 'borrar mi')) {
    return 'CUENTA';
  }
  if (tiene('vender', 'vivo', 'publicar', 'producto', 'tienda', 'comision')) {
    return 'VENDEDOR';
  }
  if (tiene('error', 'no funciona', 'se cierra', 'se cuelga', 'pantalla')) {
    return 'PROBLEMA_TECNICO';
  }

  return 'OTRO';
}
