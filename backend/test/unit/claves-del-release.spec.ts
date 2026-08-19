import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Las rutas del APK en R2, escritas en dos lados.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES UN TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El flujo de publicación sube el APK a una clave de R2 y el backend lo sirve
 * leyendo esa misma clave. Son dos archivos distintos, en dos lenguajes
 * distintos, mantenidos a mano.
 *
 * Si alguien renombra un lado, no falla nada: el flujo sube bien, el despliegue
 * sale bien, la suite pasa entera. Lo único que pasa es que
 * `vendox.com.ar/descargar` devuelve un 404 firmado — y se descubre cuando
 * alguien intenta bajarse la app.
 *
 * Es la misma clase de error que ya costó cuatro veces en este repositorio: dos
 * copias de una constante que se separan. Ver `test/helpers/app.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO SE UNIFICAN EN UN SOLO LUGAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque no hay ninguno que los dos puedan leer. Un workflow de GitHub Actions
 * no importa TypeScript, y el backend no lee YAML en tiempo de compilación.
 * Cuando no se puede tener una sola copia, lo que queda es que un test grite
 * cuando se separan.
 */
const CONTROLADOR = readFileSync(
  join(process.cwd(), 'src/modules/landing/descargas.controller.ts'),
  'utf8',
);

const FLUJO = readFileSync(
  resolve(process.cwd(), '..', '.github/workflows/build-apk.yml'),
  'utf8',
);

describe('El APK se sube y se sirve desde la misma clave', () => {
  /**
   * ⛔ Lo que entrega el botón de descarga.
   *
   * Si esto se separa, `/descargar/android` redirige a una URL firmada de un
   * objeto que no existe. El navegador muestra el XML de error de R2.
   */
  it('⛔ el binario: releases/android/vendox-latest.apk', () => {
    const clave = 'releases/android/vendox-latest.apk';

    expect(CONTROLADOR, 'el backend ya no lee esa clave').toContain(clave);
    expect(FLUJO, 'el flujo ya no sube a esa clave').toContain(clave);
  });

  /**
   * ⛔ La ficha que la página usa para decir qué versión hay.
   *
   * Si se separa, `/descargar/android.json` devuelve `disponible: false` para
   * siempre y la web dice que todavía no hay versión publicada — con el APK
   * arriba.
   */
  it('⛔ la metadata: releases/android/latest.json', () => {
    const clave = 'releases/android/latest.json';

    expect(CONTROLADOR).toContain(clave);
    expect(FLUJO).toContain(clave);
  });

  /**
   * La copia versionada, que el backend NO lee.
   *
   * Se comprueba igual porque es la única forma de volver a una versión
   * anterior: si el flujo dejara de escribirla, el día que haya que retroceder
   * no habría a dónde.
   */
  it('el flujo guarda además la copia versionada', () => {
    expect(FLUJO).toMatch(/releases\/android\/\$\{VERSION\}\/vendox\.apk/);
  });

  /**
   * ⛔ La ficha se escribe DESPUÉS del binario.
   *
   * Al revés, una subida de APK que falla deja la página anunciando una versión
   * que no se puede bajar. En este orden, lo peor que pasa es que anuncie la
   * anterior — que es la que efectivamente está.
   */
  it('⛔ la metadata se sube después del binario', () => {
    const apk = FLUJO.indexOf('releases/android/vendox-latest.apk');
    const json = FLUJO.indexOf('releases/android/latest.json');

    expect(apk).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(apk);
  });
});

describe('Los secretos que el flujo necesita', () => {
  /**
   * Los nombres, nunca los valores.
   *
   * ⚠️ Este test existe para que agregar un secreto nuevo al flujo sea una
   * decisión visible: si aparece uno que nadie cargó en GitHub, el despliegue
   * falla con un mensaje que no explica nada.
   */
  it('son exactamente los que están documentados', () => {
    const usados = [...FLUJO.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);

    expect([...new Set(usados)].sort()).toEqual([
      'ANDROID_KEYSTORE_BASE64',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
      'GOOGLE_SERVICES_JSON_BASE64',
      'R2_ACCESS_KEY_ID',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_SECRET_ACCESS_KEY',
    ]);
  });
});
