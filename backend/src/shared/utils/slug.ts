/**
 * Generación de slugs.
 *
 * Un slug es la parte visible de la URL: `vendox.com/cancerianas`. Tiene que
 * ser estable, legible y seguro.
 */

/**
 * Slugs que NO puede tomar un vendedor ni una tienda.
 *
 * ─── Por qué esta lista existe y por qué está acá ───
 *
 * Sin ella, alguien registra la tienda `admin` y su URL pasa a ser
 * `vendox.com/admin`. Si mañana el panel vive en esa ruta, hay un conflicto
 * imposible de resolver sin renombrarle la tienda a una persona que ya la
 * estaba usando.
 *
 * Peor todavía: alguien registra `login` o `soporte` y monta una página que
 * imita la nuestra. La víctima ve un dominio legítimo.
 *
 * Está centralizada a propósito: repartir esta lista por cada módulo garantiza
 * que un día alguien agregue una ruta nueva y se olvide de reservarla.
 */
export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set([
  // Rutas de la plataforma
  'admin', 'administrador', 'api', 'app', 'auth', 'login', 'logout', 'signin',
  'signup', 'register', 'registro', 'account', 'cuenta', 'settings', 'config',
  'configuracion', 'dashboard', 'panel',

  // Producto
  'live', 'lives', 'vivo', 'envivo', 'feed', 'search', 'buscar', 'explore',
  'explorar', 'product', 'productos', 'producto', 'store', 'stores', 'tienda',
  'tiendas', 'seller', 'sellers', 'vendedor', 'vendedores', 'order', 'orders',
  'pedido', 'pedidos', 'checkout', 'cart', 'carrito', 'pay', 'pago', 'pagos',
  'payment', 'payments',

  // Institucional y soporte
  'help', 'ayuda', 'support', 'soporte', 'contact', 'contacto', 'about',
  'nosotros', 'terms', 'terminos', 'privacy', 'privacidad', 'legal', 'faq',
  'blog', 'news', 'novedades', 'press', 'prensa', 'jobs', 'trabajo',

  // Técnicas y de infraestructura
  'www', 'mail', 'email', 'ftp', 'cdn', 'static', 'assets', 'media', 'img',
  'images', 'files', 'download', 'downloads', 'webhook', 'webhooks', 'health',
  'ready', 'metrics', 'status', 'graphql', 'ws', 'socket', 'null', 'undefined',
  'true', 'false',

  // Marca
  'vendox', 'livesell', 'oficial', 'official', 'verified', 'verificado',
]);

/** Longitudes. Un slug de un carácter es inútil y uno de 80 no se comparte. */
export const SLUG_MIN = 3;
export const SLUG_MAX = 48;

/**
 * Convierte texto libre en un slug.
 *
 *   "Remera Oversize Negra"  →  "remera-oversize-negra"
 *   "Café & Té"              →  "cafe-te"
 *   "  ¡¡Ofertón!!  "        →  "oferton"
 *
 * Las tildes y la eñe se normalizan con NFD: `café` y `cafe` tienen que dar el
 * mismo slug, porque nadie escribe la tilde al buscar una URL.
 */
export function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    // Quita los diacríticos que NFD separó del carácter base.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // La ñ ya quedó como "n" arriba; esto cubre otros caracteres compuestos.
    .replace(/[^a-z0-9]+/g, '-')
    // Guiones al principio o al final quedan feos en una URL.
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // El corte anterior puede dejar un guion suelto al final.
    .replace(/-+$/g, '');
}

export function esSlugReservado(slug: string): boolean {
  return SLUGS_RESERVADOS.has(slug.toLowerCase());
}

/**
 * ¿Tiene forma válida?
 *
 * Se rechazan los que parecen un id: `usr_01ABC` o un UUID en la URL confunden
 * a quien lo lee y chocan con rutas internas.
 */
export function esSlugValido(slug: string): boolean {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return false;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return false;
  // Prefijos de nuestros ids.
  if (/^(usr|sel|sto|prd|var|img|opt|opv|ord|pay|cat)-/.test(slug)) return false;
  // Sólo números se confunde con un id numérico.
  if (/^\d+$/.test(slug)) return false;
  return true;
}

/**
 * Encuentra un slug libre agregando un sufijo numérico.
 *
 *   remera-negra  →  remera-negra-2  →  remera-negra-3
 *
 * `estaLibre` lo provee quien llama porque el alcance de unicidad cambia según
 * la entidad: los de vendedor y tienda son globales, los de producto son
 * únicos dentro de la tienda.
 *
 * ⚠️ Esto NO garantiza unicidad por sí solo. Entre la comprobación y la
 * inserción hay una ventana de carrera. La garantía real es el índice UNIQUE
 * de la base; esto sólo evita chocar con él en el caso normal.
 */
export async function slugDisponible(
  base: string,
  estaLibre: (candidato: string) => Promise<boolean>,
  maxIntentos = 50,
): Promise<string> {
  const raiz = slugify(base) || 'sin-nombre';

  for (let i = 1; i <= maxIntentos; i += 1) {
    const candidato = i === 1 ? raiz : `${raiz}-${i}`;
    if (esSlugReservado(candidato)) continue;
    if (await estaLibre(candidato)) return candidato;
  }

  // Tras 50 intentos se agrega ruido. Es preferible a un bucle infinito o a
  // devolver algo que va a fallar contra el índice.
  return `${raiz}-${Math.random().toString(36).slice(2, 8)}`;
}
