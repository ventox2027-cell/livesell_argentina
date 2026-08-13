import { z } from 'zod';

/**
 * Contratos de entrada de autenticación.
 *
 * Regla que gobierna estos esquemas: **ningún campo de contraseña**. No hay
 * contraseñas en este producto. El acceso es por proveedor externo, y si
 * mañana alguien agrega un campo `password`, la conversación tiene que ser
 * sobre por qué, no sobre cómo hashearla.
 */

/** Datos del dispositivo. Llegan en cada login para poder cerrar sesiones. */
export const DeviceSchema = z.object({
  /**
   * Identificador estable del teléfono, generado por la app y guardado en el
   * almacenamiento local. NO es el ID de publicidad ni nada que identifique a
   * la persona entre aplicaciones distintas.
   */
  installId: z.string().min(8).max(128),
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().min(1).max(32),
  osVersion: z.string().min(1).max(64),
  model: z.string().max(96).optional(),
  /** Token de FCM. Opcional: la persona puede haber negado las notificaciones. */
  pushToken: z.string().min(16).max(512).optional(),
  timezone: z.string().max(64).default('America/Argentina/Buenos_Aires'),
});
export type DeviceDto = z.infer<typeof DeviceSchema>;

export const GoogleLoginSchema = z.object({
  idToken: z.string().min(32),
  device: DeviceSchema,
});
export type GoogleLoginDto = z.infer<typeof GoogleLoginSchema>;

export const AppleLoginSchema = z.object({
  idToken: z.string().min(32),
  /**
   * Apple entrega el nombre UNA SOLA VEZ, en la primera autorización, y fuera
   * del token. Si no se manda acá, la cuenta queda sin nombre para siempre.
   */
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  device: DeviceSchema,
});
export type AppleLoginDto = z.infer<typeof AppleLoginSchema>;

/**
 * Login de desarrollo. Sólo existe con `AUTH_DEV_LOGIN_ENABLED=true`, que la
 * configuración prohíbe en producción.
 */
export const DevLoginSchema = z.object({
  // .trim() antes de .email(): la gente pega el mail con un espacio al final
  // más seguido de lo que uno cree, y rechazarlo por eso es maltratar al que
  // se quiere registrar.
  email: z.string().trim().email(),
  firstName: z.string().min(1).max(80).default('Prueba'),
  lastName: z.string().min(1).max(80).default('Local'),
  role: z.enum(['buyer', 'seller', 'moderator', 'admin']).default('buyer'),
  device: DeviceSchema,
});
export type DevLoginDto = z.infer<typeof DevLoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(32).max(256),
});
export type RefreshDto = z.infer<typeof RefreshSchema>;

/**
 * Completar el perfil.
 *
 * Es el otro lado del onboarding ultrarrápido: entrar cuesta un toque, y los
 * datos que faltan se piden cuando hacen falta. El teléfono, antes de comprar.
 */
export const CompleteProfileSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    /** Se normaliza a E.164 en el servicio; acá se acepta como lo escriba. */
    phone: z.string().min(6).max(32).optional(),
    whatsappOptIn: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No hay nada que actualizar',
  });
export type CompleteProfileDto = z.infer<typeof CompleteProfileSchema>;

export const UpdatePushTokenSchema = z.object({
  installId: z.string().min(8).max(128),
  pushToken: z.string().min(16).max(512).nullable(),
  pushEnabled: z.boolean().default(true),
});
export type UpdatePushTokenDto = z.infer<typeof UpdatePushTokenSchema>;
