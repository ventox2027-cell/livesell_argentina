'use client';

/**
 * Cliente del backend de VendoX.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL PANEL NO TIENE LÓGICA DE NEGOCIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que hace este archivo es mandar peticiones y devolver lo que llegue.
 * No decide si un vendedor se puede suspender, no calcula comisiones, no
 * interpreta estados. Eso vive en el backend, que es la autoridad, y duplicarlo
 * acá crearía dos versiones de las reglas que el día que difieran dejan a nadie
 * sabiendo cuál vale.
 *
 * El panel es una ventana, no un segundo sistema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DÓNDE VIVE EL TOKEN Y POR QUÉ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * En `localStorage`. Es una decisión con una contrapartida conocida: un XSS en
 * esta aplicación podría leerlo.
 *
 * Se acepta porque:
 *
 *   · Es una herramienta interna, sin contenido generado por usuarios. Lo único
 *     que se renderiza de terceros son textos que React escapa por omisión.
 *   · La alternativa —cookie httpOnly— exige que el backend emita cookies para
 *     este origen, con CSRF y CORS propios. Es más seguro y es trabajo real que
 *     no corresponde meter en la V1 de un panel que corre en localhost.
 *   · El access token dura 15 minutos y el rol se verifica **en la base en cada
 *     petición**: un token robado deja de servir en cuanto se le saca el rol a
 *     esa persona, sin esperar a que expire.
 *
 * Cuando el panel salga a un dominio público, esto pasa a cookie httpOnly.
 * Está anotado como deuda en `docs/ADMIN-LITE.md`.
 */

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3100';

const CLAVE_ACCESO = 'vendox.admin.accessToken';
const CLAVE_REFRESCO = 'vendox.admin.refreshToken';

export function guardarSesion(accessToken: string, refreshToken: string): void {
  localStorage.setItem(CLAVE_ACCESO, accessToken);
  localStorage.setItem(CLAVE_REFRESCO, refreshToken);
}

export function borrarSesion(): void {
  localStorage.removeItem(CLAVE_ACCESO);
  localStorage.removeItem(CLAVE_REFRESCO);
}

export function haySesion(): boolean {
  return typeof window !== 'undefined' && !!localStorage.getItem(CLAVE_ACCESO);
}

export class ErrorApi extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    mensaje: string,
    readonly detalles?: unknown,
  ) {
    super(mensaje);
  }
}

/**
 * Un solo refresco a la vez.
 *
 * Cuando el token vence, la pantalla suele tener tres o cuatro peticiones en
 * vuelo y todas reciben 401 casi al mismo tiempo. Sin esta promesa compartida,
 * cada una dispararía su propio refresco: el backend rota el refresh token en
 * cada uso, así que el segundo llegaría con uno ya consumido, fallaría, y la
 * sesión se cerraría sola en medio del trabajo.
 */
let refrescoEnCurso: Promise<boolean> | null = null;

async function refrescar(): Promise<boolean> {
  refrescoEnCurso ??= (async () => {
    try {
      const refreshToken = localStorage.getItem(CLAVE_REFRESCO);
      if (!refreshToken) return false;

      const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;

      const datos = (await res.json()) as { accessToken: string; refreshToken: string };
      guardarSesion(datos.accessToken, datos.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // Se libera en el microtask siguiente para que las peticiones que
      // llegaron durante el refresco compartan ESTE resultado.
      queueMicrotask(() => {
        refrescoEnCurso = null;
      });
    }
  })();

  return refrescoEnCurso;
}

async function pedir<T>(
  metodo: string,
  ruta: string,
  cuerpo?: unknown,
  reintentando = false,
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem(CLAVE_ACCESO);
  if (token) headers.authorization = `Bearer ${token}`;
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers,
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });

  if (res.status === 401 && !reintentando) {
    if (await refrescar()) return pedir<T>(metodo, ruta, cuerpo, true);

    borrarSesion();

    /**
     * Recarga completa, no navegación de Next.
     *
     * El linter prefiere `router.push()` para rutas internas, y para navegar
     * tiene razón. Acá no se está navegando: se está descartando una sesión.
     *
     * Una navegación del enrutador conserva el estado en memoria de toda la
     * aplicación —datos ya cargados, resultados de búsqueda, formularios a
     * medio llenar— que pertenecen a una sesión que dejó de existir. Un
     * `location.href` tira todo eso, que es exactamente lo que corresponde.
     *
     * Además esto vive en el cliente de API, fuera del árbol de React, donde no
     * hay `router` al que llamar.
     */
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = '/login';
    }
    throw new ErrorApi(401, 'INVALID_TOKEN', 'La sesión venció');
  }

  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;

    throw new ErrorApi(
      res.status,
      error?.error?.code ?? 'ERROR',
      error?.error?.message ?? `Error ${res.status}`,
      error?.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(ruta: string) => pedir<T>('GET', ruta),
  post: <T>(ruta: string, cuerpo?: unknown) => pedir<T>('POST', ruta, cuerpo ?? {}),
};

/** Entra con el login de desarrollo. Sólo existe si el backend lo habilita. */
export async function entrarModoPrueba(email: string) {
  const res = await fetch(`${BASE}/api/v1/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      firstName: 'Admin',
      lastName: 'VendoX',
      device: {
        installId: `admin-web-${email}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: 'web',
      },
    }),
  });

  const datos = (await res.json()) as {
    accessToken?: string;
    refreshToken?: string;
    user?: { role: string };
    error?: { message?: string };
  };

  if (!res.ok || !datos.accessToken || !datos.refreshToken) {
    throw new Error(datos.error?.message ?? 'No se pudo entrar');
  }

  guardarSesion(datos.accessToken, datos.refreshToken);
  return datos.user;
}

export async function configDeAuth() {
  const res = await fetch(`${BASE}/api/v1/auth/config`);
  return (await res.json()) as { devLoginEnabled: boolean };
}

// ─── Tipos de lo que devuelve el panel ───────────────────────────────────────
//
// Escritos a mano y no generados: son pocos y estables, y un generador de
// tipos desde OpenAPI es infraestructura que todavía no se gana su lugar.

export interface Pagina<T> {
  items: T[];
  siguienteCursor: string | null;
}

export interface Atencion {
  pagosInciertos: number;
  devolucionesFallidas: number;
  devolucionesPendientes: number;
  ordenesPorDevolver: number;
  webhooksConError: number;
  vendedoresSuspendidos: number;
  vendedoresPendientes: number;
}

export interface Usuario {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  rol: string;
  estado: string;
  creadoEl: string;
  ultimaActividadEl: string | null;
}

export interface Vendedor {
  id: string;
  userId: string;
  nombre: string;
  slug: string;
  estado: string;
  verificacion: string;
  creadoEl: string;
}

export interface Producto {
  id: string;
  nombre: string;
  estado: string;
  storeId: string;
  precioBaseCentavos: number;
  creadoEl: string;
}

export interface Orden {
  id: string;
  referencia: string;
  estado: string;
  motivoEstado: string | null;
  buyerId: string;
  sellerId: string;
  dinero: {
    subtotal: number;
    envio: number;
    descuento: number;
    total: number;
    comisionPlataforma: number;
    comisionProcesador: number | null;
    netoVendedor: number;
  };
  creadaEl: string;
  pagadaEl: string | null;
  confirmadaEl: string | null;
}

export interface Pago {
  id: string;
  orderId: string;
  estado: string;
  proveedor: string;
  providerPaymentId: string | null;
  montoCentavos: number;
  tarjeta: { marca: string | null; ultimos4: string | null } | null;
  fallo: { codigo: string; mensaje: string | null } | null;
  creadoEl: string;
  aprobadoEl: string | null;
  ultimaConsultaEl: string | null;
}

export interface Devolucion {
  id: string;
  orderId: string;
  paymentAttemptId: string;
  estado: string;
  montoCentavos: number;
  motivo: string;
  ultimoError: string | null;
  intentos: number;
  creadaEl: string;
  completadaEl: string | null;
}

export interface Webhook {
  id: string;
  proveedor: string;
  notificationId: string;
  tema: string;
  accion: string | null;
  recursoId: string | null;
  firmaValida: boolean;
  procesadoEl: string | null;
  error: string | null;
  recibidoEl: string;
}

export interface RegistroAuditoria {
  id: string;
  actorTipo: string;
  actorId: string | null;
  accion: string;
  entidad: string;
  entidadId: string;
  motivo: string | null;
  antes: unknown;
  despues: unknown;
  fecha: string;
}

export interface EventoTimeline {
  fecha: string;
  tipo: string;
  titulo: string;
  detalle: string | null;
  nivel: 'ok' | 'aviso' | 'error' | 'neutro';
  refTipo?: string;
  refId?: string;
}

export interface Busqueda {
  interpretadoComo: string;
  usuarios: Usuario[];
  vendedores: Vendedor[];
  productos: Producto[];
  ordenes: Orden[];
  pagos: Pago[];
  devoluciones: Devolucion[];
}
