/**
 * Comprueba que la credencial de Firebase Admin se pueda cargar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ IMPRIME Y QUÉ NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Imprime `project_id` y el dominio de la cuenta de servicio, que son
 * identificadores públicos del proyecto y aparecen en la consola de Firebase.
 *
 * ⛔ NO imprime la clave privada, ni recortada, ni su largo, ni el contenido
 * del archivo. Este script se corre pegando la salida en un chat o en un
 * ticket; todo lo que salga de acá hay que asumir que se va a compartir.
 *
 *     node scripts/verificar-firebase.cjs
 */
require('dotenv').config({ override: false });

const ruta = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const pushEncendido = !['false', '0', 'no', 'off'].includes(
  String(process.env.PUSH_ENABLED ?? 'true').toLowerCase(),
);

console.log('PUSH_ENABLED:', pushEncendido ? 'true' : 'false');
console.log('FIREBASE_SERVICE_ACCOUNT_PATH:', ruta ? 'present' : 'ausente');

if (!ruta) {
  console.log('\nSin la ruta, los avisos quedan en SKIPPED. En producción el proceso no arranca.');
  process.exit(pushEncendido ? 1 : 0);
}

const { leerCredencialDeFirebase, descripcionSegura } = require('../dist/modules/notifications/credencial-de-firebase.js');

try {
  const credencial = leerCredencialDeFirebase(ruta);
  const publico = descripcionSegura(credencial);

  console.log('\ncredencial: VÁLIDA');
  console.log('  project_id:', publico.projectId);
  console.log('  cuenta de servicio del dominio:', publico.clientEmail.split('@')[1]);
  console.log('  clave privada: presente, formato PEM');
  console.log('\nFirebase Cloud Messaging va a arrancar.');
} catch (err) {
  console.log('\ncredencial: RECHAZADA');
  // El mensaje nombra la ruta y el motivo, nunca el contenido.
  console.log(' ', err.message);
  process.exit(1);
}
