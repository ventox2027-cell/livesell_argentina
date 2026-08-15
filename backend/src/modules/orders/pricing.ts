/**
 * Aritmética del dinero de una orden.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN SOLO LUGAR CALCULA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que tenga que ver con totales, comisiones y neto del vendedor sale
 * de acá. Ni el controlador, ni el servicio, ni Flutter hacen su propia
 * cuenta.
 *
 * El motivo no es elegancia: es que **tres lugares que calculan lo mismo
 * terminan calculando cosas distintas**. Y cuando los números difieren, el que
 * ve el comprador y el que se le cobra no coinciden. Ese es el tipo de defecto
 * que se descubre por un reclamo, no por un test.
 *
 * ─── Enteros, siempre ───
 *
 * Nada de coma flotante en ningún paso. `0.1 + 0.2` no es `0.3`, y sobre miles
 * de órdenes esa diferencia se acumula hasta hacerse visible en la
 * conciliación bancaria. Todo son centavos enteros.
 *
 * ─── El porcentaje va en puntos básicos ───
 *
 * 600 bps = 6,00 %. Permite expresar 6,5 % (650) o 7,25 % (725) sin decimales
 * y sin la trampa de que `0.06` no es exactamente seis centésimos en binario.
 */

/** Comisión de VendoX, en puntos básicos. 600 = 6 %. */
export const BPS_POR_UNIDAD = 10_000;

export interface EntradaDePrecio {
  unitPrice: number;
  quantity: number;
  shippingAmount?: number;
  discountAmount?: number;
  /**
   * Recargo por el medio de pago, cuando el vendedor decide trasladarlo.
   *
   * Campo propio y no sumado al envío: el checkout muestra una línea por
   * concepto, y meterlo adentro haría que el comprador viera un costo de envío
   * más alto que el que el vendedor cobra.
   */
  processorSurchargeAmount?: number;
  /** El vigente al crear la orden. Se guarda como foto. */
  platformFeeBps: number;
}

export interface Precio {
  itemsSubtotal: number;
  shippingAmount: number;
  discountAmount: number;
  processorSurchargeAmount: number;
  /** Lo que paga el comprador. */
  grossAmount: number;
  platformFeeBps: number;
  platformFeeAmount: number;
  /** Lo que le queda al vendedor antes de que el proveedor informe su costo. */
  sellerNetAmount: number;
}

/**
 * Redondeo de la comisión: medio hacia arriba, con enteros puros.
 *
 * ─── Por qué no `Math.round(subtotal * bps / 10000)` ───
 *
 * Esa versión divide en coma flotante antes de redondear, y en los bordes da
 * resultados distintos según el valor. `Math.floor((a * b + mitad) / divisor)`
 * hace la misma cuenta sin salir nunca de los enteros.
 *
 * El producto más grande posible acá es 10⁹ centavos × 5000 bps = 5×10¹², muy
 * por debajo del entero seguro de JavaScript (9×10¹⁵). No hay desbordamiento
 * posible con importes reales.
 *
 * ─── Por qué medio hacia arriba y no bancario ───
 *
 * El redondeo bancario reparte mejor el sesgo a lo largo de muchas
 * operaciones, pero es contraintuitivo cuando alguien revisa una orden sola:
 * 2,5 → 2 sorprende. Con volúmenes de marketplace, la diferencia entre los dos
 * es de centavos al mes. Se elige el que se puede explicar por teléfono.
 */
export function porcentajeDe(monto: number, bps: number): number {
  const mitad = Math.floor(BPS_POR_UNIDAD / 2);
  return Math.floor((monto * bps + mitad) / BPS_POR_UNIDAD);
}

/**
 * Sobre cuánto se cobra la comisión.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SOBRE LO QUE SE PAGÓ, NO SOBRE LO QUE DECÍA LA ETIQUETA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El 6 % sale del subtotal de productos **menos el descuento**. Un vendedor que
 * pone un cupón de $3.000 en una compra de $10.000 cobra $7.000, y la comisión
 * es $420 y no $600.
 *
 * Cobrar sobre el precio de lista sería quedarse con parte del descuento: el
 * vendedor puso la plata para atraer una venta y VendoX le cobraría por un
 * ingreso que no tuvo. Sobre descuentos grandes la comisión efectiva se dispara
 * —un 50 % de descuento la duplica— y el vendedor deja de hacer promociones.
 *
 * ⚠️ El piso en cero no es defensivo por gusto: `verificarCoherencia` permite
 * que el descuento cubra también el envío, así que puede superar el subtotal de
 * productos. Sin el piso, la comisión sería negativa y VendoX le estaría
 * pagando al vendedor por vender.
 */
export function baseDeComision(itemsSubtotal: number, discountAmount: number): number {
  return Math.max(0, itemsSubtotal - discountAmount);
}

/**
 * Calcula todos los importes de una orden.
 *
 * ─── Sobre qué se cobra la comisión ───
 *
 * Sólo sobre el **subtotal de productos**. No sobre el envío: ese dinero no es
 * ganancia del vendedor, es el costo de mandar el paquete, y cobrarle comisión
 * sería cobrarle por gastar. Tampoco sobre los descuentos financiados por
 * fuera, porque no existen todavía y estimarlos sería inventar.
 *
 * La comisión de Mercado Pago **no se mezcla acá**. Es un costo distinto, lo
 * informa el proveedor después del cobro, y hoy lo absorbe el vendedor. Se
 * guarda aparte cuando llega.
 */
export function calcularPrecio(entrada: EntradaDePrecio): Precio {
  const shippingAmount = entrada.shippingAmount ?? 0;
  const discountAmount = entrada.discountAmount ?? 0;
  const processorSurchargeAmount = entrada.processorSurchargeAmount ?? 0;

  const itemsSubtotal = entrada.unitPrice * entrada.quantity;
  const grossAmount = itemsSubtotal + shippingAmount + processorSurchargeAmount - discountAmount;

  /**
   * ⚠️ Sobre el subtotal de PRODUCTOS **ya descontado**. No sobre el bruto.
   *
   * Lo del descuento está explicado en `baseDeComision`. Lo que sigue es por
   * qué el envío y el recargo quedan afuera.
   *
   * VendoX cobra 6 % sobre lo que se vendió, no sobre lo que se movió:
   *
   *   · el envío es plata que el vendedor cobra y le entrega a un tercero para
   *     despachar el paquete. No es ingreso suyo, y cobrarle comisión sobre eso
   *     sería cobrarle por gastar;
   *   · el recargo del procesador existe justamente para cubrir lo que Mercado
   *     Pago le va a descontar. Un 6 % encima haría que trasladar el costo le
   *     siga saliendo plata, que es lo contrario de para qué existe.
   *
   * Es DISTINTO del costo del procesador, cuya base sí es producto + envío
   * (ver `baseDelCostoDeProcesador`): esa base la define Mercado Pago, que
   * cobra sobre todo lo que pasa por él. Esta la definimos nosotros.
   *
   * Cambiar esta línea no corrige un cálculo: cambia el modelo de negocio.
   * `orders-flow.spec.ts` tiene un test que lo dice explícitamente.
   */
  const platformFeeAmount = porcentajeDe(baseDeComision(itemsSubtotal, discountAmount), entrada.platformFeeBps);

  return {
    itemsSubtotal,
    shippingAmount,
    discountAmount,
    processorSurchargeAmount,
    grossAmount,
    platformFeeBps: entrada.platformFeeBps,
    platformFeeAmount,
    // El envío se le devuelve al vendedor entero: lo pagó el comprador para
    // que él despache. Y el costo del procesador todavía no se conoce.
    sellerNetAmount: grossAmount - platformFeeAmount,
  };
}

/**
 * Recalcula el neto cuando el proveedor informa cuánto cobró.
 *
 * Se hace aparte y no dentro de `calcularPrecio` porque este dato llega
 * DESPUÉS —a veces días después— y no puede formar parte del cálculo inicial.
 * Mezclarlos obligaría a inventar una estimación, y una estimación guardada en
 * la misma columna que un dato real es indistinguible de un dato real seis
 * meses más tarde.
 */
export function netoConCostoDeProcesador(precio: Precio, processorFee: number): number {
  return precio.grossAmount - precio.platformFeeAmount - processorFee;
}

/**
 * Comprueba que los números de una orden cierren.
 *
 * La base tiene las mismas comprobaciones como CHECK. Esta versión existe para
 * poder fallar con un mensaje que diga QUÉ no cierra, en vez de un error de
 * restricción con el nombre del índice.
 */
export function verificarCoherencia(p: Precio): { ok: true } | { ok: false; motivo: string } {
  if (p.itemsSubtotal < 0) return { ok: false, motivo: 'el subtotal es negativo' };
  if (p.shippingAmount < 0) return { ok: false, motivo: 'el envío es negativo' };
  if (p.discountAmount < 0) return { ok: false, motivo: 'el descuento es negativo' };
  if (p.processorSurchargeAmount < 0) {
    return { ok: false, motivo: 'el recargo del medio de pago es negativo' };
  }

  if (p.discountAmount > p.itemsSubtotal + p.shippingAmount) {
    return { ok: false, motivo: 'el descuento supera el total' };
  }
  if (
    p.grossAmount !==
    p.itemsSubtotal + p.shippingAmount + p.processorSurchargeAmount - p.discountAmount
  ) {
    return { ok: false, motivo: 'el total no coincide con sus partes' };
  }
  if (p.platformFeeAmount > p.grossAmount) {
    return { ok: false, motivo: 'la comisión supera el total cobrado' };
  }
  if (p.platformFeeBps < 0 || p.platformFeeBps > 5_000) {
    return { ok: false, motivo: 'el porcentaje de comisión está fuera de rango' };
  }
  if (p.sellerNetAmount !== p.grossAmount - p.platformFeeAmount) {
    return { ok: false, motivo: 'el neto del vendedor no coincide' };
  }

  return { ok: true };
}

/**
 * Referencia corta de una orden, para hablar con soporte.
 *
 * Ocho caracteres de un alfabeto sin `0/O`, `1/I/L` ni `5/S`: los que se
 * confunden dictando por teléfono, que es exactamente cuando se usa este
 * número. Con 26⁸ combinaciones y un índice único que resuelve las colisiones,
 * la probabilidad de chocar es irrelevante para el volumen que vamos a tener.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';

export function referenciaDeOrden(aleatorio: () => number = Math.random): string {
  let salida = '';
  for (let i = 0; i < 8; i += 1) {
    salida += ALFABETO[Math.floor(aleatorio() * ALFABETO.length)];
  }
  return salida;
}

/** Centavos → unidades, que es como los quiere Mercado Pago. */
export function centavosAMonto(centavos: number): number {
  return Math.round(centavos) / 100;
}

/**
 * Unidades → centavos.
 *
 * `Math.round` y no `Math.trunc`: `1500.00` puede volver de un JSON como
 * `1499.9999999999998`, y truncar convertiría $1500 en $1499,99.
 */
export function montoACentavos(monto: number): number {
  return Math.round(monto * 100);
}
