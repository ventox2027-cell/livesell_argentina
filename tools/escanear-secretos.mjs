#!/usr/bin/env node
/**
 * Busca secretos donde no tienen que estar.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TRES LUGARES, TRES RIESGOS DISTINTOS
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   · **el repositorio** — un secreto commiteado no se borra: queda en el
 *     historial de git para siempre, y en cada copia que alguien clonó;
 *   · **la APK** — un APK se descomprime con un doble clic. Todo lo que esté
 *     adentro es público, aunque esté "escondido" en un binario;
 *   · **el bundle del admin** — cualquier variable de Next que no empiece con
 *     `NEXT_PUBLIC_` se queda en el servidor, pero una que sí empiece así
 *     termina en el JavaScript que descarga el navegador.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * QUÉ BUSCA
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Formatos concretos, no la palabra "password". Buscar palabras da cientos de
 * falsos positivos —cada comentario que menciona una contraseña— y un escáner
 * que grita siempre es un escáner que nadie mira.
 *
 * Uso:
 *   node tools/escanear-secretos.mjs
 *   node tools/escanear-secretos.mjs --apk mobile/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
 *   node tools/escanear-secretos.mjs --bundle admin/.next
 *
 * Sale con 1 si encuentra algo. Sirve para un hook de pre-commit o para CI.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CONTROL POSITIVO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un escáner que dice "sin hallazgos" no prueba nada hasta que se lo ve
 * encontrar algo. Para verificar que la parte de la APK funciona:
 *
 *   flutter build apk --release --target-platform android-arm64 \
 *     --dart-define=API_BASE_URL=https://AKIAIOSFODNN7EXAMPLE.vendox.com.ar
 *   node tools/escanear-secretos.mjs --apk .../app-release.apk
 *
 * Tiene que reportar «Clave de acceso de AWS» dentro de `libapp.so`.
 *
 * ⚠️ La constante inyectada tiene que ser una que la app USE. Con
 * `--dart-define=SPIKE_API_KEY=…` el escáner no encuentra nada, y no porque
 * falle: el compilador elimina la constante porque en release nada la lee —
 * las pantallas del spike están detrás de `Entorno.herramientas`. Eso es una
 * buena noticia sobre la APK y un mal control positivo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const RAIZ = process.cwd();

/**
 * Los patrones.
 *
 * `descripcion` sale en el informe: un hallazgo que dice `/APP_USR-[\w-]{20,}/`
 * obliga a quien lo lee a descifrar la expresión regular para entender qué
 * encontró.
 */
const PATRONES = [
  {
    nombre: 'Token de Mercado Pago (producción)',
    re: /APP_USR-\d{6,}-\d{6}-[0-9a-f]{32}-\d{6,}/g,
    descripcion: 'Cobra plata real. Rotarlo YA en el panel de Mercado Pago.',
  },
  {
    nombre: 'Token de Mercado Pago (prueba)',
    re: /TEST-\d{6,}-\d{6}-[0-9a-f]{32}-\d{6,}/g,
    descripcion: 'No cobra plata real, pero no va en el repositorio.',
  },
  {
    nombre: 'Clave privada PEM',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    descripcion: 'Cuenta de servicio, certificado o clave SSH.',
  },
  {
    nombre: 'Clave de acceso de AWS',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    descripcion: 'También aplica a Cloudflare R2, que usa la API de S3.',
  },
  {
    nombre: 'Secreto de LiveKit',
    re: /\bAPI[A-Za-z0-9]{10,}\s*[:=]\s*['"][A-Za-z0-9+/]{30,}['"]/g,
    descripcion: 'Con esto se emiten tokens de sala sin pasar por el backend.',
  },
  {
    nombre: 'JWT con contenido',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    descripcion: 'Un token de sesión real. Puede seguir siendo válido.',
  },
  {
    /**
     * ⚠️ Excluye localhost, 127.0.0.1 y 10.0.2.2 dentro del propio patrón.
     *
     * La primera versión los marcaba y produjo veinte hallazgos, todos la
     * misma línea de configuración de tests
     * (`postgresql://livesell:livesell@localhost:5433/livesell_test`). Nada de
     * eso es un secreto: es la base de Docker que cualquiera levanta con el
     * README, y sirve exactamente en la máquina de quien la corre.
     *
     * Y un escáner con veinte falsos positivos es un escáner que se ignora, y
     * entonces el día que aparezca uno de verdad va a estar en el medio de esa
     * lista.
     */
    nombre: 'Cadena de conexión con contraseña',
    re: /\b(?:postgres|postgresql|redis|mongodb)(?:\+srv)?:\/\/[^\s:@'"]+:[^\s@'"]{6,}@(?!localhost|127\.0\.0\.1|10\.0\.2\.2|\$\{)/g,
    descripcion: 'Usuario y contraseña de una base de datos remota.',
  },
  {
    nombre: 'Clave de API de Google',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    descripcion: 'Verificar si tiene restricciones de aplicación y de API.',
  },
];

/**
 * Qué NO se mira.
 *
 * `.env.example` y este mismo archivo están adentro a propósito: uno tiene
 * valores de mentira con la forma correcta —esa es su función— y el otro tiene
 * las expresiones regulares que reconocen esas formas. Sin excluirlos, el
 * escáner se denuncia a sí mismo en cada corrida.
 */
const IGNORAR_CARPETAS = new Set([
  'node_modules', '.git', '.dart_tool', 'build', 'dist', '.next', 'coverage',
  '.gradle', 'Pods', '.idea', '.vscode', 'ephemeral', 'generated',
]);

const IGNORAR_ARCHIVOS = new Set([
  'escanear-secretos.mjs',
  '.env.example',
  'pnpm-lock.yaml',
  'package-lock.json',
  'pubspec.lock',
]);

const EXTENSIONES = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.dart', '.json', '.yaml',
  '.yml', '.md', '.sql', '.sh', '.ps1', '.xml', '.gradle', '.kts', '.properties',
  '.html', '.css', '.txt', '.env',
]);

const hallazgos = [];

/**
 * La marca para decir "esto está bien".
 *
 * Va en la línea del hallazgo o en la anterior:
 *
 *   const CLAVE_FALSA = '-----BEGIN PRIVATE KEY-----…'; // escaner:ok fixture
 *
 * Existe porque hay lugares donde la forma de un secreto es exactamente lo que
 * se está probando: el test que verifica que los logs tachan un token de
 * Mercado Pago necesita un token con forma de token.
 *
 * Es explícita y visible en el diff, a diferencia de una lista de exclusiones
 * en este archivo — que crece, nadie revisa, y termina tapando algo real.
 */
const MARCA_OK = /escaner:ok/;

function revisar(texto, origen) {
  const lineas = texto.split('\n');

  for (const p of PATRONES) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(texto)) !== null) {
      const nro = texto.slice(0, m.index).split('\n').length;

      /**
       * Se miran las tres líneas anteriores, no sólo una.
       *
       * Un valor largo suele estar partido —`const CLAVE =` en una línea y el
       * literal en la siguiente— y el comentario queda arriba de la
       * declaración, a dos o tres líneas del texto que dispara el patrón.
       *
       * Con una sola línea de margen, el marcador no servía justo en el caso
       * para el que existe.
       */
      const cerca = lineas.slice(Math.max(0, nro - 4), nro).join('\n');
      if (MARCA_OK.test(cerca)) continue;

      // Sólo los primeros ocho caracteres. Un escáner que imprime el secreto
      // completo lo copia a la consola, al historial de la terminal y al log
      // de CI — o sea que lo filtra otra vez, mientras avisa que se filtró.
      hallazgos.push({
        origen,
        linea: nro,
        patron: p.nombre,
        descripcion: p.descripcion,
        muestra: `${m[0].slice(0, 8)}…`,
      });
    }
  }
}

/**
 * Los archivos que git conoce.
 *
 * ⚠️ Ese es el conjunto que importa, y no "los archivos del disco".
 *
 * Un secreto commiteado no se borra: queda en el historial y en cada copia que
 * alguien clonó. Uno que está sólo en el disco de una persona —el `.env`, la
 * credencial de Firebase que vive fuera del repositorio— no se filtró a ningún
 * lado.
 *
 * Recorrer el disco además marcaba `backend/.env` en cada corrida, que es el
 * archivo donde los secretos TIENEN que estar. Un hallazgo permanente en el
 * lugar correcto entrena a ignorar el escáner.
 *
 * Lo que sí se verifica aparte es que ese archivo no esté versionado.
 */
function archivosDeGit() {
  const salida = execFileSync('git', ['ls-files', '-z'], {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 64e6,
  });
  return salida.split('\0').filter(Boolean);
}

function recorrer() {
  for (const rel of archivosDeGit()) {
    const partes = rel.split('/');
    if (partes.some((p) => IGNORAR_CARPETAS.has(p))) continue;

    const nombre = partes[partes.length - 1];
    if (IGNORAR_ARCHIVOS.has(nombre)) continue;

    const ext = extname(nombre);
    const esEnv = nombre.startsWith('.env');
    if (!esEnv && !EXTENSIONES.has(ext)) continue;

    const ruta = join(RAIZ, rel);
    let info;
    try {
      info = statSync(ruta);
    } catch {
      continue; // borrado pero todavía en el índice
    }

    // Un archivo de más de 2 MB no es código fuente.
    if (info.size > 2 * 1024 * 1024) continue;

    revisar(readFileSync(ruta, 'utf8'), rel);
  }
}

/**
 * ⛔ Ningún `.env` puede estar versionado.
 *
 * Es la comprobación más importante de todo el archivo y no depende de ningún
 * patrón: no importa qué tenga adentro hoy, un `.env` en git es un `.env` que
 * mañana va a tener un secreto y nadie se va a dar cuenta.
 */
function revisarEnvVersionados() {
  for (const rel of archivosDeGit()) {
    const nombre = rel.split('/').pop() ?? '';
    // `.env.example`, `.env.staging.example`: plantillas con `USER:PASS` y
    // huecos para completar. Versionarlas es lo correcto — son la
    // documentación de qué variables hacen falta.
    if (!nombre.startsWith('.env') || nombre.endsWith('.example')) continue;

    hallazgos.push({
      origen: rel,
      linea: 0,
      patron: 'Archivo .env versionado',
      descripcion:
        'Sacarlo del índice con `git rm --cached` y agregarlo a .gitignore. ' +
        'Si ya se commiteó, además hay que rotar todo lo que tenga adentro.',
      muestra: '(el archivo entero)',
    });
  }
}

/**
 * La APK.
 *
 * ⚠️ Se descomprime antes de mirar. El código Dart compilado viaja en
 * `lib/<abi>/libapp.so` y está comprimido dentro del zip: buscar sobre los
 * bytes crudos de la APK no encuentra absolutamente nada y da una sensación de
 * seguridad falsa.
 */
function revisarApk(ruta) {
  if (!existsSync(ruta)) {
    console.error(`No existe: ${ruta}`);
    process.exit(2);
  }

  const listado = execFileSync('unzip', ['-Z1', ruta], { encoding: 'utf8', maxBuffer: 64e6 })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Los recursos y el binario de Dart. Las imágenes no.
  const interesantes = listado.filter(
    (e) =>
      e.endsWith('libapp.so') ||
      e.endsWith('.so') ||
      e.endsWith('.json') ||
      e.endsWith('.xml') ||
      e.endsWith('.properties') ||
      e.startsWith('assets/'),
  );

  console.log(`  ${interesantes.length} entradas a revisar dentro de la APK`);

  for (const entrada of interesantes) {
    let contenido;
    try {
      contenido = execFileSync('unzip', ['-p', ruta, entrada], { maxBuffer: 256e6 });
    } catch {
      continue;
    }
    // `latin1` y no `utf8`: un binario tiene bytes que no son UTF-8 válido y
    // `utf8` los reemplaza por U+FFFD, partiendo cadenas que sí querríamos ver.
    revisar(contenido.toString('latin1'), `apk:${entrada}`);
  }
}

/**
 * El JavaScript que descarga el navegador del panel de administración.
 *
 * ⚠️ En Next, `NEXT_PUBLIC_*` significa "esto se hornea en el bundle del
 * cliente". Es una convención de nombre, no un candado: alcanza con que
 * alguien bautice `NEXT_PUBLIC_MP_TOKEN` a una variable para que el token
 * termine en un `.js` que sirve cualquier navegador.
 *
 * Se revisan sólo los chunks del cliente: `.next/server/` corre en el servidor
 * y ahí las variables de entorno están donde corresponde.
 */
function revisarBundle(dir) {
  const estaticos = join(dir, 'static');
  if (!existsSync(estaticos)) {
    console.error(`No existe: ${estaticos} — ¿falta correr el build?`);
    process.exit(2);
  }

  let n = 0;
  const recorrerDir = (d) => {
    for (const nombre of readdirSync(d)) {
      const ruta = join(d, nombre);
      const info = statSync(ruta);
      if (info.isDirectory()) {
        recorrerDir(ruta);
        continue;
      }
      if (!/\.(js|json|css|map)$/.test(nombre)) continue;
      n++;
      revisar(readFileSync(ruta, 'utf8'), `bundle:${relative(dir, ruta)}`);
    }
  };
  recorrerDir(estaticos);

  console.log(`  ${n} archivos del cliente revisados`);
}

// ─── Ejecución ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const iApk = args.indexOf('--apk');
const iBundle = args.indexOf('--bundle');

console.log('Escaneando lo que git tiene versionado…');
recorrer();
revisarEnvVersionados();

if (iApk !== -1 && args[iApk + 1]) {
  console.log(`Escaneando ${args[iApk + 1]}…`);
  revisarApk(args[iApk + 1]);
}

if (iBundle !== -1 && args[iBundle + 1]) {
  console.log(`Escaneando ${args[iBundle + 1]}…`);
  revisarBundle(args[iBundle + 1]);
}

console.log('');

if (hallazgos.length === 0) {
  console.log('✓ Sin hallazgos.');
  process.exit(0);
}

console.log(`⛔ ${hallazgos.length} hallazgo(s):\n`);
for (const h of hallazgos) {
  console.log(`  ${h.origen}:${h.linea}`);
  console.log(`    ${h.patron} — ${h.muestra}`);
  console.log(`    ${h.descripcion}\n`);
}
process.exit(1);
