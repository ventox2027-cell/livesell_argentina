#!/usr/bin/env node
/**
 * Cuánto tarda cada tramo de una petición a VendoX, desde donde se corra.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ HACE FALTA ESTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «La app tarda en conectar la primera vez» no se puede arreglar: no dice cuál
 * de los cinco tramos se lleva el tiempo, y son cosas muy distintas.
 *
 *   · DNS      — resolver api.vendox.com.ar. No depende de nosotros.
 *   · TCP      — un viaje de ida y vuelta hasta el servidor. Es distancia.
 *   · TLS      — dos viajes más, salvo que se reutilice la sesión.
 *   · espera   — el servidor pensando. Es lo único que se arregla con código.
 *   · descarga — el cuerpo de la respuesta.
 *
 * Confundirlos lleva a optimizar consultas cuando el problema era el handshake,
 * o a mover una base de continente cuando el problema era el DNS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE MIDE Y LO QUE NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mide desde ESTA máquina. No es el teléfono de nadie, pero está en la misma
 * red del país, así que la distancia es comparable. Lo que NO mide es el
 * arranque en frío de la app ni el tiempo de Flutter: eso lo dice
 * `TrazaDeArranque` en el propio teléfono.
 *
 * ⚠️ No manda credenciales ni imprime nada que no sea un número. Todos los
 * endpoints que consulta son públicos.
 *
 *     node tools/medir-latencia.mjs
 *     node tools/medir-latencia.mjs --repeticiones 20
 *     node tools/medir-latencia.mjs --base https://3diuvg9x.up.railway.app
 */
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opcion = (nombre, porOmision) => {
  const i = args.indexOf(`--${nombre}`);
  return i === -1 ? porOmision : args[i + 1];
};

const BASE = opcion('base', 'https://api.vendox.com.ar');
const REPETICIONES = Number(opcion('repeticiones', '10'));

/**
 * Los cuatro que separan las causas.
 *
 * `/health` no toca la base: su tiempo es distancia pura más el proceso.
 * `/ready` la toca. La diferencia entre los dos es, exactamente, lo que cuesta
 * el viaje Railway ⇄ Neon.
 */
const RUTAS = [
  { ruta: '/health', que: 'sin base de datos' },
  { ruta: '/ready', que: 'toca base y Redis' },
  { ruta: '/api/v1/categories', que: 'público, cacheado en memoria' },
  { ruta: '/api/v1/discover/products?limit=20', que: 'público, con consultas' },
];

/** Una petición completa, abriendo conexión nueva. Es el caso «primera vez». */
async function medirEnFrio(url) {
  const u = new URL(url);
  const puerto = u.port ? Number(u.port) : 443;

  const t0 = performance.now();
  const { address } = await lookup(u.hostname);
  const tDns = performance.now();

  const bruto = connect({ host: address, port: puerto });
  await new Promise((ok, mal) => {
    bruto.once('connect', ok);
    bruto.once('error', mal);
  });
  const tTcp = performance.now();

  const seguro = tlsConnect({ socket: bruto, servername: u.hostname });
  await new Promise((ok, mal) => {
    seguro.once('secureConnect', ok);
    seguro.once('error', mal);
  });
  const tTls = performance.now();

  seguro.write(
    `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
      `Connection: close\r\nUser-Agent: vendox-medicion\r\n\r\n`,
  );

  let primerByte = 0;
  await new Promise((ok, mal) => {
    seguro.once('data', () => {
      primerByte = performance.now();
    });
    seguro.once('end', ok);
    seguro.once('close', ok);
    seguro.once('error', mal);
  });
  const tFin = performance.now();
  seguro.destroy();

  return {
    dns: tDns - t0,
    tcp: tTcp - tDns,
    tls: tTls - tTcp,
    espera: (primerByte || tFin) - tTls,
    total: tFin - t0,
  };
}

/**
 * Varias peticiones sobre la MISMA conexión.
 *
 * Es lo que hace la app cuando el keep-alive funciona, y la diferencia contra
 * `medirEnFrio` es exactamente lo que cuesta abrir la conexión.
 */
async function medirEnCaliente(url, veces) {
  const u = new URL(url);
  const { address } = await lookup(u.hostname);

  const bruto = connect({ host: address, port: u.port ? Number(u.port) : 443 });
  await new Promise((ok, mal) => {
    bruto.once('connect', ok);
    bruto.once('error', mal);
  });
  const seguro = tlsConnect({ socket: bruto, servername: u.hostname });
  await new Promise((ok, mal) => {
    seguro.once('secureConnect', ok);
    seguro.once('error', mal);
  });

  /**
   * ⚠️ Hay que leer la respuesta ENTERA antes de mandar la siguiente.
   *
   * La primera versión cortaba en el primer `data` y seguía. Con keep-alive
   * eso deja el cuerpo a medio leer en el buffer, la petición siguiente se
   * mezcla con lo que quedaba, y el proceso se cuelga esperando un `data` que
   * ya había llegado. Se manifestó como «unsettled top-level await».
   */
  const leerRespuesta = () =>
    new Promise((ok, mal) => {
      let crudo = Buffer.alloc(0);
      let primerByte = 0;

      const alLlegar = (trozo) => {
        if (!primerByte) primerByte = performance.now();
        crudo = Buffer.concat([crudo, trozo]);

        const corte = crudo.indexOf('\r\n\r\n');
        if (corte === -1) return;

        const cabeceras = crudo.subarray(0, corte).toString('latin1');
        const largo = /content-length:\s*(\d+)/i.exec(cabeceras);
        if (!largo) return mal(new Error('respuesta sin content-length'));

        if (crudo.length - (corte + 4) >= Number(largo[1])) {
          seguro.off('data', alLlegar);
          seguro.off('error', alFallar);
          ok(primerByte);
        }
      };

      seguro.on('data', alLlegar);
      // ⚠️ once('error') acumulaba un listener por peticion y Node avisaba
      // a los diez. Se engancha y se suelta en el mismo ciclo.
      const alFallar = (e) => {
        seguro.off('data', alLlegar);
        mal(e);
      };
      seguro.once('error', alFallar);
    });

  const tiempos = [];
  for (let i = 0; i < veces; i += 1) {
    const t0 = performance.now();
    seguro.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
        `Connection: keep-alive\r\nUser-Agent: vendox-medicion\r\n\r\n`,
    );
    const primerByte = await leerRespuesta();
    tiempos.push(primerByte - t0);
  }
  seguro.destroy();
  return tiempos;
}

const ms = (n) => `${Math.round(n)}`.padStart(5);

function percentil(valores, p) {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.floor((p / 100) * ordenados.length))];
}

console.log(`\n  VendoX — latencia contra ${BASE}`);
console.log(`  ${REPETICIONES} repeticiones · ${new Date().toISOString()}\n`);

console.log('  ─── PRIMERA PETICIÓN (conexión nueva) ───\n');
console.log('  ruta                                    dns   tcp   tls espera total');

for (const { ruta } of RUTAS) {
  const t = await medirEnFrio(`${BASE}${ruta}`);
  console.log(
    `  ${ruta.padEnd(38)}${ms(t.dns)} ${ms(t.tcp)} ${ms(t.tls)} ${ms(t.espera)} ${ms(t.total)}`,
  );
}

console.log('\n  ─── SOBRE UNA CONEXIÓN YA ABIERTA ───\n');
console.log('  ruta                                     p50   p95   min   max');

for (const { ruta, que } of RUTAS) {
  const tiempos = await medirEnCaliente(`${BASE}${ruta}`, REPETICIONES);
  console.log(
    `  ${ruta.padEnd(38)}${ms(percentil(tiempos, 50))} ${ms(percentil(tiempos, 95))} ` +
      `${ms(Math.min(...tiempos))} ${ms(Math.max(...tiempos))}   ${que}`,
  );
}

console.log('\n  Cómo se lee:\n');
console.log('  · dns + tcp + tls  = lo que cuesta ABRIR la conexión. Se paga una');
console.log('    vez si el keep-alive funciona, y en cada petición si no.');
console.log('  · La diferencia entre /health y /ready es el viaje a la base.');
console.log('  · Si el p95 caliente es parecido al p50, el servidor no duerme.\n');
