import { randomUUID } from 'node:crypto';

import type { Params } from 'nestjs-pino';

import { env } from '@/config/env.schema';

/**
 * Datos que NUNCA deben aparecer en un log.
 *
 * Se verifica con un test (test/unit/logger-redaction.spec.ts) que envía datos
 * sensibles y comprueba que no salen. Un log con un número de tarjeta dentro es
 * un incidente de cumplimiento, no un descuido.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-spike-key"]',
  'req.headers["x-livekit-signature"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiSecret',
  '*.cardToken',
  '*.cardNumber',
  '*.cvv',
  '*.securityCode',
  '*.docNumber',
  '*.phoneE164',

  // Mercado Pago (Sprint 0B). La primera línea de defensa es `scrubMpPayment`,
  // que limpia la respuesta antes de que llegue acá; esto es la red debajo,
  // para el `logger.debug(respuesta)` que alguien agregue depurando a las 2 AM.
  '*.card_number',
  '*.security_code',
  '*.first_six_digits',
  '*.cardholder',
  '*.identification',
];

export const loggerConfig: Params = {
  pinoHttp: {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },

    // Un id por petición, propagado a todos los logs de esa petición.
    // La app móvil puede mandar el suyo en `x-request-id` y así la traza
    // arranca en el toque del usuario, no en el borde del servidor.
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },

    customProps: () => ({
      service: 'api',
      env: env.NODE_ENV,
      version: env.GIT_SHA,
    }),

    // Los health checks inundan el log y no aportan nada.
    autoLogging: {
      ignore: (req) => {
        const url = req.url ?? '';
        return url === '/health' || url === '/ready' || url === '/metrics';
      },
    },

    serializers: {
      // Tipados explícitamente: pino los declara como `any`, y sin anotar,
      // cualquier error de nombre de campo pasa desapercibido hasta que el log
      // sale vacío en producción.
      req: (req: { method?: string; url?: string; headers?: Record<string, unknown> }) => ({
        method: req.method,
        url: req.url,
        // Nada de volcar todos los headers: es la vía más fácil a que se filtre
        // un Authorization por un cambio en la config de redacción.
        userAgent: req.headers?.['user-agent'],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },

    transport: transporteDeDesarrollo(),
  },
};

/**
 * Salida legible en desarrollo — sólo si `pino-pretty` realmente está.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ SE COMPRUEBA EN VEZ DE DARLO POR HECHO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Antes esto miraba únicamente `NODE_ENV === 'development'`. El problema es que
 * eso y la presencia del paquete son **dos cosas independientes**:
 *
 *   · `NODE_ENV` es una variable de entorno, la pone quien arranca el proceso.
 *   · `pino-pretty` es una dependencia de DESARROLLO, y la imagen de producción
 *     corre `pnpm prune --prod`, que la borra.
 *
 * Cuando no coinciden —arrancar la imagen de producción con
 * `NODE_ENV=development`, que es exactamente lo que uno hace para probarla
 * contra una base local— el proceso **muere al arrancar**:
 *
 *     Error: unable to determine transport target for "pino-pretty"
 *
 * Un mensaje que no menciona dependencias, ni `prune`, ni `NODE_ENV`. Cuesta
 * un rato largo llegar a que falta un paquete de desarrollo en una imagen que
 * no los tiene por diseño.
 *
 * Con `require.resolve` la pregunta pasa a ser la correcta: no "¿en qué entorno
 * creo que estoy?" sino "¿está el paquete?". Si no está, se cae a JSON, que es
 * menos cómodo de leer y funciona siempre.
 */
function transporteDeDesarrollo():
  | { target: string; options: Record<string, unknown> }
  | undefined {
  if (env.NODE_ENV !== 'development') return undefined;

  try {
    require.resolve('pino-pretty');
  } catch {
    // Por stderr y no por el logger: el logger es justo lo que se está
    // construyendo cuando corre esto.
    console.error(
      '[logger] pino-pretty no está instalado (imagen de producción con NODE_ENV=development): ' +
        'los logs salen en JSON.',
    );
    return undefined;
  }

  return {
    target: 'pino-pretty',
    options: { colorize: true, singleLine: false, translateTime: 'HH:MM:ss.l' },
  };
}
