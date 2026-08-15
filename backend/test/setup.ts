/**
 * Setup global de Vitest. Se ejecuta ANTES de importar cualquier archivo de test.
 *
 * Es necesario porque `src/config/env.schema.ts` valida la configuración al
 * cargarse y mata el proceso si falta algo. Ese comportamiento es deliberado en
 * producción —mejor fallar al arrancar que a las 3 de la mañana— pero en tests
 * hay que darle un entorno válido antes de que se importe nada.
 *
 * ⛔ BASE DE DATOS SEPARADA (`livesell_test`).
 *
 * No es una precaución teórica: los tests de integración crean sesiones de
 * spike con latencias inventadas (incluida una "Sesión mala" de 2900 ms para
 * verificar el veredicto NO_GO). Cuando compartían base con desarrollo, esos
 * 22 registros falsos se mezclaron con mediciones de campo reales y el informe
 * global dio NO_GO por datos que nadie había medido.
 *
 * Crear la base (una vez):
 *   docker exec livesell-postgres psql -U livesell -d postgres \
 *     -c "CREATE DATABASE livesell_test OWNER livesell;"
 *   pnpm test:db:migrate
 */

const TEST_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3100',
  LOG_LEVEL: 'error', // sin ruido de logs en la salida de los tests

  DATABASE_URL: 'postgresql://livesell:livesell@localhost:5433/livesell_test?schema=public',
  REDIS_URL: 'redis://localhost:6380/1', // db 1 de Redis, no la 0 de desarrollo

  // Credenciales ficticias: los tests unitarios no hablan con LiveKit, y los de
  // integración lo mockean. Nunca credenciales reales acá.
  LIVEKIT_API_KEY: 'APItestkey',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',

  // Auth. El secreto es ficticio pero cumple el largo mínimo: la validación
  // de configuración existe justamente para que una clave corta no pase.
  JWT_SECRET: 'clave-de-firma-solo-para-tests-no-usar-en-ningun-otro-lado-0123456789',
  AUTH_DEV_LOGIN_ENABLED: 'true',

  SPIKE_ENABLED: 'true',
  SPIKE_API_KEY: 'test-spike-key-suficientemente-larga',

  // Mercado Pago: el token DEBE empezar con `TEST-` o env.schema lo rechaza.
  // Esa validación existe justamente para que un token productivo no pueda
  // colarse en una corrida de tests y cobrarle a alguien de verdad.
  PAYMENTS_SPIKE_ENABLED: 'true',
  MP_ACCESS_TOKEN: 'TEST-token-de-prueba-suficientemente-largo',
  MP_PUBLIC_KEY: 'TEST-public-key-de-prueba-larga',
  MP_WEBHOOK_SECRET: 'secreto-de-webhook-para-tests',
  /**
   * OAuth de marketplace. Credenciales de mentira con la forma correcta.
   *
   * Van acá y no en cada archivo de test porque `env.schema.ts` se evalúa la
   * PRIMERA vez que alguien lo importa, y `helpers/app.ts` lo importa a través
   * de `http-setup.ts`. Para cuando el `beforeAll` de un test corre
   * `Object.assign(process.env, ...)`, la configuración ya está congelada.
   *
   * Se perdió un rato buscándolo en el lugar equivocado: los endpoints
   * respondían "no configurado" con las variables puestas en el archivo de
   * test, tres líneas antes de arrancar la aplicación.
   *
   * ⚠️ La redirección tiene que coincidir con la ruta que el servidor registra
   * o el esquema rechaza el arranque. Es la misma validación que protege a
   * `MP_NOTIFICATION_URL`.
   */
  MP_CLIENT_ID: '1234567890123456',
  MP_CLIENT_SECRET: 'secreto-de-aplicacion-solo-para-tests-0123456789',
  MP_OAUTH_REDIRECT_URI: 'https://api.vendox.test/oauth/mercadopago/callback',

  /**
   * Llave de cifrado FIJA para los tests.
   *
   * Fija y no aleatoria a propósito: con una llave distinta por corrida, un
   * test que guarde algo cifrado y otro que lo lea fallarían de formas que
   * dependen del orden de ejecución.
   *
   * ⛔ Obviamente no se usa en ningún otro lado.
   */
  CREDENTIALS_ENCRYPTION_KEY: 'dGVzdC1rZXktc29sby1wYXJhLXRlc3RzLTMyYnl0ZXM=',
  /**
   * La regla de "sin Mercado Pago no vendés" queda APAGADA en la suite.
   *
   * No es que no importe: tiene sus propios tests, que la encienden
   * explícitamente. Apagarla acá evita que cien tests que crean productos
   * publicados —y que no tienen nada que ver con Mercado Pago— tengan que
   * conectar una cuenta falsa antes de empezar.
   *
   * En producción el valor por omisión es `true`. Ver `env.schema.ts`.
   */
  SELLER_MUST_CONNECT_MP: 'false',



  METRICS_ENABLED: 'false',
};

for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
  // Respeta lo que ya venga del entorno: permite apuntar los tests de
  // integración a otra base sin tocar este archivo.
  process.env[key] ??= value;
}
