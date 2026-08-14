/**
 * Convierte un usuario EXISTENTE en administrador.
 *
 *   npm run admin:create -- persona@ejemplo.com
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES UN SCRIPT Y NO UN ENDPOINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No existe `POST /admin/register`, y no debe existir nunca.
 *
 * Un endpoint que otorga el rol más poderoso del sistema es un objetivo
 * permanente: alcanza con un descuido en su autorización —o con la primera
 * llamada, si se dejó abierto "hasta crear el primer admin"— para que
 * cualquiera se vuelva administrador. El clásico es dejarlo abierto el primer
 * día y olvidarse.
 *
 * Un script exige acceso al servidor y a las credenciales de la base. Quien ya
 * los tiene podría cambiar el rol con un UPDATE de todas formas; lo que cambia
 * es que **no hay superficie expuesta a internet**.
 *
 * ─── Sobre un usuario existente ───
 *
 * No crea cuentas ni contraseñas. La persona entra primero por Google o Apple
 * como cualquiera, y recién ahí se le da el rol. Así no hay ninguna credencial
 * inventada por nosotros dando vueltas, y su identidad la verifica el
 * proveedor.
 *
 * Jamás un `admin/admin`.
 */
import { PrismaClient } from '@prisma/client';

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const FIN = '\x1b[0m';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error(`\n${ROJO}Falta el email.${FIN}\n`);
    console.error('  npm run admin:create -- persona@ejemplo.com\n');
    console.error(`${GRIS}  La persona tiene que haber iniciado sesión al menos una vez.${FIN}\n`);
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const usuario = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, deletedAt: true },
    });

    if (!usuario) {
      console.error(`\n${ROJO}No hay ningún usuario con ese email.${FIN}\n`);
      console.error('  Que inicie sesión en la app una vez y volvé a correr esto.\n');
      process.exit(1);
    }

    if (usuario.deletedAt) {
      console.error(`\n${ROJO}Esa cuenta está eliminada.${FIN}\n`);
      process.exit(1);
    }

    if (usuario.status !== 'active') {
      // El guard rechaza cuentas no activas, así que darle el rol no serviría
      // de nada y dejaría un admin fantasma en la base.
      console.error(`\n${ROJO}Esa cuenta está en estado "${usuario.status}".${FIN}`);
      console.error('  Reactivala antes de darle el rol.\n');
      process.exit(1);
    }

    if (usuario.role === 'admin') {
      console.log(`\n${AMARILLO}Ya era administrador.${FIN}\n`);
      process.exit(0);
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: usuario.id }, data: { role: 'admin' } });

      /**
       * Queda auditado, con actor `system`.
       *
       * Otorgar el rol de administrador es la acción más sensible que existe:
       * tiene que dejar rastro aunque la haya hecho alguien con acceso al
       * servidor. Si un día aparece un admin que nadie recuerda haber creado,
       * la bitácora dice cuándo y desde qué rol venía.
       */
      await tx.auditLog.create({
        data: {
          id: `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
          action: 'admin.role_granted',
          entityType: 'user',
          entityId: usuario.id,
          actorType: 'system',
          actorId: null,
          reason: 'otorgado con el script admin:create desde el servidor',
          before: { role: usuario.role },
          after: { role: 'admin' },
        },
      });
    });

    console.log(`\n${VERDE}✓${FIN} ${usuario.firstName} ${usuario.lastName} ya es administrador.`);
    console.log(`${GRIS}  ${usuario.email} · rol anterior: ${usuario.role}${FIN}`);
    console.log(
      `${GRIS}  El cambio es inmediato: el guard lee el rol de la base en cada petición.${FIN}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error('\nfalló:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
