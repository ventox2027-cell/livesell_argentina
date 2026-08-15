import { z } from 'zod';

/**
 * Contratos del panel de administración.
 *
 * ─── Comandos explícitos, no mutaciones genéricas ───
 *
 * No hay `PATCH /admin/sellers/:id` con `{ status: "loQueSea" }`. Cada acción
 * es su propio endpoint: `/suspend`, `/reactivate`, `/block`.
 *
 * Con una mutación genérica, el conjunto de transiciones posibles es el
 * producto cartesiano de todos los estados, y la mayoría no tiene sentido —
 * pero el endpoint las acepta igual. Con comandos, cada transición se escribe
 * una vez, se valida una vez, y la auditoría dice qué se hizo en vez de qué
 * campo cambió.
 */

/**
 * El motivo, obligatorio en toda acción administrativa.
 *
 * ─── Por qué 10 caracteres y no 1 ───
 *
 * Porque el objetivo no es tener el campo lleno: es que sirva dentro de seis
 * meses. Un mínimo de 1 se satisface con "x" y deja la bitácora tan inútil
 * como si no existiera, con la diferencia de que ahora parece completa.
 *
 * Diez fuerza una frase corta. No garantiza calidad —nada la garantiza— pero
 * descarta el relleno reflejo.
 *
 * ─── Por qué no hay una lista de motivos predefinidos ───
 *
 * Se evaluó. Un desplegable con "fraude / spam / pedido del usuario" es más
 * rápido de completar y mucho peor de leer después: el caso real casi nunca
 * encaja, y quien opera elige el que menos se aleja. Ahí la bitácora dice una
 * categoría que no es la verdad.
 *
 * Cuando haya volumen suficiente para saber cuáles son las categorías reales,
 * se puede agregar una junto al texto libre. No antes.
 */
export const MotivoSchema = z
  .string()
  .trim()
  .min(10, 'El motivo tiene que explicar qué pasó (mínimo 10 caracteres)')
  .max(500);

export const AccionAdminSchema = z.object({
  reason: MotivoSchema,
});
export type AccionAdminDto = z.infer<typeof AccionAdminSchema>;

/**
 * Otorgar VendoX Pro.
 *
 * ⚠️ No hay campo de precio ni de proveedor de pago, y no es un olvido: la
 * membresía está separada del cobro a propósito. Ver `sellers/membresias.ts`.
 *
 * El motivo es obligatorio como en el resto del panel. Acá pesa más que en
 * otras acciones: esto regala dinero, y dentro de un año nadie va a acordarse
 * de por qué este vendedor tiene Pro gratis.
 */
export const OtorgarProSchema = z.object({
  periodo: z.enum(['MENSUAL', 'ANUAL']),
  /**
   * `PAGO` está permitido para poder registrar un cobro hecho por fuera —una
   * transferencia, una factura— sin que el backend tenga que saber procesarlo.
   */
  origen: z.enum(['CORTESIA', 'PRUEBA', 'PAGO']),
  reason: MotivoSchema,
});
export type OtorgarProDto = z.infer<typeof OtorgarProSchema>;

/**
 * Paginación por cursor.
 *
 * No hay `?page=847`. Con OFFSET, la base tiene que recorrer y descartar las
 * 8.470 filas anteriores en cada consulta, y además el contenido se corre bajo
 * los pies de quien pagina: una orden nueva empuja todo y la página siguiente
 * repite lo que ya se vio.
 *
 * El cursor es el id del último elemento. La base salta directo por índice y
 * el orden es estable aunque entren filas nuevas.
 */
export const PaginaSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginaDto = z.infer<typeof PaginaSchema>;

/**
 * La búsqueda global.
 *
 * ⚠️ Mínimo tres caracteres, y no es cosmético.
 *
 * Con uno solo, `email LIKE '%a%'` devuelve prácticamente todos los usuarios
 * de la plataforma: un escaneo completo de tabla y un volcado de datos
 * personales por accidente. El mínimo convierte la búsqueda en una
 * herramienta para encontrar algo conocido, que es lo que soporte necesita, y
 * no en un listador de la base entera.
 */
export const BusquedaSchema = z.object({
  q: z.string().trim().min(3, 'Escribí al menos 3 caracteres').max(200),
});
export type BusquedaDto = z.infer<typeof BusquedaSchema>;

export const ListaOrdenesSchema = PaginaSchema.extend({
  status: z.string().max(40).optional(),
  sellerId: z.string().max(64).optional(),
  buyerId: z.string().max(64).optional(),
});
export type ListaOrdenesDto = z.infer<typeof ListaOrdenesSchema>;

export const ListaPagosSchema = PaginaSchema.extend({
  status: z.string().max(40).optional(),
  orderId: z.string().max(64).optional(),
});
export type ListaPagosDto = z.infer<typeof ListaPagosSchema>;

export const ListaDevolucionesSchema = PaginaSchema.extend({
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});
export type ListaDevolucionesDto = z.infer<typeof ListaDevolucionesSchema>;

export const ListaWebhooksSchema = PaginaSchema.extend({
  provider: z.enum(['mercadopago', 'livekit']).optional(),
  processed: z.enum(['true', 'false']).optional(),
});
export type ListaWebhooksDto = z.infer<typeof ListaWebhooksSchema>;

export const ListaAuditoriaSchema = PaginaSchema.extend({
  actorId: z.string().max(64).optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
});
export type ListaAuditoriaDto = z.infer<typeof ListaAuditoriaSchema>;

export const ListaUsuariosSchema = PaginaSchema.extend({
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  role: z.enum(['buyer', 'seller', 'moderator', 'admin']).optional(),
});
export type ListaUsuariosDto = z.infer<typeof ListaUsuariosSchema>;

export const ListaVendedoresSchema = PaginaSchema.extend({
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'CLOSED']).optional(),
});
export type ListaVendedoresDto = z.infer<typeof ListaVendedoresSchema>;
