/**
 * Comprueba que se pueda migrar, ANTES de intentarlo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ES UN PROCESO APARTE Y NO PARTE DE `main.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque tiene que correr antes de `prisma migrate deploy`, y `main.ts` corre
 * después. Ese orden es todo el problema que esto resuelve: la validación de
 * `DIRECT_URL` ya existía en `env.schema.ts` y nunca llegaba a hablar, porque
 * el despliegue moría diez segundos antes con un error sobre locks.
 *
 * ⚠️ NO importa `env.schema.ts` a propósito. Ese módulo valida la
 * configuración ENTERA y mata el proceso si falta cualquier cosa — LiveKit,
 * Mercado Pago, R2. Acá se responde una sola pregunta, y una respuesta clara a
 * esa pregunta no puede depender de que todo lo demás esté completo.
 *
 * Sale con 0 si se puede migrar y con 1 si no. `arrancar.sh` corre con
 * `set -e`, así que un 1 corta el arranque antes de tocar la base.
 */
/* eslint-disable no-restricted-syntax, no-console --
 *
 * Las dos reglas se cruzan a propósito, y las dos por la misma razón: este
 * archivo NO es parte del servidor.
 *
 *   · `no-restricted-syntax` prohíbe leer `process.env` directo y obliga a usar
 *     `env` de `env.schema.ts`. Es la regla correcta para todo lo demás — pero
 *     importar ese módulo valida la configuración ENTERA y mata el proceso si
 *     falta cualquier cosa. Acá se responde una sola pregunta, antes de migrar,
 *     y esa respuesta no puede depender de que LiveKit o R2 estén completos.
 *
 *   · `no-console` deja sólo `console.error` porque en el servidor se usa el
 *     logger de Nest. Esto corre en `arrancar.sh`, antes de que exista Nest:
 *     su salida es la de un comando de terminal, y va a stdout.
 *
 * Si alguna vez este archivo hace algo más que revisar la conexión, estas dos
 * excepciones dejan de estar justificadas.
 */
import {
  hostSinCredenciales,
  revisarConexionDeMigraciones,
  urlQueUsaMigrate,
} from './config/conexion-de-migraciones';

const url = urlQueUsaMigrate(process.env);
const problema = revisarConexionDeMigraciones(process.env);

/**
 * Se dice el host SIEMPRE, salga bien o mal.
 *
 * Es la línea que permite verificar en los logs contra qué se migró sin
 * exponer nada: sin usuario, sin contraseña, sin la cadena entera. Cuando el
 * despliegue funcione, este renglón es la prueba de que fue por la conexión
 * directa; cuando falle, es la primera pista.
 */
console.log(`→ Las migraciones van a correr contra: ${hostSinCredenciales(url)}`);

if (problema) {
  console.error('\n✖ No se puede migrar por esta conexión.\n');
  console.error(`  ${problema.mensaje}\n`);
  process.exit(1);
}

console.log('→ Es una conexión directa. Adelante.');
