/**
 * VendoX Pro: qué es un plan y qué habilita.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA MEMBRESÍA NO SABE COBRAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Acá no hay Google Play Billing, ni Mercado Pago, ni StoreKit. Este módulo
 * responde una sola pregunta —**¿este vendedor puede hacer esto?**— y la
 * responde mirando un plan y una fecha.
 *
 * Está hecho así a propósito. Cada tienda de aplicaciones tiene sus reglas
 * sobre bienes digitales, y elegir mal significa reescribir el sistema o que te
 * rechacen la app. Mientras la decisión no esté tomada, todo lo que se pueda
 * construir sin ella se construye: las membresías existen, se otorgan a mano, y
 * el día que haya cobro sólo hace falta algo que llame a `otorgar`.
 *
 * Lo que **no** hay que hacer es meter un proveedor acá adentro. Si mañana este
 * archivo tiene un `if (origen === 'GOOGLE_PLAY')`, la separación se perdió.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRO NO ES VERIFICADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Son dos cosas distintas y no se tocan:
 *
 *   · **Verificado** dice que VendoX comprobó quién es esa persona. Se gana
 *     mandando documentación. No se compra.
 *   · **Pro** dice que contrató herramientas. Se paga.
 *
 * Confundirlas convertiría el sello de identidad en algo a la venta, que es
 * exactamente el problema que tuvo Twitter cuando lo hizo. Un vendedor Pro sin
 * verificar no muestra ningún sello de identidad; uno verificado sin Pro no
 * pierde el suyo.
 *
 * Por eso `verificationStatus` vive en `Seller` y el plan vive en su propia
 * tabla, y ninguna función de este archivo mira la otra.
 */

/** Los planes que existen. */
export type Plan = 'FREE' | 'PRO' | 'BUSINESS';

/**
 * Los planes que se pagan.
 *
 * Existe para que nadie escriba `plan !== 'FREE'` por todos lados: el día que
 * haya un cuarto plan, se agrega acá y el resto del archivo no se toca.
 */
export const PLANES_PAGOS = ['PRO', 'BUSINESS'] as const satisfies readonly Plan[];

/** Un plan que se puede otorgar. `FREE` no se otorga: es lo que hay sin nada. */
export type PlanPago = (typeof PLANES_PAGOS)[number];

export function esPago(plan: Plan): boolean {
  return (PLANES_PAGOS as readonly Plan[]).includes(plan);
}

/**
 * Cada cuánto se renueva.
 *
 * Es lo único que se parece a facturación en todo el módulo, y es sólo una
 * duración: cuántos días dura lo que se otorgó. `null` en Free, que no vence.
 */
export type Periodo = 'MENSUAL' | 'ANUAL';

/**
 * De dónde salió la membresía.
 *
 * ⚠️ Ninguno de estos valores nombra un proveedor de pago. `PAGO` significa
 * "alguien pagó por esto", y quién procesó ese pago es problema del módulo que
 * lo haya cobrado — que hoy no existe.
 */
export type OrigenDeMembresia =
  /** El plan de todos. No se otorga: es lo que hay cuando no hay nada. */
  | 'GRATIS'
  /** VendoX se lo dio. Vendedores iniciales, acuerdos, compensaciones. */
  | 'CORTESIA'
  /** Período de prueba. Vence y vuelve a Free sin que nadie haga nada. */
  | 'PRUEBA'
  /** Se pagó. Reservado para cuando exista cobro. */
  | 'PAGO';

/** Cuántos días dura cada período. */
export const DIAS_POR_PERIODO: Record<Periodo, number> = {
  MENSUAL: 30,
  ANUAL: 365,
};

/**
 * Los beneficios, uno por uno.
 *
 * ⚠️ Cada entrada de esta lista tiene que corresponder a algo que **existe en
 * el código**. Una lista de promesas es una lista de reclamos: si acá dice
 * `ANALITICA_AVANZADA` y la pantalla no está, alguien pagó por nada.
 *
 * Cuando se agregue un beneficio nuevo, primero se construye y después se
 * agrega acá.
 */
export type Beneficio =
  /** Crear y administrar cupones de descuento. Ver el módulo de cupones. */
  | 'CUPONES'
  /** El embudo del vivo: vistas, toques, reservas, ventas. */
  | 'ANALITICA_AVANZADA'
  /** La insignia Pro en el perfil. NO es el sello de identidad verificada. */
  | 'INSIGNIA_PRO'
  /**
   * Los tickets de este vendedor van arriba en la bandeja del equipo.
   *
   * Está cableado en `support.service.ts::bandeja()`, no es una promesa: el
   * orden de la bandeja lo mira de verdad. Si alguien saca ese cableado, el
   * beneficio se saca de acá el mismo día.
   */
  | 'SOPORTE_PRIORITARIO'
  /**
   * La comisión baja por tramos según el volumen.
   *
   * Lo aplica `comision-por-volumen.ts`. Acá está para que la pantalla de
   * planes lo pueda mostrar sin saber cómo se calcula.
   */
  | 'COMISION_POR_VOLUMEN';

/**
 * Qué habilita cada plan.
 *
 * ─── Business incluye todo lo de Pro, escrito y no heredado ───
 *
 * Podría ser `[...BENEFICIOS_POR_PLAN.PRO, ...]`. Está enumerado porque la
 * pregunta «¿qué tiene Business?» se tiene que poder responder leyendo una
 * línea, y porque el día que un beneficio de Pro NO deba ir en Business, una
 * herencia implícita lo habría llevado igual sin que nadie lo decidiera.
 *
 * ⚠️ Lo que NO está acá, y por qué:
 *
 *   · **Exportaciones/reportes.** El único export que existe es el de la Ley
 *     25.326 —acceso a los propios datos—, que es un derecho legal, gratuito y
 *     de toda persona. No se puede vender. Ver `exportacion.service.ts`.
 *   · **Más créditos de promoción.** El libro mayor de créditos existe, pero
 *     hoy sólo los otorga un admin a mano: no hay otorgamiento recurrente por
 *     plan. Prometerlo sería vender algo que nadie entrega.
 *   · **Multiusuario, roles, sucursales.** No existen.
 *
 * El catálogo ilimitado no está en esta lista porque no es un sí/no: es un
 * límite, y vive en `LIMITES_POR_PLAN`.
 */
const BENEFICIOS_POR_PLAN: Record<Plan, readonly Beneficio[]> = {
  FREE: [],
  PRO: ['CUPONES', 'ANALITICA_AVANZADA', 'INSIGNIA_PRO'],
  BUSINESS: [
    'CUPONES',
    'ANALITICA_AVANZADA',
    'INSIGNIA_PRO',
    'SOPORTE_PRIORITARIO',
    'COMISION_POR_VOLUMEN',
  ],
};

/**
 * Los límites numéricos.
 *
 * Separados de los beneficios porque un límite no es "sí o no": Free tiene
 * cupones en cero, no "cupones apagados". La diferencia importa para el
 * mensaje que ve el vendedor.
 */
export interface LimitesDelPlan {
  /** Cuántos cupones puede tener activos a la vez. */
  readonly cuponesActivos: number;
  /** Cuántos días de historial ve en las métricas. */
  readonly diasDeHistorial: number;
}

const LIMITES_POR_PLAN: Record<Plan, LimitesDelPlan> = {
  FREE: { cuponesActivos: 0, diasDeHistorial: 30 },
  PRO: { cuponesActivos: 20, diasDeHistorial: 365 },
  /**
   * Dos años de historial, no «infinito».
   *
   * Un número concreto se puede sostener: la consulta tiene un techo conocido y
   * el índice sirve. «Todo» significa que la pantalla de métricas se pone más
   * lenta cada mes que pasa, y el vendedor que más paga es el que primero lo
   * nota.
   */
  BUSINESS: { cuponesActivos: 50, diasDeHistorial: 730 },
};

/** Lo que hay guardado sobre un vendedor. */
export interface MembresiaGuardada {
  readonly plan: Plan;
  /** `null` en Free: no vence. */
  readonly vigenteHasta: Date | null;
}

/**
 * La membresía **de verdad**, resuelta contra el reloj.
 *
 * ⚠️ Nadie debería leer `plan` de la base directamente. Un Pro que venció ayer
 * sigue diciendo `PRO` en su fila hasta que algo la actualice, y ese algo puede
 * tardar: una tarea periódica que se cayó, un despliegue en el medio, o
 * simplemente que decidimos no tener tarea. La verdad es esta función.
 */
export function planVigente(m: MembresiaGuardada | null, ahora: Date = new Date()): Plan {
  if (!m) return 'FREE';
  if (m.plan === 'FREE') return 'FREE';
  // Un plan pago sin fecha sería eterno. No se otorga así, pero si una fila
  // quedara en ese estado, se trata como vencida en vez de como eterna.
  if (!m.vigenteHasta) return 'FREE';
  /**
   * Devuelve `m.plan`, no `'PRO'`.
   *
   * Acá decía `'PRO'` literal, y con dos planes daba lo mismo. Con tres, esa
   * línea le habría dado Pro a todos los Business —silenciosamente, sin error—
   * y el vendedor que paga el plan caro habría perdido su comisión por volumen
   * sin que nada lo registrara.
   */
  return m.vigenteHasta.getTime() > ahora.getTime() ? m.plan : 'FREE';
}

/** Si el plan vigente incluye este beneficio. */
export function tieneBeneficio(
  m: MembresiaGuardada | null,
  beneficio: Beneficio,
  ahora: Date = new Date(),
): boolean {
  return BENEFICIOS_POR_PLAN[planVigente(m, ahora)].includes(beneficio);
}

/** Los límites del plan vigente. */
export function limitesDe(m: MembresiaGuardada | null, ahora: Date = new Date()): LimitesDelPlan {
  return LIMITES_POR_PLAN[planVigente(m, ahora)];
}

/** Todos los beneficios del plan vigente, para mostrárselos al vendedor. */
export function beneficiosDe(
  m: MembresiaGuardada | null,
  ahora: Date = new Date(),
): readonly Beneficio[] {
  return BENEFICIOS_POR_PLAN[planVigente(m, ahora)];
}

/**
 * Cuándo vence algo que se otorga ahora.
 *
 * Si ya tenía Pro vigente, se **suma** al final en vez de reemplazar: alguien
 * que renueva con dos semanas por delante no puede perderlas por renovar
 * temprano.
 */
export function calcularVencimiento(
  periodo: Periodo,
  vigenteHastaActual: Date | null,
  ahora: Date = new Date(),
): Date {
  const dias = DIAS_POR_PERIODO[periodo];
  const arranca =
    vigenteHastaActual && vigenteHastaActual.getTime() > ahora.getTime()
      ? vigenteHastaActual
      : ahora;

  return new Date(arranca.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * Cuánto le queda, en días enteros hacia arriba.
 *
 * Hacia arriba porque "te queda 1 día" con veinte horas por delante es cierto,
 * y "te quedan 0 días" con veinte horas por delante no lo es.
 */
export function diasRestantes(m: MembresiaGuardada | null, ahora: Date = new Date()): number | null {
  // `esPago` y no `!== 'PRO'`: si no, un Business vigente devolvería `null` y
  // nunca se le avisaría que está por vencer.
  if (!esPago(planVigente(m, ahora)) || !m?.vigenteHasta) return null;
  return Math.ceil((m.vigenteHasta.getTime() - ahora.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Si hay que avisarle que está por vencer.
 *
 * Una membresía que se corta sin aviso deja al vendedor con cupones que dejan
 * de funcionar en medio de un vivo.
 */
export const DIAS_DE_AVISO_ANTES_DE_VENCER = 7;

export function tocaAvisarQueVence(m: MembresiaGuardada | null, ahora: Date = new Date()): boolean {
  const dias = diasRestantes(m, ahora);
  return dias !== null && dias <= DIAS_DE_AVISO_ANTES_DE_VENCER;
}
