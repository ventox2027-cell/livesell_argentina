/**
 * Aplica las migraciones a la base de PRUEBAS.
 *
 * Existe como script y no como una variable de entorno en línea porque
 * `DATABASE_URL=... prisma migrate deploy` no funciona en PowerShell, y la
 * alternativa —exportarla en la terminal— deja la variable pegada a la sesión.
 * Más de una vez eso terminó corriendo migraciones de prueba contra la base de
 * desarrollo.
 *
 *   pnpm test:db:migrate
 */
import { spawnSync } from 'node:child_process';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://livesell:livesell@127.0.0.1:5433/livesell_test?schema=public';

if (!TEST_DATABASE_URL.includes('_test')) {
  console.error(
    `✖ TEST_DATABASE_URL debe apuntar a una base *_test. Recibido: ${TEST_DATABASE_URL}`,
  );
  process.exit(1);
}

console.log(`→ migrando ${TEST_DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);

/**
 * ⚠️ `DIRECT_URL` también, y esto no es redundante.
 *
 * Desde que el esquema declara `directUrl`, **`prisma migrate deploy` usa esa
 * variable y no `DATABASE_URL`**. Pisar sólo la primera dejaba a Prisma
 * migrando contra lo que hubiera en `DIRECT_URL`, que en el `.env` local apunta
 * a la base de DESARROLLO.
 *
 * O sea: este script decía "migrando livesell_test", respondía "no hay
 * migraciones pendientes", y le aplicaba las migraciones a la base equivocada.
 * Es precisamente el accidente que la nota de arriba dice que ya pasó una vez,
 * reaparecido por otra puerta.
 *
 * Se descubrió cuando los tests de integración fallaron con "la columna
 * `reason` no existe" justo después de que este script informara éxito.
 */
const result = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    DIRECT_URL: TEST_DATABASE_URL,
  },
});

process.exit(result.status ?? 1);
