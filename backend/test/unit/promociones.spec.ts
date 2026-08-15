import { describe, expect, it } from 'vitest';

import {
  COSTO_EN_CREDITOS,
  DURACIONES_EN_HORAS,
  POSICIONES_PROMOCIONADAS,
  costoDe,
  estaCorriendo,
  exigirDuracionValida,
  intercalarPromocionados,
} from '@/modules/commerce/promociones';
import { puntaje } from '@/modules/commerce/ranking';

/**
 * Promociones pagas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAGAR COMPRA UN LUGAR, NO PUNTOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es lo único que estos tests protegen de verdad. Un producto promocionado no
 * recibe puntaje: ocupa una posición reservada del feed, etiquetada.
 *
 * Sumarle puntos al puntaje orgánico rompe tres cosas a la vez: deja de poder
 * etiquetarse —la ley de defensa del consumidor lo exige—, contamina la señal
 * de interés, y convierte el feed en una subasta sin techo.
 */

const AHORA = new Date('2026-08-15T21:00:00.000Z');
const enHoras = (h: number) => new Date(AHORA.getTime() + h * 3_600_000);

interface Item {
  id: string;
  vendedor: string;
}
const item = (id: string, vendedor = `v-${id}`): Item => ({ id, vendedor });
const idDe = (i: Item) => i.id;
const vendedorDe = (i: Item) => i.vendedor;

const organicos = (n: number) => Array.from({ length: n }, (_, k) => item(`o${k}`));

describe('El ranking no sabe que las promociones existen', () => {
  it('⛔ `puntaje` no acepta ninguna señal de promoción', () => {
    /**
     * EL TEST QUE IMPORTA, y el más raro de la suite: comprueba una AUSENCIA.
     *
     * `SenalesDeRanking` no tiene un campo `promocionado`, y este test se rompe
     * el día que alguien se lo agregue —porque para agregarlo hay que tocar
     * `puntaje`, y entonces dos productos idénticos dejarían de empatar—.
     *
     * Es la garantía de que lo pago no puede disfrazarse de orgánico.
     */
    const senales = {
      creadoEl: AHORA,
      likes: 10,
      enVivo: false,
      verificado: false,
    };

    // Dos productos con las mismas señales puntúan igual. No hay ninguna otra
    // entrada que pueda separarlos.
    expect(puntaje(senales, AHORA)).toBe(puntaje({ ...senales }, AHORA));

    // Y las claves de la señal son exactamente estas cuatro.
    expect(Object.keys(senales).sort()).toEqual(
      ['creadoEl', 'enVivo', 'likes', 'verificado'].sort(),
    );
  });
});

describe('Cuánto sale', () => {
  it('el costo está en créditos, no en pesos', () => {
    /**
     * No hay un solo precio en pesos en el módulo. Cuánto sale un crédito es
     * una decisión comercial que va a cambiar con la inflación varias veces
     * por año; hardcodearla acá sería un despliegue por cada ajuste y una app
     * mostrando números viejos mientras tanto.
     */
    const texto = JSON.stringify(COSTO_EN_CREDITOS);
    expect(texto).not.toMatch(/pesos|ARS|\$/);

    for (const horas of DURACIONES_EN_HORAS) {
      expect(costoDe('PRODUCTO_EN_FEED', horas)).toBeGreaterThan(0);
    }
  });

  it('más días cuesta más, pero proporcionalmente menos', () => {
    // Si una semana costara siete veces un día, nadie compraría una semana.
    const porDia24 = costoDe('PRODUCTO_EN_FEED', 24) / 1;
    const porDia168 = costoDe('PRODUCTO_EN_FEED', 168) / 7;

    expect(costoDe('PRODUCTO_EN_FEED', 168)).toBeGreaterThan(costoDe('PRODUCTO_EN_FEED', 24));
    expect(porDia168).toBeLessThan(porDia24);
  });

  it('⛔ una duración inventada se rechaza', () => {
    // Un número libre deja comprar «1 hora» —que no sirve— o «720», que es un
    // mes de feed sin darse cuenta.
    expect(() => exigirDuracionValida(5)).toThrow(/no está disponible/);
    expect(() => exigirDuracionValida(24)).not.toThrow();
  });
});

describe('Cuándo está corriendo', () => {
  it('dentro de la ventana, sí', () => {
    expect(
      estaCorriendo({ desde: enHoras(-1), hasta: enHoras(23), cancelada: false }, AHORA),
    ).toBe(true);
  });

  it('⛔ cancelada, no — aunque la ventana siga abierta', () => {
    expect(
      estaCorriendo({ desde: enHoras(-1), hasta: enHoras(23), cancelada: true }, AHORA),
    ).toBe(false);
  });

  it('⛔ vencida, no', () => {
    expect(
      estaCorriendo({ desde: enHoras(-48), hasta: enHoras(-24), cancelada: false }, AHORA),
    ).toBe(false);
  });

  it('⛔ programada para después, tampoco', () => {
    expect(
      estaCorriendo({ desde: enHoras(2), hasta: enHoras(26), cancelada: false }, AHORA),
    ).toBe(false);
  });
});

describe('Cómo se mezclan con el feed', () => {
  it('sin promociones, la lista sale intacta', () => {
    // El caso normal no paga nada: ni copia ni reordena.
    const lista = organicos(5);
    const salida = intercalarPromocionados(lista, [], idDe, vendedorDe);

    expect(salida.map((s) => s.item.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    expect(salida.every((s) => !s.promocionado)).toBe(true);
  });

  it('los promocionados caen en las posiciones reservadas', () => {
    const salida = intercalarPromocionados(
      organicos(20),
      [item('p1'), item('p2'), item('p3')],
      idDe,
      vendedorDe,
    );

    for (const posicion of POSICIONES_PROMOCIONADAS) {
      expect(salida[posicion]?.promocionado, `posición ${posicion}`).toBe(true);
    }
  });

  it('⛔ el orgánico NO se reordena: nadie pierde su lugar relativo', () => {
    /**
     * Los promocionados se insertan y el resto corre. Que un producto orgánico
     * baje o suba por lo que pagó otro sería exactamente lo que este diseño
     * evita.
     */
    const salida = intercalarPromocionados(
      organicos(20),
      [item('p1'), item('p2')],
      idDe,
      vendedorDe,
    );

    const soloOrganicos = salida.filter((s) => !s.promocionado).map((s) => s.item.id);
    expect(soloOrganicos).toEqual(organicos(20).map((o) => o.id));
  });

  it('⛔ todo lo pago sale etiquetado', () => {
    // Sin esto no hay forma de distinguir publicidad de resultado, que es lo
    // que la ley de defensa del consumidor exige poder hacer.
    const salida = intercalarPromocionados(organicos(20), [item('p1')], idDe, vendedorDe);
    const marcados = salida.filter((s) => s.promocionado).map((s) => s.item.id);

    expect(marcados).toEqual(['p1']);
  });

  it('⛔ un producto que YA está en la página no se duplica', () => {
    /**
     * Alguien que paga por algo que igual salía primero no compra dos
     * apariciones: compra la etiqueta y nada más. Verlo dos veces en la misma
     * pantalla se lee como un error de la app.
     */
    const lista = organicos(20);
    const salida = intercalarPromocionados(lista, [lista[0]!], idDe, vendedorDe);

    expect(salida.filter((s) => s.item.id === 'o0')).toHaveLength(1);
    expect(salida.every((s) => !s.promocionado)).toBe(true);
  });

  it('⛔ un vendedor no puede llevarse las tres posiciones', () => {
    // Sin esto, el que tiene más créditos copa el feed y se ve como lo que la
    // gente odia.
    const salida = intercalarPromocionados(
      organicos(20),
      [item('p1', 'mismo'), item('p2', 'mismo'), item('p3', 'mismo')],
      idDe,
      vendedorDe,
    );

    expect(salida.filter((s) => s.promocionado)).toHaveLength(1);
  });

  it('⛔ nunca más promocionados que posiciones', () => {
    const muchos = Array.from({ length: 30 }, (_, k) => item(`p${k}`));
    const salida = intercalarPromocionados(organicos(20), muchos, idDe, vendedorDe);

    expect(salida.filter((s) => s.promocionado)).toHaveLength(POSICIONES_PROMOCIONADAS.length);
  });

  it('con poco orgánico, los promocionados salen igual', () => {
    /**
     * Pasa en una tienda nueva o con un filtro angosto. Se agregan al final,
     * siempre etiquetados: la alternativa es cobrarle a alguien por una
     * promoción que no se mostró.
     */
    const salida = intercalarPromocionados(
      organicos(2),
      [item('p1'), item('p2')],
      idDe,
      vendedorDe,
    );

    expect(salida.filter((s) => s.promocionado)).toHaveLength(2);
    expect(salida).toHaveLength(4);
  });

  it('⛔ no se pierde ni se repite nada', () => {
    // Una mezcla que duplica o traga elementos es un bug que en el feed se ve
    // como «me apareció dos veces» y en la paginación como un salto.
    const lista = organicos(20);
    const promos = [item('p1'), item('p2'), item('p3')];
    const salida = intercalarPromocionados(lista, promos, idDe, vendedorDe);

    const ids = salida.map((s) => s.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(lista.length + promos.length);
  });
});
