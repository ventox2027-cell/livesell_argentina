/**
 * Servidor mínimo para instalar el APK en los celulares SIN cable de datos.
 *
 *   node tools/serve-apk.js
 *
 * Levanta un servidor en la red local que sirve los APK compilados. Se abre la
 * URL en el navegador del celular, se descarga y se instala. No hace falta
 * adb, ni cable, ni subir 30 MB a la nube.
 *
 * Se apaga con Ctrl+C. No expone nada más que la carpeta de APKs.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 8099;
const APK_DIR = path.resolve(
  __dirname,
  '..',
  'mobile',
  'build',
  'app',
  'outputs',
  'flutter-apk',
);

/** IP de la red local. Descarta las virtuales de WSL y Hyper-V (172.x). */
function lanAddress() {
  const candidates = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  return (
    candidates.find((ip) => ip.startsWith('192.168.')) ??
    candidates.find((ip) => ip.startsWith('10.')) ??
    candidates[0] ??
    'localhost'
  );
}

/**
 * Nombre con el que se descarga el archivo.
 *
 * Flutter emite "app-arm64-v8a-release.apk", que en la carpeta de descargas no
 * dice de qué app es ni de qué versión. Con tres compilaciones encima no hay
 * forma de saber cuál instalar.
 */
function nombreDeDescarga(archivo) {
  const abi = /(arm64-v8a|armeabi-v7a|x86_64)/.exec(archivo)?.[1];
  return abi ? `VendoX-${abi}.apk` : 'VendoX.apk';
}

function listApks() {
  if (!fs.existsSync(APK_DIR)) return [];
  return fs
    .readdirSync(APK_DIR)
    .filter((f) => f.endsWith('.apk'))
    .map((f) => ({
      name: f,
      descarga: nombreDeDescarga(f),
      sizeMb: (fs.statSync(path.join(APK_DIR, f)).size / 1048576).toFixed(1),
      // Fecha de compilación: evita instalar una versión vieja por error.
      hora: fs.statSync(path.join(APK_DIR, f)).mtime.toTimeString().slice(0, 5),
    }));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // El reloj de referencia se sirve por HTTP y no se abre con doble clic:
  // una página `file://` tiene origen `null` y el navegador le bloquea el
  // fetch a /spike/time por CORS. Servido desde acá tiene un origen normal
  // y el backend lo acepta.
  if (url === '/timer' || url === '/timer.html') {
    const html = fs.readFileSync(path.join(__dirname, 'glass-timer.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url === '/') {
    const apks = listApks();
    const rows = apks
      .map((a) => {
        // arm64-v8a es el de prácticamente todos los celulares desde 2018.
        const recommended = a.name.includes('arm64-v8a');
        return `<li>
          <a href="/${a.name}" download="${a.descarga}">${a.descarga}</a>
          <span class="mb">${a.sizeMb} MB · ${a.hora}</span>
          ${recommended ? '<b class="rec">← este</b>' : ''}
        </li>`;
      })
      .join('');

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="es"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Instalar VendoX</title>
      <style>
        body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:24px;line-height:1.6}
        h1{font-size:20px;margin:0 0 4px}
        p{color:#999;font-size:14px;margin:0 0 20px}
        ul{list-style:none;padding:0}
        li{background:#1c1c1c;border:1px solid #333;border-radius:10px;padding:16px;margin-bottom:10px}
        a{color:#4ea8ff;font-size:16px;text-decoration:none;font-weight:600}
        .mb{color:#777;font-size:13px;margin-left:8px}
        .rec{color:#4ade80;font-size:13px;margin-left:8px}
        .note{background:#1a1a2e;border-left:3px solid #4ea8ff;padding:12px;border-radius:6px;font-size:13px;color:#bbb}
      </style></head><body>
      <h1>VendoX</h1>
      <p>Descargá e instalá la app en este celular.</p>
      <ul>${rows || '<li>No hay APKs compilados todavía.</li>'}</ul>
      <p style="margin-top:24px">
        En la <b>notebook</b>, el reloj de referencia:
        <a href="/timer">/timer</a>
      </p>
      <div class="note">
        Android va a pedirte permiso para <b>instalar apps de origen desconocido</b>.
        Es normal: el archivo lo compilaste vos hace un minuto.
        Tocá <b>Configuración</b> → habilitá el permiso para el navegador → <b>Instalar</b>.
      </div>
    </body></html>`);
    return;
  }

  const file = path.join(APK_DIR, path.basename(url));
  // path.basename evita que un `../..` en la URL salga de la carpeta de APKs.
  if (!file.endsWith('.apk') || !fs.existsSync(file)) {
    res.writeHead(404).end('no encontrado');
    return;
  }

  const { size } = fs.statSync(file);
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-length': size,
    'content-disposition': `attachment; filename="${nombreDeDescarga(path.basename(file))}"`,
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  const apks = listApks();

  console.log('\n  Servidor del spike listo\n');
  console.log('  En la NOTEBOOK, el reloj de referencia:');
  console.log(`      http://localhost:${PORT}/timer\n`);
  console.log('  En el CELULAR, para instalar el APK:');
  console.log(`      http://${ip}:${PORT}\n`);
  console.log(`  APKs disponibles (${apks.length}):`);
  for (const a of apks) console.log(`      ${a.name}  ${a.sizeMb} MB`);
  console.log('\n  Ctrl+C para apagar.\n');
});
