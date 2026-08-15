import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { leerCredencialDeFirebase } from '@/modules/notifications/credencial-de-firebase';
import { leerLlave } from '@/shared/crypto/secretos';
import { PROVEEDORES } from '@/shared/http/deployment-provider';
import {
  RUTA_OAUTH_MERCADOPAGO,
  RUTA_WEBHOOK_MERCADOPAGO,
} from '@/shared/http/rutas-webhook';

/**
 * Carga `.env` en process.env ANTES de validar.
 *
 * Va acá, en el módulo de configuración, y no en main.ts: cualquier entrypoint
 * —el servidor, los workers, los scripts de CLI, los tests— importa este
 * archivo, así que todos obtienen la configuración de la misma forma. Ponerlo
 * en main.ts haría que `pnpm spike:report` arrancara sin variables.
 *
 * En Fly.io no existe `.env` y las variables vienen inyectadas; dotenv no
 * encuentra el archivo, no hace nada, y `override: false` garantiza que jamás
 * pise una variable ya presente en el entorno.
 */
loadDotenv({ override: false });

/**
 * Variable opcional que además tolera la cadena vacía.
 *
 * `z.string().optional()` NO cubre `""`. Y un `.env` con
 *
 *     MP_ACCESS_TOKEN=
 *
 * no entrega `undefined` sino `""`, que falla contra cualquier `.min()` o
 * `.url()`. El resultado es un proceso que no arranca con un mensaje que
 * apunta a la variable equivocada — "debe tener 20 caracteres" cuando lo que
 * pasa es que está sin completar.
 *
 * Dejar los placeholders vacíos en el `.env` es lo normal mientras se esperan
 * credenciales, así que la configuración tiene que tratarlos como ausentes.
 */
function optionalOrEmpty<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/**
 * Igual que `isLocalEnv`, pero sobre `string` en vez de sobre `Env['NODE_ENV']`.
 *
 * Existe por una restricción del compilador, no por diseño: las validaciones de
 * abajo necesitan saber si el entorno es local, y `Env` se infiere del propio
 * esquema. Si el esquema llamara a una función tipada con `Env`, el tipo se
 * referenciaría a sí mismo y TypeScript no puede resolverlo.
 *
 * `isLocalEnv` sigue siendo la de uso público y delega acá, así que la regla
 * está escrita una sola vez.
 */
function esEntornoLocal(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Booleano de variable de entorno, en serio.
 *
 * ⛔ NO usar `z.coerce.boolean()`. Hace `Boolean(valor)`, y en JavaScript
 * `Boolean("false")` es **`true`**: cualquier texto no vacío da verdadero.
 *
 * El daño concreto que causó: `SPIKE_ENABLED=false` dejaba el módulo de spike
 * ENCENDIDO. El interruptor maestro que existe para que endpoints sin
 * autenticación de usuario no queden expuestos no apagaba nada, y la única
 * forma de desactivarlos era borrar la variable del archivo. Se descubrió por
 * casualidad; en producción se habría descubierto de la peor manera.
 *
 * Acá los valores son explícitos y cualquier otra cosa es un error de
 * configuración, no un valor que el código adivina. `FALSE`, `False` y `false`
 * valen lo mismo; `si`, `sí` y `enabled` no valen nada y el proceso lo dice.
 */
const VERDADEROS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSOS = new Set(['false', '0', 'no', 'n', 'off', '']);

function envBoolean(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v;
      const normalizado = v.trim().toLowerCase();
      if (VERDADEROS.has(normalizado)) return true;
      if (FALSOS.has(normalizado)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `valor booleano inválido: "${v}". Usá true o false.`,
      });
      return z.NEVER;
    });
}

/**
 * Contrato de configuración del proceso.
 *
 * Se valida UNA sola vez, al arrancar. Si falta o está mal una variable, el
 * proceso muere con un mensaje legible ANTES de aceptar tráfico.
 *
 * Es deliberado: la alternativa es `process.env.X!` desperdigado por el código
 * y un fallo a las 3 de la mañana porque un secreto quedó vacío en un deploy.
 */
export const envSchema = z
  .object({
    // ─── Aplicación ─────────────────────────────────────────────────────────
    // 'test' está porque Vitest fuerza NODE_ENV=test y no podemos (ni queremos)
    // pisarlo: varias librerías cambian de comportamiento según ese valor.
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

    /**
     * Puerto de escucha. **Lo dicta la plataforma, no nosotros.**
     *
     * Code Engine, Render y Fly inyectan `PORT` y esperan que el proceso
     * escuche exactamente ahí. Un valor fijo en el código hace que el contenedor
     * arranque bien y no reciba una sola petición: el proveedor sondea el puerto
     * que él eligió, no encuentra nada, y reinicia en bucle sin un error claro.
     *
     * Sin default en el esquema: se exige explícito fuera de local, y recién
     * después se rellena con 3000 para desarrollo. Un `.default()` acá haría
     * imposible distinguir "no lo mandaron" de "mandaron 3000", que es
     * justamente lo que hay que detectar.
     */
    PORT: z.coerce.number().int().min(1).max(65535).optional(),

    /**
     * Dónde corre el contenedor.
     *
     * Determina de qué cabecera sale la IP del cliente. Se DECLARA y no se
     * detecta: deducirlo mirando cabeceras significaría confiar en algo que,
     * fuera de ese proveedor, escribe cualquiera. Ver
     * `shared/http/client-ip.ts`.
     */
    DEPLOYMENT_PROVIDER: z.enum(PROVEEDORES).default('local'),

    /**
     * Qué hace este proceso.
     *
     *   · `all`    → API y tareas periódicas en el mismo proceso. Es lo que
     *                corre en local y en un contenedor único.
     *   · `web`    → sólo la API. Sin reconciliadores ni cola.
     *   · `worker` → sólo las tareas periódicas. Sin servidor HTTP.
     *
     * Existe por el escalado a cero. En una plataforma que apaga el contenedor
     * cuando no hay tráfico, un `setInterval` dentro del proceso web deja de
     * ejecutarse justo cuando más falta hace: de noche, sin visitas, con
     * reservas venciendo y pagos en estado desconocido.
     *
     * No parte el sistema en microservicios: es el mismo código y la misma
     * imagen, arrancada por otro punto de entrada.
     */
    APP_ROLE: z.enum(['all', 'web', 'worker']).default('all'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    GIT_SHA: z.string().default('unknown'),

    /**
     * Cuánto esperar, tras recibir SIGTERM, antes de empezar a cerrar.
     *
     * El balanceador tarda en enterarse de que esta instancia se está yendo, y
     * durante esos segundos sigue mandándole tráfico. Cerrar de inmediato
     * convierte cada petición de esa ventana en un error de red — y si esa
     * petición era un cobro, en un pago de resultado indeterminado.
     *
     * Se ajusta por plataforma: hay que entrar cómodo dentro del plazo que da
     * cada una antes del SIGKILL.
     */
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),

    /**
     * Tope del apagado completo, drenaje incluido.
     *
     * Si algo se cuelga cerrando —una consulta eterna, un socket que no
     * responde— es preferible salir por las nuestras que esperar el SIGKILL,
     * que no ejecuta ningún cierre y deja todo colgado del otro lado.
     */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),

    // ─── PostgreSQL ─────────────────────────────────────────────────────────
    /** La que usa la aplicación. En Neon, la del pooler. */
    DATABASE_URL: z.string().url().startsWith('postgres'),

    /**
     * La conexión DIRECTA, sin pooler. La usan sólo las migraciones.
     *
     * `prisma migrate deploy` toma un lock de sesión y ejecuta DDL. PgBouncer en
     * modo transacción no sostiene ninguna de las dos cosas: la migración se
     * cuelga, o peor, queda aplicada a medias.
     *
     * Opcional porque en local no hay pooler y `DATABASE_URL` ya es directa.
     */
    DIRECT_URL: optionalOrEmpty(z.string().url().startsWith('postgres')),

    // ─── Redis ──────────────────────────────────────────────────────────────
    REDIS_URL: z.string().url(),

    // ─── LiveKit ────────────────────────────────────────────────────────────
    LIVEKIT_API_KEY: z.string().min(3),
    // El secreto de LiveKit firma los tokens. Nunca sale del backend.
    LIVEKIT_API_SECRET: z.string().min(16),
    LIVEKIT_WS_URL: z.string().url().startsWith('ws'),
    LIVEKIT_HTTP_URL: z.string().url().startsWith('http'),
    LIVEKIT_WEBHOOK_ENABLED: envBoolean(true),
    LIVEKIT_BROADCASTER_TOKEN_TTL_S: z.coerce.number().int().min(60).default(21_600),
    LIVEKIT_VIEWER_TOKEN_TTL_S: z.coerce.number().int().min(60).default(7_200),

    /**
     * URL pública del backend, tal como la ve un teléfono.
     *
     * Se usa para armar los enlaces de las imágenes. No se puede derivar de la
     * petición: detrás de un túnel o del proxy de Fly.io, el host que ve
     * Fastify no es el que el cliente puede volver a pedir.
     */
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3100'),

    // ─── Auth ───────────────────────────────────────────────────────────────
    /**
     * Clave de firma de los access tokens (HS256).
     *
     * 32 caracteres como piso: por debajo, una clave HMAC se puede atacar por
     * fuerza bruta con hardware corriente, y quien la obtenga puede firmarse
     * un token de administrador.
     *
     * Generar con: openssl rand -base64 48
     */
    JWT_SECRET: z.string().min(32),
    /**
     * 15 minutos. Corto a propósito: el access token NO se puede revocar, así
     * que su ventana de daño es exactamente su duración. Lo que se revoca es
     * el refresh token, y por eso ése sí vive en la base.
     */
    JWT_ACCESS_TTL_S: z.coerce.number().int().min(60).max(3_600).default(900),
    /** 30 días. Es cuánto puede pasar sin abrir la app antes de reloguear. */
    JWT_REFRESH_TTL_S: z.coerce.number().int().min(3_600).default(2_592_000),
    JWT_ISSUER: z.string().default('livesell'),
    JWT_AUDIENCE: z.string().default('livesell-app'),

    /// Client IDs de Google/Apple. Se usan para validar el `aud` del token de
    /// identidad: sin esa comprobación, un token emitido para OTRA aplicación
    /// serviría para entrar a la nuestra.
    GOOGLE_CLIENT_ID_ANDROID: optionalOrEmpty(z.string().min(10)),
    GOOGLE_CLIENT_ID_IOS: optionalOrEmpty(z.string().min(10)),
    GOOGLE_CLIENT_ID_WEB: optionalOrEmpty(z.string().min(10)),
    APPLE_BUNDLE_ID: optionalOrEmpty(z.string().min(3)),

    /**
     * Habilita un login de desarrollo que emite tokens sin proveedor externo.
     * Imprescindible para probar la app antes de tener credenciales de Google,
     * y catastrófico en producción: `env.schema` lo prohíbe explícitamente.
     */
    AUTH_DEV_LOGIN_ENABLED: envBoolean(false),

    /**
     * El interruptor del login de la cuenta de revisión de Google Play.
     *
     * A diferencia de AUTH_DEV_LOGIN_ENABLED, este SÍ se puede encender en
     * producción: es la única forma de que un revisor entre. Lo que lo hace
     * seguro no es el entorno sino el alcance — sólo autentica cuentas con la
     * marca isDemoAccount, y no hay ningún endpoint que ponga esa marca.
     *
     * Apagarlo desactiva el camino entero de inmediato, sin desplegar.
     */
    DEMO_LOGIN_ENABLED: envBoolean(false),

    // ─── Spike (Sprint 0) ───────────────────────────────────────────────────
    SPIKE_ENABLED: envBoolean(false),
    SPIKE_API_KEY: optionalOrEmpty(z.string().min(16)),

    // ─── Mercado Pago (Sprint 0B) ───────────────────────────────────────────
    // El access token cobra dinero real si es de producción. Nunca sale del
    // backend, jamás llega a Flutter.
    MP_ACCESS_TOKEN: optionalOrEmpty(z.string().min(20)),
    // La public key SÍ va al cliente: es su función. Sólo sirve para tokenizar.
    MP_PUBLIC_KEY: optionalOrEmpty(z.string().min(20)),
    // Clave de firma de webhooks, del panel de Mercado Pago.
    MP_WEBHOOK_SECRET: optionalOrEmpty(z.string().min(8)),
    // URL pública a la que Mercado Pago manda las notificaciones. En el spike
    // es el túnel de Cloudflare; en staging, el dominio de Fly.
    MP_NOTIFICATION_URL: optionalOrEmpty(z.string().url()),
    MP_API_BASE_URL: z.string().url().default('https://api.mercadopago.com'),
    /**
     * Credenciales de la APLICACIÓN de Mercado Pago, para el OAuth de
     * marketplace.
     *
     * ⚠️ Distintas del MP_ACCESS_TOKEN de arriba. Aquél es el token de NUESTRA
     * cuenta y sirve para cobrar en nombre propio -es lo que usa el spike-.
     * Estas identifican a VendoX como aplicacion ante Mercado Pago y sirven
     * para pedirle a cada vendedor permiso de cobrar en la SUYA.
     *
     * Se sacan del panel de aplicaciones de Mercado Pago. Sin ellas, el bloque
     * de conexion responde "no configurado" y el resto del sistema funciona
     * igual: no se cae nada por no tenerlas.
     *
     * ⛔ El secret no se imprime, no se loguea y no viaja a Flutter. Nunca.
     */
    MP_CLIENT_ID: optionalOrEmpty(z.string().min(6)),
    MP_CLIENT_SECRET: optionalOrEmpty(z.string().min(20)),

    /**
     * A donde redirige Mercado Pago despues de que el vendedor autoriza.
     *
     * Apunta a NUESTRO backend, no a la app. El intercambio del codigo por el
     * token necesita el client_secret, y si lo hiciera la app ese secreto
     * estaria dentro del APK -que se descompila en dos minutos-.
     *
     * Tiene que coincidir EXACTAMENTE con la que este cargada en el panel de
     * Mercado Pago, incluida la barra final. Una diferencia de un caracter da
     * un error que no dice cual es el problema.
     */
    MP_OAUTH_REDIRECT_URI: optionalOrEmpty(z.string().url()),

    /**
     * La llave con la que se cifran los tokens de los vendedores.
     *
     * 32 bytes en base64. Se genera una sola vez y se guarda como variable de
     * entorno del servicio:
     *
     *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     *
     * ⛔ Si esta llave se pierde, los tokens guardados son irrecuperables y
     * todos los vendedores tienen que volver a conectar su cuenta. Si se
     * filtra, quien la tenga puede descifrar los tokens de un volcado de la
     * base y cobrar en nombre de cualquier vendedor.
     *
     * Ver `shared/crypto/secretos.ts`.
     */
    CREDENTIALS_ENCRYPTION_KEY: optionalOrEmpty(z.string().min(40)),

    /**
     * Si hace falta conectar Mercado Pago para poder vender.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * ES UNA REGLA DE NEGOCIO, NO UNA CONFIGURACIÓN TÉCNICA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con esto encendido, un vendedor sin cuenta conectada puede crear su
     * tienda, cargar productos en borrador y configurar todo — pero **no puede
     * publicar un producto vendible ni iniciar un vivo comercial**.
     *
     * La alternativa es lo que había antes: el cobro entra en la cuenta de
     * VendoX. Eso nos convierte en intermediarios del dinero de terceros, y
     * cada venta acumulada sin cuenta conectada es plata que le debemos a
     * alguien y que hay que girar a mano.
     *
     * ⚠️ El interruptor existe por una razón concreta: si el OAuth de Mercado
     * Pago se cae o queda mal configurado, esto deja a TODOS los vendedores sin
     * poder publicar. Poder apagarlo en un incidente, sin desplegar, es la
     * diferencia entre una tarde mala y un día perdido.
     *
     * Y no aplica si el OAuth no está configurado en este servidor: exigir
     * conectar algo que no se puede conectar dejaría la app inservible.
     */
    SELLER_MUST_CONNECT_MP: envBoolean(true),

    /**
     * ⛔ SÓLO DESARROLLO. Cobrar sin que el vendedor tenga cuenta conectada.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * POR QUÉ EXISTE Y POR QUÉ ESTÁ PROHIBIDO EN PRODUCCIÓN
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con esto encendido, un cobro cuyo vendedor no conectó Mercado Pago entra
     * en la cuenta de VendoX. Eso nos convierte en intermediarios del dinero de
     * terceros: cada venta así es plata que le debemos a alguien y que hay que
     * girar a mano, una por una.
     *
     * Existe por una razón acotada: la suite de tests prueba el flujo de cobro
     * de punta a punta —tres desenlaces, idempotencia, conciliación,
     * devoluciones— y ninguno de esos casos trata sobre Mercado Pago
     * Marketplace. Obligar a cada uno a montar un OAuth falso agregaría
     * maquinaria a cien tests para probar algo que ya tiene los suyos.
     *
     * El refine de abajo hace que el proceso NO ARRANQUE si esto viene
     * encendido en production o staging. No es una convención ni un comentario
     * de advertencia: es el arranque que se niega.
     */
    ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT: envBoolean(false),

    MP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    PAYMENTS_SPIKE_ENABLED: envBoolean(false),

    // ─── Inventario ─────────────────────────────────────────────────────────

    /**
     * Cuánto dura una reserva.
     *
     * Cinco minutos es un compromiso: alcanza para completar un pago con una
     * conexión mala, y es poco como para que un carrito abandonado bloquee la
     * última unidad durante un vivo.
     *
     * El mínimo de 30 s existe para que nadie lo baje tanto que las reservas
     * venzan antes de que el comprador llegue a pagar. El máximo de 1 h, para
     * que un valor mal tipeado no aparte stock por un día entero.
     */
    INVENTORY_RESERVATION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(300),

    /**
     * Tope de unidades por reserva.
     *
     * Sin tope, una sola petición puede apartar el catálogo completo de un
     * vendedor durante el TTL. Es un vector de denegación de servicio
     * comercial que no cuesta nada cerrar.
     */
    INVENTORY_MAX_QUANTITY_PER_RESERVATION: z.coerce.number().int().min(1).max(1_000).default(10),

    /** Umbral por defecto de "quedan pocas" cuando la variante no define el suyo. */
    INVENTORY_LOW_STOCK_THRESHOLD: z.coerce.number().int().min(0).default(3),

    /**
     * Cada cuánto barre el reconciliador buscando reservas vencidas.
     *
     * Es la RED DE SEGURIDAD, no el mecanismo principal: la precisión la da el
     * job diferido de BullMQ. Esto existe para que una caída de Redis no deje
     * stock apartado para siempre.
     */
    INVENTORY_RECONCILER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(30_000),

    /** Apagable para que los tests controlen el reloj en vez de competir con él. */
    INVENTORY_RECONCILER_ENABLED: envBoolean(true),

    /**
     * El dominio público, para los enlaces que se comparten.
     *
     * Un enlace compartido sobrevive a la versión de la app que lo generó:
     * alguien lo manda por WhatsApp hoy y lo abren en seis meses. Por eso lo
     * arma el backend y no la app, y por eso el dominio es configuración y no
     * una constante — en desarrollo apunta a otro lado, y escribirlo a mano
     * haría que los enlaces de prueba lleven a producción.
     *
     * ⚠️ La página web que atiende estos enlaces todavía no existe. Los que se
     * generen mientras tanto van a funcionar cuando esté: el formato no cambia.
     */
    PUBLIC_WEB_URL: z.string().url().default('https://vendox.com.ar'),

    // ─── Avisos ─────────────────────────────────────────────────────────────

    /**
     * Cada cuánto sale el lote de avisos pendientes.
     *
     * Treinta segundos porque un aviso que llega medio minuto tarde no le
     * cambia el día a nadie, y bajarlo multiplica los viajes a la base sin
     * ganar nada perceptible. Lo que sí necesita ser inmediato -el chat del
     * vivo- no pasa por acá: va por el socket.
     */
    NOTIFICATIONS_DISPATCHER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(30_000),

    NOTIFICATIONS_DISPATCHER_ENABLED: envBoolean(true),

    // ─── Chat del vivo ──────────────────────────────────────────────────────

    /**
     * Cuántos días se guardan los mensajes del chat.
     *
     * Treinta, y el número tiene motivo: es el tiempo en que un reporte se
     * abre, se revisa y se resuelve. Más allá de eso, un mensaje de chat de un
     * vivo no le sirve a nadie —es efímero por naturaleza, nadie lo consulta
     * como historial— y sí es una base de conversaciones privadas creciendo sin
     * límite.
     */
    CHAT_RETENCION_DIAS: z.coerce.number().int().min(1).max(365).default(30),

    /**
     * Palabras que el chat rechaza, separadas por coma.
     *
     * Vacío = se usa la lista por defecto de `filtro-de-chat.ts`, que tiene
     * ataques dirigidos y discriminación. **No palabrotas**: putear no está
     * prohibido en VendoX, y un "qué caro la puta madre" es alguien mirando un
     * precio.
     *
     * Se configura por entorno y no en el código porque cada agregado es una
     * decisión de moderación y tiene que poder hacerse sin desplegar.
     */
    CHAT_PALABRAS_PROHIBIDAS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      ),

    // ─── Push, por Firebase Cloud Messaging ─────────────────────────────────

    /**
     * El interruptor general del push.
     *
     * Apagado, los avisos se siguen escribiendo y se ven en el centro de
     * notificaciones de la app: lo único que no pasa es que suene el teléfono.
     * Sirve para apagar el push en un incidente sin tocar nada más.
     */
    PUSH_ENABLED: envBoolean(true),

    /**
     * Ruta ABSOLUTA al JSON de la cuenta de servicio de Firebase Admin.
     *
     * ⛔ El archivo vive FUERA del repositorio. En la máquina de desarrollo
     * está en `C:\VendoX-Secrets\firebase-admin.json`; en el servidor va a un
     * volumen montado.
     *
     * ─── Por qué un archivo y no el JSON en una variable ───
     *
     * Es una clave privada RSA con permiso para notificar a todos los teléfonos
     * que tengan la app. En una variable de entorno viaja en el `docker
     * inspect`, en el panel del proveedor, en cualquier `printenv` y en el
     * historial del shell de quien la configuró.
     *
     * El detalle de la validación está en
     * `modules/notifications/credencial-de-firebase.ts`.
     */
    FIREBASE_SERVICE_ACCOUNT_PATH: optionalOrEmpty(z.string().min(3)),

    /**
     * Cuántos avisos por vuelta.
     *
     * Si se acumularon miles -porque el proveedor estuvo caído toda la noche-
     * mandarlos todos de una agota la cuota y bloquea el proceso. De a cien, y
     * el barrido vuelve a pasar enseguida.
     */
    NOTIFICATIONS_DISPATCH_BATCH: z.coerce.number().int().min(1).max(1_000).default(100),

    // ─── Reaperturas de tienda ──────────────────────────────────────────────

    /**
     * Cada cuánto se busca una tienda que haya reabierto.
     *
     * Un minuto. El aviso puede salir hasta un minuto tarde y eso no le cambia
     * el resultado a nadie; bajarlo recorre las tiendas el doble de veces para
     * ganar treinta segundos que nadie percibe.
     */
    STORE_REOPEN_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(3_600_000)
      .default(60_000),

    STORE_REOPEN_SWEEP_ENABLED: envBoolean(true),

    // ─── Órdenes y comisión ─────────────────────────────────────────────────

    /**
     * Comisión de VendoX, en puntos básicos. 600 = 6,00 %.
     *
     * ⚠️ Cambiar esto NO afecta a las órdenes ya creadas. Cada orden guarda
     * como foto el porcentaje que estaba vigente cuando se creó, así que una
     * venta de hoy va a seguir diciendo 6 % dentro de dos años aunque el valor
     * de acá sea otro. Ver `platformFeeBps` en el esquema.
     *
     * En puntos básicos y no en porcentaje decimal para poder expresar 6,5 %
     * sin coma flotante.
     */
    /**
     * Estimacion del costo de Mercado Pago, en puntos basicos.
     *
     * La tasa real depende del plazo de acreditacion, del medio y del rubro, y
     * MP la informa despues de cobrar. Esto se usa SOLO para dos cosas, las dos
     * declaradas como aproximadas: el recargo al comprador cuando el vendedor
     * lo traslada -que tiene que ser un numero cerrado antes de pagar- y el
     * neto estimado del panel del vendedor.
     *
     * Configurable para que el dia que se negocie otra tasa no se toque codigo.
     */
    PROCESSOR_FEE_ESTIMATE_BPS: z.coerce.number().int().min(0).max(2000).default(619),
    VENDOX_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5_000).default(600),

    /**
     * ¿Se le traslada al comprador el costo estimado de Mercado Pago?
     *
     * **Apagado.** Para la beta el comprador paga producto + envío y nada más:
     * el costo del procesador lo absorbe el vendedor.
     *
     * El número que se trasladaba era una ESTIMACIÓN calculada antes de que
     * Mercado Pago dijera cuánto va a cobrar de verdad, y cobrar un costo
     * estimado de un tercero es exactamente el tipo de recargo que la ley de
     * defensa del consumidor mira con lupa.
     *
     * La explicación completa, y por qué el modelo se conserva en vez de
     * borrarse, está en `recargoAlComprador` (`modules/orders/shipping.ts`).
     */
    BUYER_PROCESSOR_SURCHARGE_ENABLED: envBoolean(false),

    /**
     * Cuánto vive una orden sin pagar.
     *
     * Alineado con el TTL de la reserva: cuando el stock se libera, la orden
     * que lo respaldaba deja de tener sentido. Se le da un margen para que el
     * barrido de órdenes no se adelante al de reservas.
     */
    ORDER_EXPIRATION_GRACE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),

    /** Cada cuánto corre el conciliador de pagos y el barrido de órdenes. */
    ORDERS_RECONCILER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(60_000),

    ORDERS_RECONCILER_ENABLED: envBoolean(true),

    /**
     * Cuántas veces se reintenta una devolución fallida antes de dejarla
     * para intervención manual.
     *
     * No infinito: si Mercado Pago rechaza la devolución por una razón
     * estructural, reintentarla para siempre esconde el problema en vez de
     * escalarlo.
     */
    REFUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

    /**
     * Jobs diferidos para expirar con precisión.
     *
     * Apagarlo NO impide vender: la reserva se crea igual y el reconciliador
     * la vence. Redis es una mejora de precisión, nunca una dependencia
     * transaccional. Ver `expiration.queue.ts`.
     */
    INVENTORY_EXPIRATION_QUEUE_ENABLED: envBoolean(true),

    /**
     * Cuántos proxies NUESTROS hay delante de la aplicación.
     *
     * ⚠️ **Nunca poner esto en `true`.** Antes estaba así y era una
     * vulnerabilidad: Fastify tomaba la entrada más a la izquierda de
     * `X-Forwarded-For`, que la escribe quien llama. Con
     * `curl -H "X-Forwarded-For: 1.2.3.4"` cualquiera elegía su propia IP y
     * el límite de peticiones de los endpoints de autenticación dejaba de
     * existir.
     *
     * Con un número, Fastify cuenta saltos DESDE LA DERECHA y se queda con la
     * entrada que escribió nuestro proxy. Lo que venga de afuera queda a la
     * izquierda y se ignora.
     *
     *   · 0 → local, sin proxy.
     *   · 1 → un proxy administrado delante (Fly, Render, Code Engine).
     *   · 2 → un CDN propio delante de ese proxy (Cloudflare, por ejemplo).
     *
     * Es la capa que sostiene la seguridad cuando el proveedor NO tiene
     * cabecera propietaria — que hoy son todos menos Fly.
     */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    /**
     * Clave para leer `/metrics`.
     *
     * Las métricas cuentan cuántas ventas hay, cuántos pagos se rechazan y
     * cuántas devoluciones se hacen. Publicarlas es publicar el estado del
     * negocio, y además dan una superficie de reconocimiento gratuita.
     *
     * Vacía = abierto, que es lo razonable en local. En staging y producción
     * se configura.
     */
    METRICS_TOKEN: optionalOrEmpty(z.string().min(16)),

    // ─── Límites de vendedores por nivel de riesgo ──────────────────────────
    //
    // Configurables a propósito. Un `if (ordenes > 10)` dentro del servicio de
    // órdenes sería imposible de ajustar sin desplegar, e imposible de
    // encontrar el día que alguien pregunte por qué a un vendedor le rebotó
    // una venta.
    //
    // ⚠️ Los límites NO son un bloqueo: un vendedor en riesgo alto vende, con
    // techo. Frenar automáticamente por señales indirectas dejaría sin
    // facturar a gente honesta que cambió de teléfono. Lo que frena de verdad
    // es una suspensión, que la decide una persona.
    //
    // Los valores son criterio, no medición: todavía no hay historial del cual
    // sacarlos. Se revisan cuando lo haya.

    /** Riesgo medio: el caso corriente de un vendedor nuevo. */
    SELLER_LIMIT_MEDIUM_ORDERS_PER_DAY: z.coerce.number().int().min(1).default(50),
    SELLER_LIMIT_MEDIUM_GMV_PER_DAY: z.coerce.number().int().min(1).default(5_000_000), // $50.000

    /** Riesgo alto: sigue vendiendo, con un techo que da tiempo a revisarlo. */
    SELLER_LIMIT_HIGH_ORDERS_PER_DAY: z.coerce.number().int().min(1).default(10),
    SELLER_LIMIT_HIGH_GMV_PER_DAY: z.coerce.number().int().min(1).default(1_000_000), // $10.000

    // ─── Almacenamiento de imágenes ─────────────────────────────────────────

    /**
     * Dónde se guardan las imágenes de producto.
     *
     *   · `local` → disco, servido por `/media`. Desarrollo y tests.
     *   · `r2`    → Cloudflare R2, por la API S3.
     *
     * El código que sube una foto es el mismo en los dos casos: nadie fuera de
     * `shared/storage` sabe cuál está activo.
     */
    STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),

    /**
     * Credenciales de R2. Son de tipo S3.
     *
     * ⚠️ Nunca se registran en un log, nunca llegan al cliente, y `R2_ENDPOINT`
     * jamás se le devuelve a nadie: la app móvil pide imágenes a nuestro
     * dominio y no sabe que Cloudflare existe.
     */
    R2_ACCESS_KEY_ID: optionalOrEmpty(z.string().min(8)),
    R2_SECRET_ACCESS_KEY: optionalOrEmpty(z.string().min(16)),
    /** `https://<account_id>.r2.cloudflarestorage.com` */
    R2_ENDPOINT: optionalOrEmpty(z.string().url()),
    R2_BUCKET: optionalOrEmpty(z.string().min(3)),
    R2_ACCOUNT_ID: optionalOrEmpty(z.string().min(8)),

    /**
     * Dominio público del bucket, cuando exista.
     *
     * ─── Por qué es opcional y qué pasa mientras no esté ───
     *
     * El bucket es PRIVADO y todavía no hay dominio propio. Sin esta variable,
     * las imágenes se sirven por una redirección nuestra —`/media/<key>`— que
     * firma una URL temporal en el momento de la petición. El bucket sigue
     * cerrado y los bytes van del teléfono a Cloudflare directo, sin pasar por
     * la API.
     *
     * El día que haya dominio o CDN adelante, se configura esto y las URLs
     * pasan a ser directas. Nada más cambia: lo que se guarda en la base es la
     * clave del objeto, no la URL.
     */
    R2_PUBLIC_BASE_URL: optionalOrEmpty(z.string().url()),

    /**
     * Cuánto vale una URL firmada.
     *
     * Corto a propósito. Una URL firmada es una llave: quien la tenga puede
     * bajar ese objeto sin autenticarse, y las URLs se copian, se comparten y
     * quedan en el historial del navegador. Cinco minutos alcanzan de sobra
     * para que el teléfono siga la redirección y descargue la imagen.
     */
    R2_SIGNED_URL_TTL_S: z.coerce.number().int().min(60).max(3_600).default(300),

    // ─── Observabilidad ─────────────────────────────────────────────────────
    SENTRY_DSN: z.string().url().optional().or(z.literal('')),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    METRICS_ENABLED: envBoolean(true),
  })
  // El módulo de spike no tiene autenticación de usuarios porque Auth todavía
  // no existe. Se protege con una clave compartida, así que habilitarlo sin
  // clave sería dejar endpoints abiertos que crean salas de LiveKit.
  .refine((e) => !e.SPIKE_ENABLED || !!e.SPIKE_API_KEY, {
    message: 'SPIKE_ENABLED=true requiere SPIKE_API_KEY (generar con: openssl rand -hex 32)',
    path: ['SPIKE_API_KEY'],
  })
  /**
   * El login de desarrollo emite sesiones válidas sin verificar nada contra
   * ningún proveedor. En producción es una puerta abierta a cualquier cuenta,
   * incluida la de un administrador.
   */
  .refine((e) => !(e.NODE_ENV === 'production' && e.AUTH_DEV_LOGIN_ENABLED), {
    message: 'AUTH_DEV_LOGIN_ENABLED debe ser false en production',
    path: ['AUTH_DEV_LOGIN_ENABLED'],
  })
  /**
   * Una clave de firma que quedó con el valor de ejemplo es peor que no tener
   * ninguna: da la sensación de estar configurado.
   */
  .refine(
    (e) => e.NODE_ENV !== 'production' || !/cambiame|changeme|ejemplo|example/i.test(e.JWT_SECRET),
    {
      message: 'JWT_SECRET parece un valor de ejemplo. Generar con: openssl rand -base64 48',
      path: ['JWT_SECRET'],
    },
  )
  // Salvaguarda explícita: el spike jamás debe quedar encendido en producción.
  .refine((e) => !(e.NODE_ENV === 'production' && e.SPIKE_ENABLED), {
    message: 'SPIKE_ENABLED debe ser false en production',
    path: ['SPIKE_ENABLED'],
  })
  // Igual que arriba: el spike de pagos no tiene Auth y mueve dinero.
  .refine((e) => !(e.NODE_ENV === 'production' && e.PAYMENTS_SPIKE_ENABLED), {
    message: 'PAYMENTS_SPIKE_ENABLED debe ser false en production',
    path: ['PAYMENTS_SPIKE_ENABLED'],
  })
  .refine(
    (e) =>
      !e.PAYMENTS_SPIKE_ENABLED ||
      (!!e.MP_ACCESS_TOKEN && !!e.MP_PUBLIC_KEY && !!e.MP_WEBHOOK_SECRET),
    {
      message:
        'PAYMENTS_SPIKE_ENABLED=true requiere MP_ACCESS_TOKEN, MP_PUBLIC_KEY y MP_WEBHOOK_SECRET',
      path: ['MP_ACCESS_TOKEN'],
    },
  )
  /**
   * La URL de notificación tiene que apuntar a la ruta que realmente existe.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ES UN ERROR QUE NO DA NINGUNA SEÑAL
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MP_NOTIFICATION_URL` es texto libre y viaja en cada cobro: Mercado Pago la
   * guarda y le manda ahí las notificaciones. Si tiene la ruta equivocada
   * —`/api/` de más, la ruta vieja del spike, un `/v1/`— **todo sigue
   * funcionando**: el cobro se crea, la tarjeta se debita, la app muestra
   * "aprobado".
   *
   * Lo único que pasa es que la notificación da 404 y la orden se queda en
   * `PENDING_PAYMENT` para siempre. El conciliador termina rescatándola, pero
   * recién en su próxima pasada y sin que nadie sepa por qué hizo falta.
   *
   * No hay log, no hay excepción y no hay alerta: hay que ir a mirar el panel
   * de Mercado Pago para enterarse. Por eso se valida al arrancar, que es el
   * único momento en que el error es barato.
   */
  .refine(
    (e) =>
      !e.MP_NOTIFICATION_URL ||
      new URL(e.MP_NOTIFICATION_URL).pathname === `/${RUTA_WEBHOOK_MERCADOPAGO}`,
    {
      message:
        `MP_NOTIFICATION_URL debe terminar exactamente en "/${RUTA_WEBHOOK_MERCADOPAGO}" ` +
        '(sin "/api" y sin "/v1"): es la única ruta que el servidor registra. ' +
        'Con otra ruta el cobro funciona igual y la notificación se pierde en un 404.',
      path: ['MP_NOTIFICATION_URL'],
    },
  )
  /**
   * La URL de redirección tiene que apuntar a la ruta que el servidor registra.
   *
   * Es exactamente el mismo problema que con `MP_NOTIFICATION_URL`, que ya nos
   * costó una tarde: la URL se escribe a mano en un panel externo, y si no
   * coincide con lo que servimos, Mercado Pago redirige a un 404. El vendedor
   * pone su contraseña, autoriza, y termina en una página de error sin
   * entender qué hizo mal.
   *
   * Peor que el webhook, incluso: acá el error es visible para el vendedor y
   * pasa justo en el momento de más confianza del flujo.
   */
  .refine(
    (e) =>
      !e.MP_OAUTH_REDIRECT_URI ||
      new URL(e.MP_OAUTH_REDIRECT_URI).pathname === `/${RUTA_OAUTH_MERCADOPAGO}/callback`,
    {
      message:
        `MP_OAUTH_REDIRECT_URI debe terminar exactamente en "/${RUTA_OAUTH_MERCADOPAGO}/callback" ` +
        '(sin "/api" y sin "/v1"): es la única ruta que el servidor registra.',
      path: ['MP_OAUTH_REDIRECT_URI'],
    },
  )
  /**
   * Las credenciales de OAuth van juntas o no van.
   *
   * Con el `client_id` cargado y el `secret` vacío, el bloque se declara
   * disponible, la app le ofrece "conectar Mercado Pago" al vendedor, y el
   * intercambio falla recién después de que puso su contraseña. Es peor que no
   * ofrecer la función.
   */
  .refine(
    (e) => {
      const puestas = [e.MP_CLIENT_ID, e.MP_CLIENT_SECRET, e.MP_OAUTH_REDIRECT_URI].filter(
        Boolean,
      ).length;
      return puestas === 0 || puestas === 3;
    },
    {
      message:
        'MP_CLIENT_ID, MP_CLIENT_SECRET y MP_OAUTH_REDIRECT_URI van las tres o ninguna. ' +
        'Con una sola cargada, la app le ofrece conectar al vendedor y falla después de ' +
        'que puso su contraseña de Mercado Pago.',
      path: ['MP_CLIENT_SECRET'],
    },
  )
  /**
   * Sin llave de cifrado no se guarda ningún token.
   *
   * La alternativa —guardarlos en texto plano "por ahora"— es exactamente lo
   * que este bloque existe para evitar. Un access token de Mercado Pago permite
   * cobrar en nombre del vendedor: en una columna de texto queda en los
   * respaldos, en las réplicas y en cualquier volcado de depuración.
   *
   * Así que si el OAuth está configurado, la llave es obligatoria.
   */
  /**
   * ⛔ El respaldo de cobro sin cuenta del vendedor no existe fuera de local.
   *
   * Con esto encendido en un servidor real, cada venta de un vendedor sin
   * cuenta conectada entra en la nuestra — y el problema crece en silencio
   * hasta que hay que devolver plata a mano.
   *
   * El proceso no arranca. Es deliberado: una variable de entorno mal copiada
   * entre entornos es exactamente cómo esto llegaría a producción.
   */
  .refine((e) => !e.ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT || esEntornoLocal(e.NODE_ENV), {
    message:
      'ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT sólo puede estar encendido en development o test. ' +
      'Fuera de ahí, un cobro sin cuenta del vendedor entra en la cuenta de VendoX.',
    path: ['ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT'],
  })
  /**
   * En producción, con el push encendido, la credencial es obligatoria.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ ESTO NO PUEDE SER UNA ADVERTENCIA
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Un backend productivo que arranca sin poder mandar avisos es un backend
   * que **parece sano**: responde todo, las ventas entran, los pedidos se
   * crean. Lo único que no pasa es que la gente se entere de que le pagaron,
   * de que su pedido salió, o de que tiene un código de entrega esperando.
   *
   * Eso se descubre por un reclamo, días después, y para entonces hay una
   * cantidad desconocida de avisos en `SKIPPED` que nadie va a reenviar.
   *
   * Fallar al arrancar es incómodo exactamente una vez y en el momento
   * correcto: cuando quien despliega está mirando la consola.
   *
   * En desarrollo se degrada a `SKIPPED`, que es lo que corresponde: nadie
   * tiene que conseguir una clave de Google para trabajar en el catálogo.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || !e.PUSH_ENABLED || !!e.FIREBASE_SERVICE_ACCOUNT_PATH, {
    message:
      'Con PUSH_ENABLED en producción hace falta FIREBASE_SERVICE_ACCOUNT_PATH, ' +
      'con la ruta absoluta al JSON de la cuenta de servicio de Firebase Admin. ' +
      'Si querés arrancar sin push, poné PUSH_ENABLED=false explícitamente.',
    path: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
  })
  /**
   * Y la credencial tiene que existir y ser legible AHORA, no cuando salga el
   * primer aviso.
   *
   * Una ruta escrita mal pasa la comprobación de arriba —es un string— y
   * revienta seis horas después, con el primer pedido pagado. Se lee el archivo
   * en el arranque.
   *
   * ⚠️ Lo que se valida es la FORMA. El contenido no se registra en ningún
   * lado. Ver `leerCredencialDeFirebase`.
   */
  .refine(
    (e) => {
      if (!e.FIREBASE_SERVICE_ACCOUNT_PATH || !e.PUSH_ENABLED) return true;
      try {
        leerCredencialDeFirebase(e.FIREBASE_SERVICE_ACCOUNT_PATH);
        return true;
      } catch {
        return false;
      }
    },
    (e) => ({
      message: (() => {
        try {
          leerCredencialDeFirebase(e.FIREBASE_SERVICE_ACCOUNT_PATH ?? '');
          return '';
        } catch (err) {
          // El mensaje del error nombra la ruta y el motivo, nunca el
          // contenido del archivo.
          return err instanceof Error ? err.message : 'credencial de Firebase inválida';
        }
      })(),
      path: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
    }),
  )
  .refine((e) => !e.MP_CLIENT_ID || !!e.CREDENTIALS_ENCRYPTION_KEY, {
    message:
      'Con el OAuth de Mercado Pago configurado hace falta CREDENTIALS_ENCRYPTION_KEY. ' +
      'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    path: ['CREDENTIALS_ENCRYPTION_KEY'],
  })
  /**
   * Y tiene que ser una llave de verdad, no una cadena cualquiera de 40+
   * caracteres.
   *
   * El esquema de arriba sólo mira el largo. Esto la decodifica y comprueba que
   * sean 32 bytes y que no sean todos ceros — que es lo que queda cuando
   * alguien pone `AAAA…` para ver si arranca.
   */
  .refine(
    (e) => {
      if (!e.CREDENTIALS_ENCRYPTION_KEY) return true;
      try {
        leerLlave(e.CREDENTIALS_ENCRYPTION_KEY);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'CREDENTIALS_ENCRYPTION_KEY tiene que ser 32 bytes en base64. ' +
        'Generala con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      path: ['CREDENTIALS_ENCRYPTION_KEY'],
    },
  )
  /**
   * Guardia contra el accidente más caro posible: cobrarle de verdad a alguien
   * durante una prueba. Las credenciales de prueba de Mercado Pago empiezan con
   * `TEST-`; las de producción, no. Fuera de producción exigimos las de prueba.
   */
  .refine(
    (e) =>
      e.NODE_ENV === 'production' ||
      !e.MP_ACCESS_TOKEN ||
      e.MP_ACCESS_TOKEN.startsWith('TEST-'),
    {
      message:
        'Fuera de production el MP_ACCESS_TOKEN debe ser de prueba (empieza con "TEST-"). ' +
        'Con un token productivo, cada spike cobra dinero real.',
      path: ['MP_ACCESS_TOKEN'],
    },
  )
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LA TRAMPA DEL POOLER DE NEON
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Neon da DOS cadenas de conexión y se parecen tanto que se confunden:
   *
   *   · `...-pooler.sa-east-1.aws.neon.tech`  → PgBouncer, modo transacción
   *   · `...sa-east-1.aws.neon.tech`          → conexión directa
   *
   * Para la aplicación hay que usar el pooler. Sin él, cada instancia abre
   * conexiones directas y Neon las corta: en el plan gratuito el techo se toca
   * enseguida, y el síntoma es "too many connections" bajo carga — justo cuando
   * se está midiendo capacidad y uno cree que encontró el límite real.
   *
   * Pero Prisma necesita saber que hay un PgBouncer del otro lado. En modo
   * transacción no hay sesión persistente, así que los *prepared statements*
   * que Prisma crea por omisión desaparecen entre consultas y aparece
   * `prepared statement "s0" already exists`. Se apagan con `pgbouncer=true`.
   *
   * ─── Y las migraciones van al revés ───
   *
   * `prisma migrate deploy` toma un lock de sesión y ejecuta DDL. Contra el
   * pooler eso se cuelga o falla a la mitad, con la migración parcialmente
   * aplicada. Las migraciones usan la URL DIRECTA, que en el flujo de despliegue
   * es `STAGING_DATABASE_URL_DIRECT`.
   *
   * Esta comprobación existe porque los dos errores son de configuración, se
   * ven idénticos a un problema de código, y aparecen bajo carga y no al
   * arrancar. Es preferible no arrancar.
   */
  .refine(
    (e) =>
      esEntornoLocal(e.NODE_ENV) ||
      !e.DATABASE_URL.includes('-pooler.') ||
      /[?&]pgbouncer=true/.test(e.DATABASE_URL),
    {
      message:
        'La DATABASE_URL apunta al pooler de Neon pero le falta `pgbouncer=true`. ' +
        'Sin eso Prisma usa prepared statements que PgBouncer no puede sostener en modo ' +
        'transacción, y las consultas fallan con `prepared statement "s0" already exists` ' +
        'de forma intermitente. Agregar `?pgbouncer=true&connection_limit=5`.',
      path: ['DATABASE_URL'],
    },
  )
  /**
   * Fuera de local, la conexión a la base va cifrada.
   *
   * Neon lo exige y rechaza lo demás, así que en la práctica esto atrapa el
   * caso de haber apuntado sin querer a otra base —una de pruebas, la de otro
   * proyecto— que sí acepte texto plano.
   */
  .refine(
    (e) => esEntornoLocal(e.NODE_ENV) || /sslmode=(require|verify-full)/.test(e.DATABASE_URL),
    {
      message: 'Fuera de local la DATABASE_URL debe llevar `sslmode=require`.',
      path: ['DATABASE_URL'],
    },
  )
  /**
   * Redis cifrado fuera de local.
   *
   * Upstash entrega la URL con `rediss://` (dos eses) e ioredis activa TLS solo
   * por ese esquema. Copiar la variante `redis://` manda el token de
   * autenticación de Upstash en texto plano por internet abierto, y no falla:
   * funciona igual, sin ninguna señal de que algo anda mal. Por eso se
   * comprueba acá.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || e.REDIS_URL.startsWith('rediss://'), {
    message:
      'Fuera de local la REDIS_URL debe usar `rediss://` (con dos eses) para ir por TLS. ' +
      'Con `redis://` el token de Upstash viaja en texto plano y no hay ningún error visible.',
    path: ['REDIS_URL'],
  })
  /**
   * En staging y producción hay proxy delante. Con 0 saltos, `req.ip` sería la
   * IP del proxy: todo el tráfico compartiría un único contador de límite de
   * peticiones y bastaría una persona para dejar afuera a las demás.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || e.TRUSTED_PROXY_HOPS >= 1, {
    message:
      'Fuera de local hay un proxy delante: TRUSTED_PROXY_HOPS debe ser al menos 1 ' +
      '(1 con el proxy del proveedor, 2 si además hay un CDN propio). Con 0, todas las ' +
      'peticiones comparten el contador del límite y una sola persona deja afuera al resto.',
    path: ['TRUSTED_PROXY_HOPS'],
  })
  /**
   * El proveedor tiene que estar declarado fuera de local.
   *
   * Quedar en `local` en un despliegue real significa que la IP saldría del
   * socket TCP, que detrás de un proxy es SIEMPRE la del proxy: todo el tráfico
   * en un solo contador de límite de peticiones, y una persona dejando afuera a
   * todas las demás.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || e.DEPLOYMENT_PROVIDER !== 'local', {
    message:
      'Fuera de local hay que declarar DEPLOYMENT_PROVIDER (fly | render | ibm_code_engine). ' +
      'Con "local" la IP sale del socket, que detrás de un proxy es siempre la misma.',
    path: ['DEPLOYMENT_PROVIDER'],
  })
  /**
   * `PORT` explícito fuera de local.
   *
   * Las tres plataformas lo inyectan y sondean ese puerto exacto. Si el proceso
   * escucha en otro, el contenedor arranca, no recibe una sola petición y el
   * proveedor lo reinicia en bucle sin decir por qué. Es un fallo caro de
   * diagnosticar y trivial de prevenir.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || e.PORT !== undefined, {
    message:
      'Fuera de local, PORT tiene que venir del entorno: la plataforma elige el puerto y ' +
      'sondea ése. Escuchar en otro hace que el contenedor arranque y nunca reciba tráfico.',
    path: ['PORT'],
  })
  /**
   * Con pooler hace falta la conexión directa para migrar.
   *
   * Sin `DIRECT_URL`, el comando de migración cae en `DATABASE_URL`, que apunta
   * al pooler. Ahí el lock de sesión no existe y la migración se cuelga o queda
   * a medio aplicar — que es peor que no haberla corrido.
   */
  .refine((e) => !e.DATABASE_URL.includes('-pooler.') || !!e.DIRECT_URL, {
    message:
      'DATABASE_URL apunta al pooler, así que hace falta DIRECT_URL (la conexión sin ' +
      '`-pooler` en el host) para las migraciones. Contra el pooler, `migrate deploy` se ' +
      'cuelga o deja la migración a medias.',
    path: ['DIRECT_URL'],
  })
  /**
   * Y la directa no puede ser la del pooler disfrazada.
   *
   * Pegar la misma cadena en las dos variables es el error natural cuando se
   * copian del mismo panel, y anula por completo la razón de que exista la
   * segunda.
   */
  .refine((e) => !e.DIRECT_URL?.includes('-pooler.'), {
    message:
      'DIRECT_URL apunta al pooler. Tiene que ser la conexión directa: en Neon, la misma ' +
      'cadena con el selector "Pooled connection" DESACTIVADO (sin `-pooler` en el host).',
    path: ['DIRECT_URL'],
  })
  /**
   * Las métricas dicen cuánto se vende y cuántos pagos se rechazan. Abiertas en
   * staging es publicar el estado del negocio a quien pruebe la URL.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || !!e.METRICS_TOKEN, {
    message:
      'Fuera de local hace falta METRICS_TOKEN: /metrics expone volumen de ventas, ' +
      'tasa de rechazo de pagos y el mapa completo de rutas. Generar con: openssl rand -hex 32',
    path: ['METRICS_TOKEN'],
  })
  /**
   * `STORAGE_DRIVER=r2` sin credenciales sería peor que no configurarlo.
   *
   * El proceso arrancaría, la app funcionaría entera, y el fallo aparecería
   * recién cuando un vendedor intenta subir su primera foto — con un error de
   * red de Cloudflare que no dice "falta una variable".
   */
  .refine(
    (e) =>
      e.STORAGE_DRIVER !== 'r2' ||
      (!!e.R2_ACCESS_KEY_ID && !!e.R2_SECRET_ACCESS_KEY && !!e.R2_ENDPOINT && !!e.R2_BUCKET),
    {
      message:
        'STORAGE_DRIVER=r2 requiere R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT y ' +
        'R2_BUCKET. Sin ellas el proceso arranca y sólo falla cuando alguien sube una foto.',
      path: ['STORAGE_DRIVER'],
    },
  )
  /**
   * Y fuera de local, el disco no sirve.
   *
   * Con más de una instancia, cada una guarda las imágenes en SU disco: la foto
   * que sube un vendedor se ve o no según a qué máquina caiga la petición. Y en
   * plataformas que escalan a cero, el disco se borra al apagarse el
   * contenedor: las imágenes desaparecen solas de noche.
   */
  .refine((e) => esEntornoLocal(e.NODE_ENV) || e.STORAGE_DRIVER !== 'local', {
    message:
      'Fuera de local, STORAGE_DRIVER no puede ser `local`: el disco del contenedor no se ' +
      'comparte entre instancias y se borra al apagarse.',
    path: ['STORAGE_DRIVER'],
  })
  /**
   * El default de desarrollo, aplicado DESPUÉS de validar.
   *
   * Va acá y no como `.default()` en el campo porque las dos cosas no son
   * compatibles: con un default, el esquema no puede distinguir "no lo
   * mandaron" de "mandaron 3000", y la comprobación de arriba —que fuera de
   * local el puerto lo tiene que elegir la plataforma— no tendría nada que
   * mirar.
   */
  .transform((e) => ({ ...e, PORT: e.PORT ?? 3000 }));

export type Env = z.infer<typeof envSchema>;

/** Entornos donde se permite exponer detalles internos (stacks, logs verbosos). */
export function isLocalEnv(nodeEnv: Env['NODE_ENV']): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  · ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    // console.error y no el logger: el logger se configura DESPUÉS de validar
    // la configuración, así que acá todavía no existe.
    console.error(`\n✖ Configuración inválida. El proceso no puede arrancar:\n\n${details}\n`);
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}

/** Solo para tests: permite recargar la configuración entre casos. */
export function resetEnvCache(): void {
  cached = null;
}

export const env: Env = loadEnv();
