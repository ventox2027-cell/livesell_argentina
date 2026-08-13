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
  'postgresql://livesell:livesell@localhost:5433/livesell_test?schema=public';

if (!TEST_DATABASE_URL.includes('_test')) {
  console.error(
    `✖ TEST_DATABASE_URL debe apuntar a una base *_test. Recibido: ${TEST_DATABASE_URL}`,
  );
  process.exit(1);
}

console.log(`→ migrando ${TEST_DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);

const result = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
});

process.exit(result.status ?? 1);
