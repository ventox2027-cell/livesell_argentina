import { describe, expect, it } from 'vitest';

import {
  DESCUENTO_MAXIMO_PORCENTAJE,
  exigirPrecioDeVivoValido,
  precioDeVivoActivo,
  resolverPrecio,
} from '@/modules/live/precio-de-vivo';

/**
 * El precio exclusivo del vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN DESCUENTO ES UNA PROMESA, NO UNA ETIQUETA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «$12.500 ~~$18.000~~» le dice a alguien que si compra ahora paga menos que si
 * compra mañana. Si eso no es cierto, es publicidad engañosa — y la ley de
 * defensa del consumidor argentina la trata como tal.
 *
 * Estos tests son esa promesa, verificada.
 */

const AHORA = new Date('2026-08-15T21:00:00.000Z');
const enMinutos = (m: number) => new Date(AHORA.getTime() + m * 60_000);

const SIN_PRECIO = { livePriceCents: null, livePriceFrom: null, livePriceUntil: null };

describe('Cuándo está activo', () => {
  it('sin precio de vivo, no', () => {
    expect(precioDeVivoActivo(SIN_PRECIO, AHORA)).toBe(false);
  });

  it('con precio y sin fechas, sí', () => {
    /**
     * Es el caso más común: el vendedor pone un precio para el vivo que está
     * haciendo, y termina cuando termina el vivo — que no es una fecha, es un
     * estado.
     */
    expect(
      precioDeVivoActivo({ ...SIN_PRECIO, livePriceCents: 1000 }, AHORA),
    ).toBe(true);
  });

  it('⛔ antes de que empiece la ventana, no', () => {
    expect(
      precioDeVivoActivo(
        { livePriceCents: 1000, livePriceFrom: enMinutos(30), livePriceUntil: null },
        AHORA,
      ),
    ).toBe(false);
  });

  it('⛔ después de que termina, tampoco', () => {
    // «Esta oferta dura hasta las 22» tiene que cumplirse aunque el vivo siga.
    expect(
      precioDeVivoActivo(
        { livePriceCents: 1000, livePriceFrom: null, livePriceUntil: enMinutos(-1) },
        AHORA,
      ),
    ).toBe(false);
  });
});

describe('Resolver el precio', () => {
  it('sin descuento, se cobra el de lista y no se tacha nada', () => {
    const r = resolverPrecio(1_800_000, SIN_PRECIO, AHORA);

    expect(r.precioCentavos).toBe(1_800_000);
    expect(r.hayDescuento).toBe(false);
    expect(r.porcentaje).toBeNull();
  });

  it('con descuento activo, se cobra el de vivo', () => {
    const r = resolverPrecio(
      1_800_000,
      { livePriceCents: 1_250_000, livePriceFrom: null, livePriceUntil: null },
      AHORA,
    );

    expect(r.precioCentavos).toBe(1_250_000);
    expect(r.precioDeListaCentavos).toBe(1_800_000);
    expect(r.hayDescuento).toBe(true);
    expect(r.porcentaje).toBe(30);
  });

  it('⛔ el porcentaje redondea HACIA ABAJO', () => {
    // Mostrar «-30 %» cuando son 29,7 infla el descuento. Es chico y es
    // exactamente la clase de exageración que la regla de veracidad prohíbe.
    const r = resolverPrecio(
      100_000,
      { livePriceCents: 70_300, livePriceFrom: null, livePriceUntil: null },
      AHORA,
    );
    expect(r.porcentaje).toBe(29);
  });

  it('⛔ fuera de la ventana se cobra el precio NORMAL', () => {
    /**
     * Es la mitad que importa: no alcanza con no mostrar el descuento. Si la
     * oferta venció y se sigue cobrando el precio bajo, el vendedor pierde
     * plata sin enterarse.
     */
    const r = resolverPrecio(
      1_800_000,
      { livePriceCents: 1_250_000, livePriceFrom: null, livePriceUntil: enMinutos(-5) },
      AHORA,
    );

    expect(r.precioCentavos).toBe(1_800_000);
    expect(r.hayDescuento).toBe(false);
  });

  it('⛔ un «descuento» MÁS CARO que el precio real no se aplica', () => {
    /**
     * La tercera capa de defensa, y la que de verdad puede pasar.
     *
     * La base tiene un CHECK y el alta valida, pero el precio de lista **puede
     * bajar después**: un vendedor que pasa el producto de $18.000 a $10.000
     * deja un «precio de vivo» de $12.500 que ya no es un descuento.
     *
     * Sin esta guarda, la app mostraría $12.500 con $10.000 tachado al lado.
     */
    const r = resolverPrecio(
      1_000_000,
      { livePriceCents: 1_250_000, livePriceFrom: null, livePriceUntil: null },
      AHORA,
    );

    expect(r.precioCentavos).toBe(1_000_000);
    expect(r.hayDescuento).toBe(false);
  });

  it('⛔ con precios iguales tampoco hay descuento', () => {
    // Un `<` mal escrito acá mostraría «-0 %» tachando el mismo número.
    const r = resolverPrecio(
      500_000,
      { livePriceCents: 500_000, livePriceFrom: null, livePriceUntil: null },
      AHORA,
    );
    expect(r.hayDescuento).toBe(false);
  });
});

describe('Lo que el vendedor puede cargar', () => {
  it('un descuento razonable se acepta', () => {
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 1_800_000, precioDeVivo: 1_250_000 }),
    ).not.toThrow();
  });

  it('⛔ un precio mayor al normal se rechaza', () => {
    /**
     * El patrón oscuro más viejo del comercio electrónico: mostrar un precio
     * inflado tachado al lado de uno que en realidad es el de siempre.
     */
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 100_000, precioDeVivo: 150_000 }),
    ).toThrow(/menor que el precio normal/);
  });

  it('⛔ igual al normal, también', () => {
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 100_000, precioDeVivo: 100_000 }),
    ).toThrow();
  });

  it('⛔ un cero de más se ataja', () => {
    /**
     * El tope del 90 % no existe para limitar al vendedor: existe porque
     * alguien que quiere poner $1.800 y escribe $180 en un producto de $18.000
     * está a un toque de vender con 99 % de descuento, y para cuando se dé
     * cuenta ya lo compraron treinta personas.
     */
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 1_800_000, precioDeVivo: 18_000 }),
    ).toThrow(/no te haya faltado un cero/);
  });

  it('justo en el tope, entra', () => {
    const lista = 1_000_000;
    const alTope = lista - (lista * DESCUENTO_MAXIMO_PORCENTAJE) / 100;
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: lista, precioDeVivo: alTope }),
    ).not.toThrow();
  });

  it('⛔ por debajo del mínimo de un peso, no', () => {
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 1_000_000, precioDeVivo: 50 }),
    ).toThrow(/mínimo/);
  });

  it('⛔ una ventana invertida se rechaza', () => {
    // Define una ventana vacía: el descuento nunca estaría activo y el vendedor
    // lo vería configurado sin entender por qué no se aplica.
    expect(() =>
      exigirPrecioDeVivoValido({
        precioDeLista: 1_000_000,
        precioDeVivo: 500_000,
        desde: enMinutos(60),
        hasta: enMinutos(10),
      }),
    ).toThrow(/terminar después de empezar/);
  });

  it('⛔ centavos, no pesos con decimales', () => {
    expect(() =>
      exigirPrecioDeVivoValido({ precioDeLista: 1_000_000, precioDeVivo: 5000.5 }),
    ).toThrow(/centavos/);
  });
});
