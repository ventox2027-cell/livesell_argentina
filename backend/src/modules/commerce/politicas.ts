/**
 * Políticas de cambio, devolución y cancelación.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HAY UN PISO QUE EL VENDEDOR NO PUEDE BAJAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En Argentina, una compra hecha a distancia —que es el 100 % de lo que pasa
 * acá— tiene un derecho de arrepentimiento que la ley le da al comprador y que
 * **no depende de lo que el vendedor decida**:
 *
 *   · Ley 24.240 de Defensa del Consumidor, art. 34, y art. 1110 del Código
 *     Civil y Comercial: **diez días corridos** desde la entrega para revocar
 *     la compra, sin expresar causa y sin costo alguno para el comprador.
 *   · Resolución 424/2020 de la Secretaría de Comercio Interior: el "botón de
 *     arrepentimiento" tiene que estar visible y ser fácil de encontrar.
 *   · Ley 24.240, art. 11: garantía legal por defectos.
 *
 * Un vendedor puede ofrecer MÁS —treinta días, cambio sin causa, devolución del
 * envío— pero no menos. "No se aceptan devoluciones" no es una política: es una
 * cláusula nula, y publicarla como si valiera nos hace responsables a nosotros
 * también.
 *
 * Por eso este módulo tiene dos partes: lo que el vendedor elige, y el piso que
 * se agrega SIEMPRE, aunque no lo haya elegido.
 *
 * ⚠️ ESTO NO ES ASESORAMIENTO LEGAL. Los textos que se le muestran al
 * comprador tienen que pasar por un abogado antes de salir a producción. Lo que
 * garantiza el código es que el piso exista y no se pueda configurar por debajo
 * — que es la parte que un formulario mal hecho rompe en silencio.
 *
 * Archivo puro, sin Prisma: son reglas que hay que poder leer y probar sin base
 * de datos.
 */

/**
 * Días corridos del derecho de arrepentimiento. **No configurable a la baja.**
 *
 * Diez, contados desde la entrega. Si el vendedor quiere dar más, se guarda su
 * número; si pone menos, se rechaza con un mensaje que explica por qué.
 */
export const DIAS_DE_ARREPENTIMIENTO_LEGALES = 10;

/**
 * Tope de lo que se puede ofrecer.
 *
 * Un año. No es una restricción legal —ofrecer más es válido— sino de sentido:
 * un número más grande en este campo casi siempre es un cero de más en un
 * formulario, y una tienda que promete devoluciones por diez años es una
 * promesa que no va a cumplir.
 */
export const DIAS_DE_DEVOLUCION_MAXIMOS = 365;

export type ModoDeCambio =
  /** Sólo lo que obliga la ley. */
  | 'SOLO_LEGAL'
  /** Cambia por otro talle o color dentro del plazo. */
  | 'CAMBIO_SIN_CAUSA'
  /** Devuelve la plata dentro del plazo, sin pedir motivo. */
  | 'DEVOLUCION_SIN_CAUSA';

export type QuienPagaElEnvioDeVuelta =
  /** Lo paga el vendedor. Es lo que obliga la ley cuando es arrepentimiento. */
  | 'VENDEDOR'
  /** Lo paga el comprador. Sólo válido para cambios voluntarios. */
  | 'COMPRADOR';

export interface PoliticaDeCambios {
  modo: ModoDeCambio;
  /** Días que ofrece el vendedor. El piso legal se aplica igual. */
  diasParaCambiar: number;
  quienPagaElEnvio: QuienPagaElEnvioDeVuelta;
  /** Texto libre: condiciones, excepciones, cómo coordinarlo. */
  nota: string | null;
}

/**
 * Cuántos días vale de verdad, mirando el piso legal.
 *
 * Nunca menos de diez. Un vendedor que puso tres tiene diez igual, porque es
 * lo que la ley le da al comprador; lo que se rechaza en la carga es que
 * publique tres, no que exista.
 */
export function diasEfectivos(diasElegidos: number): number {
  return Math.max(diasElegidos, DIAS_DE_ARREPENTIMIENTO_LEGALES);
}

/**
 * ¿Esta configuración es publicable?
 *
 * Se valida acá y no sólo con Zod porque el motivo del rechazo tiene que poder
 * explicarse: un "mínimo 10" a secas hace que el vendedor crea que es un
 * capricho nuestro y busque cómo esquivarlo.
 */
export function validarPolitica(
  politica: PoliticaDeCambios,
): { ok: true } | { ok: false; motivo: string } {
  if (!Number.isInteger(politica.diasParaCambiar)) {
    return { ok: false, motivo: 'Los días tienen que ser un número entero' };
  }

  if (politica.diasParaCambiar < DIAS_DE_ARREPENTIMIENTO_LEGALES) {
    return {
      ok: false,
      motivo:
        `En Argentina el comprador tiene ${DIAS_DE_ARREPENTIMIENTO_LEGALES} días corridos ` +
        'para arrepentirse de una compra online, sin dar motivos. No se puede ofrecer menos. ' +
        'Sí podés ofrecer más.',
    };
  }

  if (politica.diasParaCambiar > DIAS_DE_DEVOLUCION_MAXIMOS) {
    return {
      ok: false,
      motivo: `Máximo ${DIAS_DE_DEVOLUCION_MAXIMOS} días. ¿No te sobró un cero?`,
    };
  }

  /**
   * El envío de vuelta del arrepentimiento lo paga el vendedor. Siempre.
   *
   * Art. 34 de la ley 24.240: la revocación es "sin costo alguno" para el
   * comprador. Un vendedor que sólo cumple el mínimo legal no puede declarar
   * que el envío de vuelta lo paga la otra persona, porque eso convierte el
   * derecho en algo que cuesta plata ejercer.
   *
   * Cuando el vendedor ofrece MÁS que el mínimo —cambio de talle porque sí—,
   * ahí sí puede pedir que el envío lo pague quien cambia: eso ya no es
   * arrepentimiento, es un servicio adicional que está regalando.
   */
  if (politica.modo === 'SOLO_LEGAL' && politica.quienPagaElEnvio === 'COMPRADOR') {
    return {
      ok: false,
      motivo:
        'El arrepentimiento es sin costo para el comprador, así que el envío de vuelta lo ' +
        'pagás vos. Si querés que lo pague quien cambia, ofrecé cambios por otro motivo ' +
        'además del arrepentimiento.',
    };
  }

  return { ok: true };
}

/**
 * Lo que se le muestra a quien está por comprar.
 *
 * Se arma acá y no en Flutter para que diga exactamente lo mismo en la app, en
 * el detalle del pedido y en el mail. Tres textos escritos por separado
 * terminan diciendo tres cosas distintas, y la que vale legalmente es la más
 * favorable al comprador — o sea, siempre perdemos.
 */
export function resumenParaElComprador(politica: PoliticaDeCambios): {
  titulo: string;
  lineas: string[];
  /** El texto legal, que va SIEMPRE, elija lo que elija el vendedor. */
  derechoDeArrepentimiento: string;
} {
  const dias = diasEfectivos(politica.diasParaCambiar);
  const lineas: string[] = [];

  switch (politica.modo) {
    case 'SOLO_LEGAL':
      lineas.push('Cambios y devoluciones según lo que establece la ley.');
      break;
    case 'CAMBIO_SIN_CAUSA':
      lineas.push(`Cambio por otro talle o color dentro de los ${dias} días.`);
      break;
    case 'DEVOLUCION_SIN_CAUSA':
      lineas.push(`Devolución del dinero dentro de los ${dias} días, sin dar motivos.`);
      break;
  }

  lineas.push(
    politica.quienPagaElEnvio === 'VENDEDOR'
      ? 'El envío de vuelta lo paga el vendedor.'
      : 'El envío de vuelta lo paga quien cambia.',
  );

  if (politica.nota) lineas.push(politica.nota);

  return {
    titulo: 'Cambios y devoluciones',
    lineas,
    derechoDeArrepentimiento:
      `Tenés ${DIAS_DE_ARREPENTIMIENTO_LEGALES} días corridos desde que recibís el producto ` +
      'para arrepentirte de la compra, sin dar motivos y sin costo. ' +
      'Es un derecho que te da la ley y no depende del vendedor.',
  };
}

/**
 * Hasta cuándo se puede arrepentir de un pedido concreto.
 *
 * Se cuenta desde la ENTREGA, no desde la compra. Es lo que dice la ley y
 * además es lo único que tiene sentido: alguien que compró algo que tarda dos
 * semanas en llegar no puede haber gastado su plazo esperando.
 *
 * Sin fecha de entrega devuelve `null`: el plazo todavía no arrancó, así que no
 * hay fecha límite que mostrar.
 */
export function vencimientoDelArrepentimiento(
  entregadoEl: Date | null,
  diasElegidos: number,
): Date | null {
  if (!entregadoEl) return null;

  const vence = new Date(entregadoEl.getTime());
  vence.setDate(vence.getDate() + diasEfectivos(diasElegidos));
  return vence;
}
