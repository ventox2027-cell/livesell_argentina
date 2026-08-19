/**
 * Encuentra productos duplicados por el bug del editor. NO borra nada.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ BUG DEJÓ ESTOS DATOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `_esNuevo` miraba `widget.productoId`, que no cambia nunca. Después de crear
 * un producto el editor NO se cierra —hay que poder subirle las fotos— así que
 * volver a tocar «Guardar cambios» llamaba otra vez a `crearProducto`.
 *
 * El resultado son pares de filas casi idénticas: mismo vendedor, mismo
 * nombre, creadas con segundos de diferencia. Suele quedar una publicada y la
 * otra en borrador, según cuál se publicó después.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO NO BORRA SOLO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos productos con el mismo nombre son legítimos: un vendedor puede tener dos
 * «Buzo negro» y no le corresponde al sistema decidir que se equivocó. Para la
 * base son dos filas válidas — es justamente por eso que la defensa real es la
 * clave de idempotencia y no un detector de parecidos.
 *
 * O sea que esto es una HEURÍSTICA sobre datos de un vendedor real. Se imprime
 * y decide una persona.
 *
 *   pnpm tsx scripts/duplicados-de-producto.ts              # sólo lista
 *   pnpm tsx scripts/duplicados-de-producto.ts --aplicar    # archiva
 *
 * ⚠️ `--aplicar` ARCHIVA, no borra: `status = ARCHIVED` y `deletedAt`. La fila
 * sigue existiendo, y con ella cualquier orden que la referencie. Un producto
 * que se vendió no se puede borrar sin romper el historial del comprador.
 */
import { PrismaClient, type ProductStatus } from '@prisma/client';

/**
 * ⚠️ La URL se toma explícitamente y se IMPRIME enmascarada antes de tocar
 * nada.
 *
 * No es decoración. El `.env` de este repositorio se inyecta con
 * `override: true` y apunta a Neon: un comando que parecía correr contra la
 * base local terminó aplicando una migración en producción. Un script que
 * puede archivar productos de un vendedor real tiene que decir en voz alta
 * dónde está parado antes de empezar.
 */
const URL_DE_LA_BASE = process.env.DATABASE_URL ?? '';
const prisma = new PrismaClient({ datasources: { db: { url: URL_DE_LA_BASE } } });
const APLICAR = process.argv.includes('--aplicar');

function dondeEstoy(): string {
  const sinCredenciales = URL_DE_LA_BASE.replace(/:\/\/[^@]*@/, '://***@');
  return sinCredenciales || '(sin DATABASE_URL)';
}

/** Cuánto tiempo entre dos altas las hace sospechosas de ser la misma. */
const MINUTOS_DE_CERCANIA = 30;

interface Candidato {
  readonly id: string;
  readonly name: string;
  readonly status: ProductStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly storeId: string;
  readonly imagenes: number;
  readonly ordenes: number;
  readonly stock: number;
}

/**
 * El nombre, normalizado para comparar.
 *
 * Mayúsculas, acentos y espacios de más no hacen a dos productos distintos, y
 * el vendedor que reintenta suele reescribir el nombre igual pero no idéntico.
 */
function normalizar(nombre: string): string {
  return nombre
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Cuál se conserva de un grupo.
 *
 * El orden de las reglas importa y cada una tiene su motivo:
 *
 *   1. **El que tiene ventas.** Innegociable. Archivar un producto vendido
 *      rompe el historial del comprador.
 *   2. **El publicado** sobre el borrador. Es el que la gente ve; archivar ése
 *      le sacaría el producto de la vidriera al vendedor.
 *   3. **El que tiene stock cargado.** Alguien se tomó el trabajo.
 *   4. **El que tiene fotos.**
 *   5. **El más viejo.** Es el original; los duplicados son los reintentos.
 */
function elegirCualQueda(grupo: Candidato[]): Candidato {
  const puntaje = (p: Candidato) =>
    (p.ordenes > 0 ? 10_000 : 0) +
    (p.status === 'ACTIVE' ? 1_000 : 0) +
    (p.stock > 0 ? 100 : 0) +
    p.imagenes * 10;

  return [...grupo].sort((a, b) => {
    const d = puntaje(b) - puntaje(a);
    if (d !== 0) return d;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0]!;
}

function motivoDeArchivar(p: Candidato, queda: Candidato): string {
  if (p.status === 'DRAFT' && queda.status === 'ACTIVE') {
    return 'borrador duplicado de uno publicado';
  }
  if (p.imagenes === 0 && queda.imagenes > 0) return 'sin fotos; el que queda las tiene';
  if (p.stock === 0 && queda.stock > 0) return 'sin stock; el que queda lo tiene';
  return 'copia posterior del mismo producto';
}

async function main() {
  console.log(`Base: ${dondeEstoy()}`);
  console.log(APLICAR ? 'Modo: APLICAR' : 'Modo: solo listar');

  const productos = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      storeId: true,
      _count: { select: { images: true } },
      variants: { select: { inventory: { select: { onHand: true } } } },
    },
  });

  /**
   * Las ventas se cuentan aparte, y no es un rodeo.
   *
   * `OrderItem` guarda `productId` pero NO tiene relación con `Product`: son
   * fotos del momento de la compra, a propósito, para que una orden sobreviva
   * a que el producto se borre. O sea que Prisma no puede contarlas con un
   * `_count` — hay que preguntarlas por separado.
   *
   * Y hay que preguntarlas: es el dato que decide qué NO se puede archivar.
   */
  const ventas = await prisma.orderItem.groupBy({
    by: ['productId'],
    _count: { _all: true },
  });
  const ventasPorProducto = new Map(ventas.map((v) => [v.productId, v._count._all]));

  const candidatos: Candidato[] = productos.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt,
    storeId: p.storeId,
    imagenes: p._count.images,
    ordenes: ventasPorProducto.get(p.id) ?? 0,
    stock: p.variants.reduce((a, v) => a + (v.inventory?.onHand ?? 0), 0),
  }));

  // Agrupados por tienda + nombre normalizado.
  const grupos = new Map<string, Candidato[]>();
  for (const p of candidatos) {
    const clave = `${p.storeId}::${normalizar(p.name)}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), p]);
  }

  /**
   * ⚠️ Se agrupa por CERCANÍA EN EL TIEMPO, no se filtra el grupo entero.
   *
   * La primera versión descartaba cualquier grupo cuyo primero y último
   * estuvieran a más de media hora. Con eso, un vendedor que en marzo cargó
   * «Buzo negro» y hoy lo duplicó tres veces no aparecía: el grupo abarcaba
   * cuatro meses y quedaba afuera entero.
   *
   * Se probó sembrando exactamente ese caso —tres duplicados de hoy más uno
   * legítimo de hace un mes— y el detector no encontró nada.
   *
   * Ahora se ordena por fecha y se corta cada vez que hay un salto grande. El
   * de marzo queda solo —y por lo tanto ignorado— y los tres de hoy forman su
   * propio grupo, que es el que interesa.
   */
  const sospechosos: Candidato[][] = [];
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;

    const porFecha = [...grupo].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let racha: Candidato[] = [porFecha[0]!];

    for (const p of porFecha.slice(1)) {
      const salto = p.createdAt.getTime() - racha[racha.length - 1]!.createdAt.getTime();
      if (salto <= MINUTOS_DE_CERCANIA * 60_000) {
        racha.push(p);
      } else {
        if (racha.length >= 2) sospechosos.push(racha);
        racha = [p];
      }
    }
    if (racha.length >= 2) sospechosos.push(racha);
  }

  if (sospechosos.length === 0) {
    console.log('✓ No se encontraron duplicados con esta heurística.');
    console.log(`  (${candidatos.length} productos revisados)`);
    return;
  }

  console.log(`\nSe revisaron ${candidatos.length} productos.`);
  console.log(`Grupos sospechosos: ${sospechosos.length}\n`);
  console.log(APLICAR ? '⚠️  MODO APLICAR: se va a archivar.\n' : 'Modo LISTA. No se toca nada.\n');

  const aArchivar: Array<{ p: Candidato; motivo: string }> = [];

  for (const grupo of sospechosos) {
    const queda = elegirCualQueda(grupo);
    const tienda = grupo[0]!.storeId;

    console.log('─'.repeat(78));
    console.log(`Tienda ${tienda} · «${grupo[0]!.name}»`);

    for (const p of [...grupo].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const esElQueQueda = p.id === queda.id;
      const detalle =
        `status=${p.status} fotos=${p.imagenes} stock=${p.stock} ventas=${p.ordenes} ` +
        `creado=${p.createdAt.toISOString()}`;

      if (esElQueQueda) {
        console.log(`  CONSERVAR  ${p.id}  ${detalle}`);
      } else if (p.ordenes > 0) {
        /**
         * Un duplicado que YA SE VENDIÓ no se archiva, y no es un detalle
         * menor: significa que las dos filas tienen historia real y que
         * fusionarlas es una decisión de negocio, no de limpieza.
         */
        console.log(`  ⚠️  REVISAR  ${p.id}  ${detalle}`);
        console.log('              tiene ventas: NO se propone archivar');
      } else {
        const motivo = motivoDeArchivar(p, queda);
        console.log(`  ARCHIVAR   ${p.id}  ${detalle}`);
        console.log(`              motivo: ${motivo}`);
        aArchivar.push({ p, motivo });
      }
    }
  }

  console.log('─'.repeat(78));
  console.log(`\nResumen: ${aArchivar.length} productos propuestos para archivar.`);

  if (!APLICAR) {
    console.log('\nNada se modificó. Para aplicarlo:');
    console.log('  pnpm tsx scripts/duplicados-de-producto.ts --aplicar\n');
    return;
  }

  for (const { p, motivo } of aArchivar) {
    await prisma.product.update({
      where: { id: p.id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });
    console.log(`  archivado ${p.id} (${motivo})`);
  }
  console.log(`\n✓ ${aArchivar.length} archivados. Ninguna fila se borró.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
