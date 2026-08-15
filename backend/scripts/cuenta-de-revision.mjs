/**
 * Crea (o actualiza) la cuenta de revisión de Google Play.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ES UN SCRIPT Y NO UN ENDPOINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isDemoAccount` es lo único que habilita el login con contraseña. Si existiera
 * una ruta HTTP que la escribe, esa ruta sería la forma de convertir cualquier
 * cuenta en una con contraseña — y todo el aislamiento se caería por ahí.
 *
 * No hay ningún endpoint que toque esa columna. Sólo esto, que requiere acceso
 * al servidor y a la base.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA CONTRASEÑA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Se pasa por la variable `REVIEW_ACCOUNT_PASSWORD`, sólo para esta invocación:
 *
 *     REVIEW_ACCOUNT_PASSWORD='...' node scripts/cuenta-de-revision.mjs
 *
 * ⛔ NO se imprime nunca, ni entera ni recortada, ni su largo. Lo único que sale
 * por pantalla es "contraseña: actualizada".
 *
 * ⚠️ En PowerShell y en bash, el comando queda en el historial del shell.
 * Después de correrlo conviene limpiarlo, o poner un espacio delante del
 * comando si el shell está configurado para ignorar esas líneas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ DEJA ARMADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · el usuario, mayor de edad, con la marca de demostración;
 *   · el perfil de vendedor en ACTIVE;
 *   · la tienda, abierta, con envío a precio fijo;
 *   · tres productos publicados con stock;
 *   · una dirección de entrega, para poder comprar.
 *
 * Es idempotente: correrlo dos veces no duplica nada. Sirve para rotar la
 * contraseña sin tocar el resto.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes, scrypt } from 'node:crypto';

const EMAIL = process.env.REVIEW_ACCOUNT_EMAIL ?? 'review@vendox.com.ar';
const CONTRASENA = process.env.REVIEW_ACCOUNT_PASSWORD;
const LARGO_MINIMO = 12;

const prisma = new PrismaClient();

/** Mismo formato y parámetros que `shared/crypto/contrasenas.ts`. */
function hashear(contrasena) {
  return new Promise((resolver, rechazar) => {
    const sal = randomBytes(16);
    scrypt(
      contrasena.normalize('NFKC'),
      sal,
      64,
      { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, clave) => {
        if (err) return rechazar(err);
        resolver(`scrypt$1$${sal.toString('base64url')}$${clave.toString('base64url')}`);
      },
    );
  });
}

/** ULID falso pero con la forma correcta. Los ids del proyecto son `pre_<ulid>`. */
function id(prefijo) {
  const alfabeto = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let cuerpo = '';
  for (const b of randomBytes(26)) cuerpo += alfabeto[b % 32];
  return `${prefijo}_${cuerpo}`;
}

const PRODUCTOS = [
  {
    nombre: 'Vela aromática de lavanda',
    slug: 'demo-vela-aromatica-de-lavanda',
    descripcion: 'Cera de soja, mecha de algodón. Dura unas 40 horas. Hecha a mano.',
    precio: 850_000,
    stock: 25,
  },
  {
    nombre: 'Buzo oversize de algodón',
    slug: 'demo-buzo-oversize-de-algodon',
    descripcion: 'Algodón peinado 100%. Tejido a mano en Buenos Aires.',
    precio: 3_200_000,
    stock: 12,
  },
  {
    nombre: 'Muñeca de tela artesanal',
    slug: 'demo-muneca-de-tela-artesanal',
    descripcion: 'Relleno hipoalergénico, bordada a mano. Apta desde los 3 años.',
    precio: 1_450_000,
    stock: 8,
  },
];

async function main() {
  if (!CONTRASENA) {
    console.error(
      '\n⛔ Falta REVIEW_ACCOUNT_PASSWORD.\n\n' +
        "    REVIEW_ACCOUNT_PASSWORD='...' node scripts/cuenta-de-revision.mjs\n",
    );
    process.exit(1);
  }
  if (CONTRASENA.trim().length < LARGO_MINIMO) {
    // Se dice el mínimo, nunca lo que se recibió.
    console.error(`\n⛔ La contraseña tiene que tener al menos ${LARGO_MINIMO} caracteres.\n`);
    process.exit(1);
  }

  const email = EMAIL.trim().toLowerCase();
  const passwordHash = await hashear(CONTRASENA);

  const usuario = await prisma.user.upsert({
    where: { email },
    create: {
      id: id('usr'),
      email,
      emailVerified: true,
      firstName: 'Revisión',
      lastName: 'Google Play',
      role: 'seller',
      status: 'active',
      isDemoAccount: true,
      passwordHash,
      // VendoX es 18+. Una fecha declarada, como la de cualquier cuenta.
      birthDate: new Date(Date.UTC(1990, 0, 1)),
      birthDateDeclaredAt: new Date(),
    },
    update: {
      // Al reejecutar sólo se rota la contraseña y se reafirma la marca.
      passwordHash,
      isDemoAccount: true,
      status: 'active',
      deletedAt: null,
    },
  });

  console.log('usuario:', usuario.id);
  console.log('contraseña: actualizada');

  // ─── Vendedor ──────────────────────────────────────────────────────────────

  let seller = await prisma.seller.findUnique({ where: { userId: usuario.id } });
  if (!seller) {
    seller = await prisma.seller.create({
      data: {
        id: id('sel'),
        userId: usuario.id,
        displayName: 'Tienda de demostración',
        slug: 'tienda-de-demostracion',
        bio: 'Tienda de ejemplo para la revisión de la app. Los productos no se venden.',
        status: 'ACTIVE',
      },
    });
  } else {
    seller = await prisma.seller.update({
      where: { id: seller.id },
      data: { status: 'ACTIVE' },
    });
  }
  console.log('vendedor:', seller.id, '· estado ACTIVE');

  // ─── Tienda ────────────────────────────────────────────────────────────────

  let store = await prisma.store.findFirst({ where: { sellerId: seller.id, isPrimary: true } });
  if (!store) {
    store = await prisma.store.create({
      data: {
        id: id('sto'),
        sellerId: seller.id,
        name: 'Tienda de demostración',
        slug: 'tienda-de-demostracion',
        isPrimary: true,
        shippingMode: 'FIXED_OR_PICKUP',
        shippingFlatAmount: 250_000,
        shippingNote: 'Envíos los martes y jueves. Retiro por Palermo.',
      },
    });
  }
  console.log('tienda:', store.id);

  // ─── Productos ─────────────────────────────────────────────────────────────

  for (const p of PRODUCTOS) {
    const existente = await prisma.product.findFirst({
      where: { storeId: store.id, name: p.nombre },
      include: { variants: true },
    });
    /**
     * ⚠️ Se comprueba que tenga VARIANTE, no sólo que el producto exista.
     *
     * Si una corrida anterior se cortó en el medio —pasó: el esquema sumó
     * campos obligatorios y el script quedó viejo— quedó un producto sin
     * variante y sin inventario. Con un `if (existente)` a secas, ese producto
     * se saltea para siempre y la tienda de demostración queda con algo que no
     * se puede comprar. Justo lo que el revisor va a tocar primero.
     */
    if (existente && existente.variants.length > 0) {
      console.log('producto ya estaba:', p.nombre);
      continue;
    }

    if (existente) {
      // A medio crear. Se borra y se rehace entero: es más simple que
      // adivinar qué le falta, y no hay datos que preservar.
      await prisma.product.delete({ where: { id: existente.id } });
      console.log('producto a medias, se rehace:', p.nombre);
    }

    const producto = await prisma.product.create({
      data: {
        id: id('prd'),
        storeId: store.id,
        name: p.nombre,
        /**
         * El slug se arma acá y no se deja al servicio.
         *
         * Este script escribe directo en la base —no pasa por la API— porque
         * la API exige un vendedor autenticado y esto corre sin sesión. El
         * costo de eso es que hay que replicar los campos obligatorios, y este
         * es uno: `Product.slug` se volvió requerido y el script quedó viejo.
         */
        slug: p.slug,
        description: p.descripcion,
        basePriceCents: p.precio,
        /**
         * Publicar exige rubro desde el bloque de categorías. `cat_otros`
         * existe en la semilla y es el que usa el resto del sistema cuando no
         * se eligió otro.
         */
        categoryId: 'cat_otros',
        status: 'ACTIVE',
      },
    });

    const variante = await prisma.productVariant.create({
      data: {
        id: id('var'),
        productId: producto.id,
        storeId: store.id,
        title: 'Único',
        position: 0,
        isDefault: true,
        /**
         * La clave de la variante interna, la misma que usa `variants.ts`
         * cuando el producto no tiene opciones. Es lo que hace que el índice
         * único por (producto, combinación) funcione.
         */
        optionsKey: '__default__',
      },
    });

    await prisma.inventory.create({
      data: { id: id('inv'), productVariantId: variante.id, onHand: p.stock, reserved: 0 },
    });

    console.log('producto creado:', p.nombre);
  }

  // ─── Dirección, para poder comprar ─────────────────────────────────────────

  const direccion = await prisma.userAddress.findFirst({ where: { userId: usuario.id } });
  if (!direccion) {
    await prisma.userAddress.create({
      data: {
        id: id('adr'),
        userId: usuario.id,
        recipientFullName: 'Revisión Google Play',
        documentType: 'DNI',
        documentNumber: '30000000',
        phoneE164: '+5491100000000',
        street: 'Av. de Mayo',
        number: '1000',
        city: 'CABA',
        province: 'Buenos Aires',
        postalCode: 'C1084',
        isDefault: true,
      },
    });
    console.log('dirección de entrega: creada');
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Listo. Para que el login funcione hace falta:');
  console.log('  DEMO_LOGIN_ENABLED=true   en el .env del servidor');
  console.log('');
  console.log('Publicar y transmitir YA funcionan: la cuenta queda marcada como');
  console.log('de demostración y por eso está exenta de conectar Mercado Pago.');
  console.log('La regla sigue vigente para todos los demás vendedores.');
  console.log('');
  console.log('⚠️  Esta cuenta NO puede cobrar. Es a propósito: no hay cuenta');
  console.log('    destino, así que no puede mover un peso real.');
  console.log('─────────────────────────────────────────────\n');
}

main()
  .catch((e) => {
    // El mensaje del error puede venir de Prisma y no lleva la contraseña.
    console.error('\n⛔', e.message, '\n');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
