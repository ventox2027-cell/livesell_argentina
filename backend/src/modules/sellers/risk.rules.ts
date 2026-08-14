/**
 * Riesgo de un vendedor: reglas explícitas, con motivos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO HAY UN PUNTAJE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sería fácil sumar señales ponderadas y devolver un 73. Y sería peor.
 *
 * Un número opaco no se puede discutir. Cuando un vendedor pregunte por qué lo
 * limitaron, la respuesta "el sistema le asignó 73" no es una respuesta: no
 * dice qué hizo mal ni qué puede corregir. Y del lado nuestro, nadie va a poder
 * decidir si ese 73 está bien o si la fórmula tiene un peso mal puesto.
 *
 * Acá cada regla que dispara **agrega su motivo a una lista**. El nivel final
 * es la severidad más alta que se haya disparado. Eso da tres propiedades que
 * un puntaje no tiene:
 *
 *   · Se puede explicar: "identidad sin verificar y 3 devoluciones en 30 días".
 *   · Se puede auditar: la lista queda guardada y se ve en el panel.
 *   · Se puede corregir: cada motivo dice qué destrabar.
 *
 * Nada de aprendizaje automático. Con este volumen de datos, un modelo
 * aprendería el ruido de las primeras cien ventas y nadie podría explicar sus
 * decisiones — que además es un requisito legal cuando la decisión afecta el
 * acceso de alguien a trabajar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE ESTE ARCHIVO NO SABE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No consulta la base. Recibe las señales ya medidas y devuelve un veredicto.
 *
 * Es lo que permite probar cada combinación sin montar un vendedor con tres
 * devoluciones y dos suspensiones en PostgreSQL: la parte con reglas es pura, y
 * la parte que consulta es un puñado de `count()` sin decisiones adentro.
 */

export type NivelDeRiesgo = 'LOW' | 'MEDIUM' | 'HIGH';

/** Las señales medibles hoy. Se agregan cuando existan los datos, no antes. */
export interface SenalesDeRiesgo {
  identidadVerificada: boolean;
  telefonoVerificado: boolean;
  cuentaDeCobroConectada: boolean;
  /** Días desde que se creó el vendedor. */
  antiguedadDias: number;
  ordenesCompletadas: number;
  /** Órdenes canceladas por el vendedor en los últimos 30 días. */
  cancelacionesRecientes: number;
  /** Devoluciones en los últimos 30 días. */
  devolucionesRecientes: number;
  /** Cuántas veces se lo suspendió, alguna vez. */
  suspensionesHistoricas: number;
  /** Cambios en datos críticos en los últimos 7 días. */
  cambiosCriticosRecientes: number;
  /** Ventas de los últimos 7 días contra el promedio semanal previo. */
  multiplicadorDeCrecimiento: number | null;
  /** El mismo documento aparece en otra cuenta de vendedor. */
  documentoDuplicado: boolean;
}

export interface Veredicto {
  nivel: NivelDeRiesgo;
  motivos: string[];
}

interface Regla {
  /** Identificador estable. Se guarda en la base y se muestra en el panel. */
  codigo: string;
  nivel: NivelDeRiesgo;
  aplica: (s: SenalesDeRiesgo) => boolean;
  /** En castellano, y diciendo qué destraba el problema cuando se puede. */
  texto: (s: SenalesDeRiesgo) => string;
  /**
   * Si una buena trayectoria puede dejar esta regla de lado.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * LA DISTINCIÓN QUE UN TEST ENCONTRÓ QUE FALTABA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Hay dos clases de señal intermedia y confundirlas esconde fraude:
   *
   *   · **De estado** (`true`): "no verificó el teléfono", "la cuenta es
   *     nueva". Son cosas que el historial efectivamente responde — alguien con
   *     120 ventas limpias demostró ser quien dice más de lo que demostraría
   *     verificando un SMS. Tiene sentido que la trayectoria las supere.
   *
   *   · **De comportamiento** (`false`): "las ventas se multiplicaron por diez
   *     esta semana", "canceló cinco órdenes". Son cosas que **están pasando
   *     ahora**, y la trayectoria no las explica: la explican al revés. Una
   *     cuenta consolidada es exactamente la que más sirve para probar tarjetas
   *     robadas, porque no levanta las otras sospechas.
   *
   * La primera versión no hacía esta distinción y un vendedor con buen
   * historial cuyas ventas se multiplicaban por diez quedaba en riesgo bajo. Lo
   * encontró el test de `crecimiento anormal`.
   */
  superableConHistorial: boolean;
}

/**
 * Umbrales.
 *
 * Salen de acá y no de números sueltos en medio de las condiciones, para que se
 * puedan discutir sin leer código. Están calibrados por criterio, no por datos:
 * todavía no hay historial del que sacarlos, y eso hay que decirlo en vez de
 * fingir que son óptimos.
 *
 * Cuando haya volumen, se revisan contra el resultado real.
 */
export const UMBRALES = {
  /** Debajo de esto, un vendedor no tiene historial que respalde nada. */
  antiguedadMinimaDias: 14,
  ordenesParaConfiar: 10,
  devolucionesAlerta: 3,
  devolucionesGrave: 6,
  cancelacionesAlerta: 5,
  /** Vender diez veces más que la semana pasada no siempre es una buena noticia. */
  crecimientoSospechoso: 10,
} as const;

const REGLAS: Regla[] = [
  // ─── Graves ──────────────────────────────────────────────────────────────

  {
    codigo: 'documento_duplicado',
    nivel: 'HIGH',
    superableConHistorial: false,
    aplica: (s) => s.documentoDuplicado,
    texto: () =>
      'El mismo documento figura en otra cuenta de vendedor. Puede ser una identidad robada o un intento de evadir una suspensión previa.',
  },
  {
    codigo: 'suspendido_antes',
    nivel: 'HIGH',
    superableConHistorial: false,
    aplica: (s) => s.suspensionesHistoricas > 0,
    texto: (s) =>
      `Ya fue suspendido ${s.suspensionesHistoricas} ${s.suspensionesHistoricas === 1 ? 'vez' : 'veces'}.`,
  },
  {
    codigo: 'devoluciones_muchas',
    nivel: 'HIGH',
    superableConHistorial: false,
    aplica: (s) => s.devolucionesRecientes >= UMBRALES.devolucionesGrave,
    texto: (s) => `${s.devolucionesRecientes} devoluciones en los últimos 30 días.`,
  },
  {
    codigo: 'cambio_critico_reciente',
    nivel: 'HIGH',
    superableConHistorial: false,
    aplica: (s) => s.cambiosCriticosRecientes > 0,
    texto: (s) =>
      `Cambió datos críticos ${s.cambiosCriticosRecientes} ${s.cambiosCriticosRecientes === 1 ? 'vez' : 'veces'} en los últimos 7 días (documento, CUIT, teléfono o cuenta de cobro).`,
  },

  // ─── Intermedias ─────────────────────────────────────────────────────────

  {
    codigo: 'identidad_sin_verificar',
    nivel: 'MEDIUM',
    superableConHistorial: true,
    aplica: (s) => !s.identidadVerificada,
    texto: () => 'La identidad no está verificada.',
  },
  {
    codigo: 'sin_cuenta_de_cobro',
    nivel: 'MEDIUM',
    superableConHistorial: true,
    aplica: (s) => !s.cuentaDeCobroConectada,
    texto: () => 'No tiene una cuenta de cobro conectada.',
  },
  {
    codigo: 'telefono_sin_verificar',
    nivel: 'MEDIUM',
    superableConHistorial: true,
    aplica: (s) => !s.telefonoVerificado,
    texto: () => 'El teléfono no está verificado.',
  },
  {
    codigo: 'cuenta_nueva',
    nivel: 'MEDIUM',
    superableConHistorial: true,
    aplica: (s) => s.antiguedadDias < UMBRALES.antiguedadMinimaDias,
    texto: (s) => `La cuenta tiene ${s.antiguedadDias} días.`,
  },
  {
    codigo: 'devoluciones_algunas',
    nivel: 'MEDIUM',
    superableConHistorial: false,
    aplica: (s) =>
      s.devolucionesRecientes >= UMBRALES.devolucionesAlerta &&
      s.devolucionesRecientes < UMBRALES.devolucionesGrave,
    texto: (s) => `${s.devolucionesRecientes} devoluciones en los últimos 30 días.`,
  },
  {
    codigo: 'cancelaciones',
    nivel: 'MEDIUM',
    superableConHistorial: false,
    aplica: (s) => s.cancelacionesRecientes >= UMBRALES.cancelacionesAlerta,
    texto: (s) =>
      `Canceló ${s.cancelacionesRecientes} órdenes en los últimos 30 días. Suele indicar que vende lo que no tiene.`,
  },
  {
    codigo: 'crecimiento_anormal',
    nivel: 'MEDIUM',
    superableConHistorial: false,
    aplica: (s) =>
      s.multiplicadorDeCrecimiento !== null &&
      s.multiplicadorDeCrecimiento >= UMBRALES.crecimientoSospechoso,
    texto: (s) =>
      `Las ventas se multiplicaron por ${Math.round(s.multiplicadorDeCrecimiento ?? 0)} esta semana. Puede ser un vivo que funcionó muy bien, o pruebas de tarjetas robadas.`,
  },
];

/**
 * El veredicto.
 *
 * ─── La severidad más alta gana ───
 *
 * Y no un promedio. Cinco señales intermedias no son peores que un documento
 * duplicado: promediarlas diluiría la única que importa. Cuando algo grave
 * aparece, el nivel es alto aunque todo lo demás esté impecable.
 */
export function evaluarRiesgo(s: SenalesDeRiesgo): Veredicto {
  const disparadas = REGLAS.filter((r) => r.aplica(s));

  const motivos = disparadas.map((r) => `${r.codigo}: ${r.texto(s)}`);

  if (disparadas.some((r) => r.nivel === 'HIGH')) return { nivel: 'HIGH', motivos };

  /**
   * Un vendedor con trayectoria baja a riesgo bajo — pero **sólo si lo que
   * disparó son señales que el historial responde**.
   *
   * Sin esta salida, "cuenta nueva" mantendría a todo el mundo en riesgo medio
   * para siempre, porque nadie deja nunca de haber tenido las señales que tuvo.
   * El historial tiene que poder pesar más que las condiciones iniciales; si no,
   * el sistema no premia portarse bien y la clasificación deja de significar
   * algo.
   *
   * ⚠️ Pero la trayectoria **no tapa señales de comportamiento**. Un vendedor
   * consolidado cuyas ventas se multiplican por diez esta semana sigue en riesgo
   * medio: una cuenta con buen historial es justamente la más útil para probar
   * tarjetas robadas, porque no levanta ninguna de las otras sospechas.
   */
  const soloSenalesDeEstado = disparadas.every((r) => r.superableConHistorial);

  const confiable =
    soloSenalesDeEstado &&
    s.identidadVerificada &&
    s.cuentaDeCobroConectada &&
    s.ordenesCompletadas >= UMBRALES.ordenesParaConfiar;

  if (confiable) {
    return {
      nivel: 'LOW',
      motivos: [
        `trayectoria: identidad verificada, cuenta de cobro conectada y ${s.ordenesCompletadas} ventas completadas.`,
      ],
    };
  }

  if (disparadas.length > 0) return { nivel: 'MEDIUM', motivos };

  // Sin señales y sin trayectoria: medio. No hay información para confiar ni
  // para desconfiar, y ante la duda no se le da el beneficio a alguien que
  // todavía no hizo nada.
  return { nivel: 'MEDIUM', motivos: ['sin_historial: todavía no hay datos suficientes.'] };
}

/**
 * ¿Este vendedor puede vender?
 *
 * ⚠️ **El riesgo NO frena ventas por sí solo.** Un vendedor en riesgo alto
 * puede seguir vendiendo, con límites. Frenar automáticamente por señales
 * indirectas —una cuenta nueva, un crecimiento fuerte— dejaría a gente honesta
 * sin trabajar por un cambio de teléfono.
 *
 * Lo que frena es una decisión humana: `SellerStatus.SUSPENDED` o `BLOCKED`.
 * El riesgo alto pone el caso arriba en el panel para que alguien lo mire.
 */
export function puedeVender(estado: string): boolean {
  return estado === 'ACTIVE' || estado === 'PENDING';
}
