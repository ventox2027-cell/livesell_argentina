import { describe, expect, it } from 'vitest';

import { envSchema } from '@/config/env.schema';

const VALID = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/livesell',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_API_KEY: 'APIkey123',
  LIVEKIT_API_SECRET: 'a-secret-of-at-least-16-chars',
  LIVEKIT_WS_URL: 'wss://x.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://x.livekit.cloud',
  JWT_SECRET: 'una-clave-de-firma-de-al-menos-32-caracteres',
};

/**
 * Base para los casos de `staging` y `production`.
 *
 * Fuera de local el esquema exige cosas que en desarrollo no tienen sentido:
 * TLS en las dos conexiones, el `pgbouncer=true` del pooler de Neon, el número
 * de proxies delante y la clave de `/metrics`. Están todas acá para que los
 * tests de otras reglas no fallen por una que no están probando.
 */
const VALID_STAGING = {
  ...VALID,
  NODE_ENV: 'staging',
  DATABASE_URL:
    'postgresql://u:p@ep-x-pooler.sa-east-1.aws.neon.tech/vendox?sslmode=require&pgbouncer=true&connection_limit=5',
  DIRECT_URL: 'postgresql://u:p@ep-x.sa-east-1.aws.neon.tech/vendox?sslmode=require',
  REDIS_URL: 'rediss://default:tok@sa-east-1.upstash.io:6379',
  TRUSTED_PROXY_HOPS: '1',
  METRICS_TOKEN: 'f'.repeat(64),
  // Los dos que la plataforma decide y nosotros sólo leemos.
  DEPLOYMENT_PROVIDER: 'ibm_code_engine',
  PORT: '8080',
  // El disco del contenedor no se comparte entre instancias y se borra al
  // apagarse, así que fuera de local el almacenamiento tiene que ser remoto.
  STORAGE_DRIVER: 'r2',
  R2_ACCESS_KEY_ID: 'clave-de-prueba',
  R2_SECRET_ACCESS_KEY: 'secreto-de-prueba-largo',
  R2_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  R2_BUCKET: 'vendox-products',
  /**
   * Fuera de local, el push exige la credencial de Firebase o estar apagado
   * explícitamente.
   *
   * Se apaga en la base para que los tests de OTRAS reglas no fallen por ésta;
   * la regla en sí se prueba abajo, en su propio bloque.
   */
  // La URL pública del backend. Sin esto el default es localhost, que fuera
  // de local se rechaza: es la regla que se prueba abajo.
  PUBLIC_BASE_URL: 'https://api.vendox.com.ar',
  PUSH_ENABLED: 'false',
};

describe('envSchema', () => {
  it('acepta una configuración válida y aplica los valores por defecto', () => {
    const env = envSchema.parse(VALID);
    // El default es 3000 porque es el puerto del contenedor en Fly.io.
    // El 3100 es un override local en .env, no el valor por defecto.
    expect(env.PORT).toBe(3000);
    expect(env.SPIKE_ENABLED).toBe(false);
    expect(env.LIVEKIT_BROADCASTER_TOKEN_TTL_S).toBe(21_600);
  });

  it('rechaza un DATABASE_URL que no sea postgres', () => {
    const r = envSchema.safeParse({ ...VALID, DATABASE_URL: 'mysql://u:p@localhost/db' });
    expect(r.success).toBe(false);
  });

  it('rechaza un secreto de LiveKit demasiado corto', () => {
    const r = envSchema.safeParse({ ...VALID, LIVEKIT_API_SECRET: 'corto' });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza una clave de firma corta', () => {
    // Una clave HMAC corta se ataca por fuerza bruta con hardware corriente, y
    // quien la obtenga puede firmarse un token de administrador.
    expect(envSchema.safeParse({ ...VALID, JWT_SECRET: 'corta' }).success).toBe(false);
  });

  it('⛔ rechaza una clave de firma con el valor de ejemplo en production', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      JWT_SECRET: 'cambiame-por-una-clave-de-verdad-larga',
    });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza el login de desarrollo en production', () => {
    // Emite sesiones válidas sin verificar nada contra ningún proveedor.
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      AUTH_DEV_LOGIN_ENABLED: 'true',
    });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza SPIKE_ENABLED sin SPIKE_API_KEY', () => {
    // Sin esta regla quedarían endpoints abiertos que crean salas de LiveKit.
    const r = envSchema.safeParse({ ...VALID, SPIKE_ENABLED: 'true' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('SPIKE_API_KEY'))).toBe(true);
  });

  it('⛔ rechaza SPIKE_ENABLED en production, incluso con clave', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      SPIKE_ENABLED: 'true',
      SPIKE_API_KEY: 'una-clave-larga-y-suficiente',
    });
    expect(r.success).toBe(false);
  });

  it('acepta SPIKE_ENABLED con clave fuera de production', () => {
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      SPIKE_ENABLED: 'true',
      SPIKE_API_KEY: 'una-clave-larga-y-suficiente',
    });
    expect(r.success).toBe(true);
  });

  // ─── Conexiones reales: staging y producción ──────────────────────────────
  //
  // Todas estas reglas comparten un rasgo: el error que evitan NO se ve al
  // arrancar. Aparece bajo carga, o no aparece nunca y simplemente el tráfico
  // viaja sin cifrar. Por eso se comprueban al iniciar el proceso, que es el
  // único momento en que fallar sale barato.

  it('acepta la configuración de staging completa', () => {
    const r = envSchema.safeParse(VALID_STAGING);
    if (!r.success) {
      // Si esto falla, el mensaje importa más que el booleano: dice qué regla
      // nueva quedó imposible de satisfacer.
      throw new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    }
    expect(r.success).toBe(true);
  });

  it('⛔ rechaza el pooler de Neon sin pgbouncer=true', () => {
    /**
     * Sin ese parámetro, Prisma usa prepared statements que PgBouncer no puede
     * sostener en modo transacción. El síntoma es
     * `prepared statement "s0" already exists`, intermitente y sólo bajo
     * concurrencia: parece un bug de la aplicación y no lo es.
     */
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      DATABASE_URL:
        'postgresql://u:p@ep-x-pooler.sa-east-1.aws.neon.tech/vendox?sslmode=require',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('DATABASE_URL'))).toBe(true);
  });

  it('acepta que DATABASE_URL sea directa (despliegue sin pooler)', () => {
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      DATABASE_URL: 'postgresql://u:p@ep-x.sa-east-1.aws.neon.tech/vendox?sslmode=require',
    });
    expect(r.success).toBe(true);
  });

  // ─── Portabilidad entre proveedores de compute ────────────────────────────

  it('⛔ rechaza el pooler sin DIRECT_URL para migrar', () => {
    // `migrate deploy` toma un lock de sesión. Contra PgBouncer en modo
    // transacción se cuelga o deja la migración a medias.
    const { DIRECT_URL: _, ...sinDirecta } = VALID_STAGING;
    const r = envSchema.safeParse(sinDirecta);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('DIRECT_URL'))).toBe(true);
  });

  it('⛔ rechaza que DIRECT_URL sea el pooler disfrazado', () => {
    // El error natural al copiar las dos cadenas del mismo panel, y anula por
    // completo la razón de que exista la segunda.
    const r = envSchema.safeParse({ ...VALID_STAGING, DIRECT_URL: VALID_STAGING.DATABASE_URL });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('DIRECT_URL'))).toBe(true);
  });

  it('⛔ rechaza DEPLOYMENT_PROVIDER=local fuera de local', () => {
    // Con `local`, la IP sale del socket, que detrás de un proxy es siempre la
    // del proxy: todo el tráfico en un solo contador de límite.
    const r = envSchema.safeParse({ ...VALID_STAGING, DEPLOYMENT_PROVIDER: 'local' });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza un proveedor que no está en la lista', () => {
    // La lista es cerrada: agregar uno es agregar código que documente qué hace
    // su borde con las cabeceras.
    expect(envSchema.safeParse({ ...VALID_STAGING, DEPLOYMENT_PROVIDER: 'heroku' }).success).toBe(
      false,
    );
  });

  it('acepta los tres proveedores de compute soportados', () => {
    for (const proveedor of ['fly', 'render', 'ibm_code_engine']) {
      const r = envSchema.safeParse({ ...VALID_STAGING, DEPLOYMENT_PROVIDER: proveedor });
      expect(r.success, `falló con ${proveedor}`).toBe(true);
    }
  });

  it('⛔ rechaza PORT ausente fuera de local', () => {
    /**
     * La plataforma elige el puerto y sondea ése. Si el proceso escucha en
     * otro, el contenedor arranca, no recibe una sola petición y se reinicia en
     * bucle sin un error que lo explique.
     */
    const { PORT: _, ...sinPuerto } = VALID_STAGING;
    const r = envSchema.safeParse(sinPuerto);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('PORT'))).toBe(true);
  });

  it('en local, PORT ausente cae en 3000', () => {
    const r = envSchema.parse(VALID);
    expect(r.PORT).toBe(3000);
  });

  it('respeta el PORT que manda la plataforma', () => {
    // 8080 es el que inyecta Code Engine.
    expect(envSchema.parse({ ...VALID_STAGING, PORT: '8080' }).PORT).toBe(8080);
  });

  it('APP_ROLE por defecto es `all`, y acepta web y worker', () => {
    expect(envSchema.parse(VALID).APP_ROLE).toBe('all');
    for (const rol of ['web', 'worker', 'all']) {
      expect(envSchema.safeParse({ ...VALID_STAGING, APP_ROLE: rol }).success).toBe(true);
    }
    expect(envSchema.safeParse({ ...VALID_STAGING, APP_ROLE: 'cron' }).success).toBe(false);
  });

  it('⛔ rechaza la base sin sslmode fuera de local', () => {
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      DATABASE_URL: 'postgresql://u:p@host.neon.tech/vendox',
    });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza Redis sin TLS fuera de local', () => {
    /**
     * `redis://` en vez de `rediss://` manda el token de Upstash en texto plano
     * por internet abierto. Y funciona: no hay error, no hay aviso, nada que
     * delate que las credenciales viajan a la vista.
     */
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      REDIS_URL: 'redis://default:tok@sa-east-1.upstash.io:6379',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('REDIS_URL'))).toBe(true);
  });

  it('⛔ rechaza TRUSTED_PROXY_HOPS en 0 fuera de local', () => {
    // Con 0 saltos detrás de Fly, `req.ip` es la IP del proxy: todo el tráfico
    // comparte un contador de límite y una sola persona deja afuera al resto.
    const r = envSchema.safeParse({ ...VALID_STAGING, TRUSTED_PROXY_HOPS: '0' });
    expect(r.success).toBe(false);
  });

  it('⛔ nunca acepta trustProxy como booleano', () => {
    // La configuración vieja, la que dejaba elegir la IP a quien llamaba. Ahora
    // ni siquiera es un valor representable.
    expect(envSchema.safeParse({ ...VALID_STAGING, TRUSTED_PROXY_HOPS: 'true' }).success).toBe(
      false,
    );
  });

  it('⛔ rechaza /metrics sin token fuera de local', () => {
    const r = envSchema.safeParse({ ...VALID_STAGING, METRICS_TOKEN: '' });
    expect(r.success).toBe(false);
  });

  // ─── Almacenamiento de imágenes ───────────────────────────────────────────

  it('⛔ rechaza STORAGE_DRIVER=r2 sin credenciales', () => {
    /**
     * Sin esta regla el proceso arranca, la app funciona entera, y el fallo
     * aparece recién cuando un vendedor sube su primera foto — con un error de
     * red de Cloudflare que no dice "falta una variable".
     */
    const { R2_ACCESS_KEY_ID: _, ...sinClave } = VALID_STAGING;
    const r = envSchema.safeParse(sinClave);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.includes('STORAGE_DRIVER'))).toBe(true);
  });

  it('⛔ rechaza el disco local fuera de local', () => {
    // Con más de una instancia, la foto que sube un vendedor se ve o no según
    // a qué máquina caiga la petición. Y al escalar a cero, el disco se borra.
    const r = envSchema.safeParse({ ...VALID_STAGING, STORAGE_DRIVER: 'local' });
    expect(r.success).toBe(false);
  });

  it('acepta r2 sin dominio público: se sirve por redirección firmada', () => {
    // El estado de hoy. El bucket sigue privado y no hace falta inventar un
    // dominio para que las imágenes se vean.
    const r = envSchema.safeParse(VALID_STAGING);
    expect(r.success).toBe(true);
    expect(r.success && r.data.R2_PUBLIC_BASE_URL).toBeUndefined();
  });

  it('acepta r2 con dominio público, para cuando exista', () => {
    const r = envSchema.safeParse({
      ...VALID_STAGING,
      R2_PUBLIC_BASE_URL: 'https://img.vendox.ar',
    });
    expect(r.success).toBe(true);
  });

  it('en desarrollo, el disco local es el default y no pide credenciales', () => {
    const r = envSchema.parse(VALID);
    expect(r.STORAGE_DRIVER).toBe('local');
    expect(r.R2_ACCESS_KEY_ID).toBeUndefined();
  });

  it('deja todo esto pasar en desarrollo', () => {
    // Exigir TLS y pooler en local sería pedir una infraestructura que no
    // existe en una notebook. La regla vale donde hay internet de por medio.
    expect(envSchema.safeParse(VALID).success).toBe(true);
  });

  // ─── Mercado Pago ─────────────────────────────────────────────────────────

  const MP = {
    MP_ACCESS_TOKEN: 'TEST-1234567890-abcdefghijklmno',
    MP_PUBLIC_KEY: 'TEST-pub-1234567890-abcdefghij',
    MP_WEBHOOK_SECRET: 'secreto-de-webhook',
  };

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED sin credenciales de Mercado Pago', () => {
    const r = envSchema.safeParse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'true' });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED sin la clave de firma de webhooks', () => {
    // Sin ella cualquiera puede postear "pago aprobado" a nuestro endpoint.
    const r = envSchema.safeParse({
      ...VALID,
      PAYMENTS_SPIKE_ENABLED: 'true',
      MP_ACCESS_TOKEN: MP.MP_ACCESS_TOKEN,
      MP_PUBLIC_KEY: MP.MP_PUBLIC_KEY,
    });
    expect(r.success).toBe(false);
  });

  it('⛔ rechaza un token PRODUCTIVO de Mercado Pago fuera de production', () => {
    // El accidente más caro posible: cobrarle de verdad a alguien probando.
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'development',
      PAYMENTS_SPIKE_ENABLED: 'true',
      ...MP,
      MP_ACCESS_TOKEN: 'APP_USR-1234567890-produccion-de-verdad',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.message.includes('TEST-'))).toBe(true);
  });

  it('⛔ rechaza PAYMENTS_SPIKE_ENABLED en production', () => {
    const r = envSchema.safeParse({
      ...VALID,
      NODE_ENV: 'production',
      PAYMENTS_SPIKE_ENABLED: 'true',
      ...MP,
    });
    expect(r.success).toBe(false);
  });

  it('acepta el spike de pagos con credenciales de prueba completas', () => {
    const r = envSchema.safeParse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'true', ...MP });
    expect(r.success).toBe(true);
    expect(r.data?.MP_API_BASE_URL).toBe('https://api.mercadopago.com');
  });

  /**
   * La URL de notificación tiene que apuntar a la ruta que el servidor registra.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ES EL ERROR QUE NO DA NINGUNA SEÑAL
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MP_NOTIFICATION_URL` viaja en cada cobro y Mercado Pago la guarda. Con la
   * ruta equivocada **todo sigue funcionando**: el cobro se crea, la tarjeta se
   * debita, la app dice "aprobado". Lo único que pasa es que la notificación da
   * 404 y la orden se queda en `PENDING_PAYMENT`.
   *
   * No hay log, no hay excepción y no hay alerta. Hay que ir a mirar el panel
   * de Mercado Pago para enterarse.
   *
   * Y no era hipotético: los tres `.env` del repositorio apuntaban a
   * `/webhooks/mercadopago` —la ruta del spike— cuando se escribió esto.
   */
  describe('MP_NOTIFICATION_URL', () => {
    const con = (url: string) => envSchema.safeParse({ ...VALID, MP_NOTIFICATION_URL: url });

    it('acepta la ruta canónica', () => {
      expect(con('https://api.vendox.ar/webhooks/orders/mercadopago').success).toBe(true);
    });

    it('⛔ rechaza la ruta del spike', () => {
      // La que tenían los tres .env del repositorio.
      expect(con('https://api.vendox.ar/webhooks/mercadopago').success).toBe(false);
    });

    it('⛔ rechaza el prefijo /api', () => {
      expect(con('https://api.vendox.ar/api/webhooks/orders/mercadopago').success).toBe(false);
    });

    it('⛔ rechaza el versionado', () => {
      expect(con('https://api.vendox.ar/api/v1/webhooks/orders/mercadopago').success).toBe(false);
    });

    it('⛔ rechaza una barra final de más', () => {
      // Mercado Pago llamaría a esa URL tal cual y Fastify daría 404.
      expect(con('https://api.vendox.ar/webhooks/orders/mercadopago/').success).toBe(false);
    });

    it('el mensaje dice cuál es la ruta correcta', () => {
      const r = con('https://api.vendox.ar/webhooks/mercadopago');
      expect(
        r.error?.issues.some((i) => i.message.includes('/webhooks/orders/mercadopago')),
      ).toBe(true);
    });

    it('sin configurar no molesta: es opcional', () => {
      expect(envSchema.safeParse({ ...VALID }).success).toBe(true);
      expect(con('').success).toBe(true);
    });
  });

  it('trata una variable vacía como ausente, no como valor inválido', () => {
    // `MP_ACCESS_TOKEN=` en el .env entrega "" y no undefined. Sin este
    // tratamiento el proceso no arranca y culpa a la longitud del token,
    // cuando lo que pasa es que todavía no se completó.
    const r = envSchema.safeParse({
      ...VALID,
      MP_ACCESS_TOKEN: '',
      MP_PUBLIC_KEY: '',
      MP_WEBHOOK_SECRET: '',
      MP_NOTIFICATION_URL: '',
    });
    expect(r.success).toBe(true);
    expect(r.data?.MP_ACCESS_TOKEN).toBeUndefined();
  });

  it('⛔ pero sigue rechazando un valor corto de verdad', () => {
    const r = envSchema.safeParse({ ...VALID, MP_ACCESS_TOKEN: 'TEST-corto' });
    expect(r.success).toBe(false);
  });

  // ─── Booleanos ────────────────────────────────────────────────────────────

  describe('interruptores booleanos', () => {
    it('⛔ "false" apaga de verdad', () => {
      // El bug que motivó `envBoolean`: `z.coerce.boolean()` hace
      // Boolean("false"), que es true. El interruptor maestro que impide
      // exponer endpoints sin autenticación no apagaba nada.
      const r = envSchema.parse({ ...VALID, SPIKE_ENABLED: 'false' });
      expect(r.SPIKE_ENABLED).toBe(false);
    });

    it('⛔ y "false" tampoco enciende el spike de pagos', () => {
      const r = envSchema.parse({ ...VALID, PAYMENTS_SPIKE_ENABLED: 'false' });
      expect(r.PAYMENTS_SPIKE_ENABLED).toBe(false);
    });

    it('acepta las grafías habituales', () => {
      for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'on']) {
        expect(envSchema.parse({ ...VALID, METRICS_ENABLED: v }).METRICS_ENABLED, v).toBe(true);
      }
      for (const v of ['false', 'FALSE', '0', 'no', 'off', '']) {
        expect(envSchema.parse({ ...VALID, METRICS_ENABLED: v }).METRICS_ENABLED, v).toBe(false);
      }
    });

    it('respeta el valor por defecto cuando la variable no está', () => {
      const r = envSchema.parse(VALID);
      expect(r.METRICS_ENABLED).toBe(true);
      expect(r.SPIKE_ENABLED).toBe(false);
    });

    it('⛔ rechaza un valor que no es booleano en vez de adivinar', () => {
      // "si" parece razonable y no lo es. Mejor que el proceso avise a que
      // interprete algo distinto de lo que quiso decir quien lo escribió.
      const r = envSchema.safeParse({ ...VALID, SPIKE_ENABLED: 'si' });
      expect(r.success).toBe(false);
    });
  });

  // ─── Push ──────────────────────────────────────────────────────────────────

  describe('La credencial de Firebase', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * POR QUÉ PRODUCCIÓN NO ARRANCA SIN ELLA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un backend productivo que levanta sin poder mandar avisos **parece
     * sano**: responde todo, las ventas entran, los pedidos se crean. Lo único
     * que no pasa es que la gente se entere de que le pagaron, de que su pedido
     * salió, o de que tiene un código de entrega esperando.
     *
     * Eso se descubre por un reclamo, días después, y para entonces hay una
     * cantidad desconocida de avisos en `SKIPPED` que nadie va a reenviar.
     */

    it('⛔ fuera de local, con push encendido y sin ruta, no arranca', () => {
      const r = envSchema.safeParse({
        ...VALID_STAGING,
        PUSH_ENABLED: 'true',
        FIREBASE_SERVICE_ACCOUNT_PATH: undefined,
      });

      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('FIREBASE_SERVICE_ACCOUNT_PATH');
    });

    it('se puede arrancar sin push, pero hay que decirlo', () => {
      /**
       * La salida honesta: apagar el push explícitamente. No es lo mismo que
       * olvidarse la credencial, y el esquema obliga a distinguirlo.
       */
      const r = envSchema.safeParse({ ...VALID_STAGING, PUSH_ENABLED: 'false' });
      expect(r.success).toBe(true);
    });

    it('en desarrollo se degrada sin protestar', () => {
      // Nadie tiene que conseguir una clave de Google para trabajar en el
      // catálogo. Los avisos quedan en SKIPPED.
      const r = envSchema.safeParse({ ...VALID, PUSH_ENABLED: 'true' });
      expect(r.success).toBe(true);
    });

    it('⛔ una ruta que no existe se rechaza AL ARRANCAR', () => {
      /**
       * Una ruta escrita mal pasa cualquier validación de tipo —es un string— y
       * revienta seis horas después, con el primer pedido pagado. Se lee el
       * archivo ahora.
       */
      const r = envSchema.safeParse({
        ...VALID,
        PUSH_ENABLED: 'true',
        FIREBASE_SERVICE_ACCOUNT_PATH: 'C:\\no\\existe\\firebase-admin.json',
      });

      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('no existe');
    });

    it('⛔ una ruta relativa se rechaza', () => {
      // Se resuelve contra el directorio de trabajo del proceso, que no es el
      // mismo desde la consola, desde un contenedor o desde un gestor.
      const r = envSchema.safeParse({
        ...VALID,
        PUSH_ENABLED: 'true',
        FIREBASE_SERVICE_ACCOUNT_PATH: './firebase-admin.json',
      });

      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('absoluta');
    });

    it('con el push apagado, ni se mira la ruta', () => {
      /**
       * Apagar el push tiene que ser una salida de emergencia que funcione
       * siempre. Si además exigiera que la credencial siga siendo válida, no
       * serviría para el caso en que se apaga justamente porque la credencial
       * se rompió.
       */
      const r = envSchema.safeParse({
        ...VALID,
        PUSH_ENABLED: 'false',
        FIREBASE_SERVICE_ACCOUNT_PATH: 'C:\\no\\existe\\nada.json',
      });

      expect(r.success).toBe(true);
    });
  });
});

describe('Las huellas de firma de Android', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * UNA HUELLA MAL ESCRITA FALLA EN SILENCIO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Android baja `/.well-known/assetlinks.json`, compara la huella con la de la
   * clave que firmó el binario, y si no coincide **abre el navegador**. No hay
   * error, no hay aviso, no hay nada en el log del teléfono.
   *
   * O sea que el resultado de una huella en minúsculas es idéntico al de no
   * haberla configurado nunca. Es el peor modo de falla que hay: se descubre
   * probando en un dispositivo, y quien depure eso va a mirar el manifiesto
   * durante horas antes de sospechar de un JSON.
   *
   * Por eso el servidor no arranca con una huella mal formada.
   */

  /** La real de Play App Signing. Es pública: el archivo que la publica lo es. */
  const PLAY =
    '66:03:89:1D:04:BB:9C:C1:9A:4D:84:89:31:1A:4E:3A:B3:D4:43:90:ED:11:B8:CE:DA:51:DB:00:21:48:8B:2F';

  it('una huella bien formada se acepta', () => {
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: PLAY });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('dos separadas por coma también', () => {
    // Es el estado final: la de Play y la de la clave de subida.
    const otra = PLAY.split(':').reverse().join(':');
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: `${PLAY},${otra}` });
    expect(r.success).toBe(true);
  });

  it('vacío se acepta: es el estado antes de tener la clave', () => {
    // Con esto vacío los enlaces abren la web, que funciona. Está incompleto,
    // no roto.
    expect(envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: '' }).success).toBe(true);
  });

  it('⛔ en minúsculas se rechaza', () => {
    // Android compara el texto tal cual. `aa:bb` no es `AA:BB`.
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: PLAY.toLowerCase() });
    expect(r.success).toBe(false);
  });

  it('⛔ sin los dos puntos se rechaza', () => {
    const r = envSchema.safeParse({
      ...VALID,
      ANDROID_CERT_SHA256: PLAY.replaceAll(':', ''),
    });
    expect(r.success).toBe(false);
  });

  it('⛔ con un byte de menos se rechaza', () => {
    /**
     * El caso real: se copió desde una terminal que cortó la línea. Son 32
     * bytes exactos, y 31 produce un JSON que parece correcto.
     */
    const cortada = PLAY.split(':').slice(0, 31).join(':');
    expect(envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: cortada }).success).toBe(false);
  });

  it('⛔ si la SEGUNDA está mal, también se rechaza', () => {
    /**
     * El error que más se escapa: se agrega la huella de la clave de subida al
     * lado de la de Play y se pega mal. Validar sólo la primera dejaría pasar
     * un archivo donde la mitad de los teléfonos no verifican.
     */
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: `${PLAY},no-es-una-huella` });
    expect(r.success).toBe(false);
  });

  it('el mensaje dice cómo se saca la huella', () => {
    // Un "formato inválido" a secas manda a buscar el formato a Google. El
    // mensaje tiene que decir el comando.
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: 'AA:BB' });
    expect(JSON.stringify(r.error?.issues)).toMatch(/keytool/);
  });

  it('espacios alrededor de la coma no rompen nada', () => {
    // Alguien va a escribir `A, B` al editar el .env a mano.
    const otra = PLAY.split(':').reverse().join(':');
    const r = envSchema.safeParse({ ...VALID, ANDROID_CERT_SHA256: `${PLAY} , ${otra}` });
    expect(r.success).toBe(true);
  });
});

describe('PUBLIC_BASE_URL fuera de local', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EL ÚNICO DEFAULT QUE SIRVE EN LOCAL Y ROMPE EN PRODUCCIÓN EN SILENCIO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Es la URL con la que se arman los enlaces de las imágenes. Con un valor de
   * desarrollo el servidor arranca perfecto, contesta todo, y las fotos apuntan
   * a una dirección que no existe fuera de la máquina de quien lo configuró.
   *
   * Pasó: varias fotos quedaron apuntando a un túnel de Cloudflare ya cerrado y
   * las tarjetas de «Mi tienda» salían en gris, sin un solo error en ningún
   * log.
   */
  const rechazadas = [
    ['el default de desarrollo', 'http://localhost:3100'],
    ['loopback', 'http://127.0.0.1:3100'],
    ['el alias del emulador de Android', 'http://10.0.2.2:3100'],
    ['una IP de LAN', 'http://192.168.0.14:3100'],
    ['otra red privada', 'http://10.1.2.3:3100'],
    ['un túnel de Cloudflare', 'https://algo-random.trycloudflare.com'],
    ['un túnel de ngrok', 'https://algo.ngrok-free.app'],
  ] as const;

  for (const [queEs, url] of rechazadas) {
    it(`⛔ rechaza ${queEs}`, () => {
      const r = envSchema.safeParse({ ...VALID_STAGING, PUBLIC_BASE_URL: url });

      expect(r.success, `${url} tendría que rechazarse`).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('PUBLIC_BASE_URL'))).toBe(true);
      }
    });
  }

  it('acepta un dominio público de verdad', () => {
    // La contraparte. Sin esto, una regla que rechazara todo pasaría los siete
    // tests de arriba y nadie podría desplegar.
    for (const url of [
      'https://api.vendox.com.ar',
      'https://vendox-backend-production.up.railway.app',
    ]) {
      expect(
        envSchema.safeParse({ ...VALID_STAGING, PUBLIC_BASE_URL: url }).success,
        url,
      ).toBe(true);
    }
  });

  it('en local el default sigue sirviendo', () => {
    // Un clon del repositorio tiene que poder arrancar sin configurar nada.
    expect(envSchema.safeParse({ ...VALID }).success).toBe(true);
  });
});

describe('Railway como proveedor de despliegue', () => {
  it('se acepta', () => {
    // Sin esto el contenedor no arranca: `DEPLOYMENT_PROVIDER` es obligatorio
    // fuera de local y su lista es cerrada a propósito.
    const r = envSchema.safeParse({ ...VALID_STAGING, DEPLOYMENT_PROVIDER: 'railway' });
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
  });

  it('⛔ un proveedor inventado se sigue rechazando', () => {
    // La lista cerrada es la garantía: cada proveedor tiene que documentar qué
    // hace su borde con las cabeceras. Ver `client-ip.ts`.
    expect(
      envSchema.safeParse({ ...VALID_STAGING, DEPLOYMENT_PROVIDER: 'heroku' }).success,
    ).toBe(false);
  });
});
