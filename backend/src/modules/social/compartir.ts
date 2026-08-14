/**
 * Los enlaces que se comparten.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS ARMA EL BACKEND, NO LA APP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un enlace compartido sobrevive a la app que lo generó. Alguien lo manda por
 * WhatsApp hoy y lo abren en seis meses, con una versión que ya no existe.
 *
 * Si la app armara la URL, cada versión instalada tendría su propia idea de
 * cómo se ve un enlace de VendoX, y cambiar el formato significaría que los
 * enlaces viejos —los que están dando vueltas en chats— dejan de funcionar. Con
 * el backend armándolos, la app manda lo que le dan y el formato se cambia en
 * un lugar.
 *
 * ─── Por qué son URLs web y no deep links ───
 *
 * Un `vendox://` no se puede abrir si la app no está instalada, y compartir es
 * justamente cómo llega gente que todavía no la tiene. La URL web funciona para
 * todos: quien tiene la app la abre ahí —lo resuelve el sistema con los enlaces
 * asociados al dominio— y quien no, cae en una página que le muestra el
 * producto y le ofrece descargarla.
 *
 * ⚠️ Esa página web todavía no existe. Está anotada como deuda, y hasta que
 * exista un enlace compartido lleva a un 404. Los enlaces que se generen
 * mientras tanto van a funcionar cuando la página esté: el formato no cambia.
 *
 * Archivo puro: es armado de cadenas y tiene que poder probarse sin nada.
 */

export type CosaCompartible = 'live' | 'product' | 'store' | 'seller';

/**
 * Fuente del tráfico, para saber de dónde vino la gente.
 *
 * No es analítica de vanidad: sirve para responder "¿la gente que llega por un
 * enlace compartido compra?", que es lo que dice si vale la pena invertir en
 * que compartir sea más fácil.
 */
export type OrigenDeCompartido = 'app' | 'live' | 'perfil' | 'producto';

export interface EnlaceCompartido {
  /** La URL que se manda. */
  url: string;
  /** El texto que la acompaña en el mensaje. */
  texto: string;
}

/**
 * La URL canónica de algo.
 *
 * `baseUrl` viene de la configuración: en desarrollo apunta a otro lado, y
 * escribir el dominio a mano haría que los enlaces de prueba lleven a
 * producción.
 */
export function urlDe(
  baseUrl: string,
  cosa: CosaCompartible,
  identificador: string,
  origen?: OrigenDeCompartido,
): string {
  // Sin barra final duplicada: `https://vendox.com.ar//p/abc` funciona pero se
  // ve mal cuando alguien lo pega en un chat, y algunos previsualizadores lo
  // tratan como una URL distinta.
  const base = baseUrl.replace(/\/+$/, '');

  const ruta = {
    live: 'v',
    product: 'p',
    store: 't',
    seller: 'u',
  }[cosa];

  const url = new URL(`${base}/${ruta}/${encodeURIComponent(identificador)}`);
  if (origen) url.searchParams.set('src', origen);

  return url.toString();
}

/**
 * El mensaje completo, listo para compartir.
 *
 * ─── El texto va antes de la URL ───
 *
 * WhatsApp y la mayoría de las apps de mensajería previsualizan el ÚLTIMO
 * enlace del mensaje. Con la URL en el medio, la previsualización a veces no
 * aparece, y un mensaje compartido sin imagen se abre muchísimo menos.
 */
export function mensajeDeCompartido(params: {
  baseUrl: string;
  cosa: CosaCompartible;
  identificador: string;
  /** El nombre del producto, del vivo o de la tienda. */
  titulo: string;
  /** El precio ya formateado, si lo tiene. */
  precio?: string;
  origen?: OrigenDeCompartido;
}): EnlaceCompartido {
  const url = urlDe(params.baseUrl, params.cosa, params.identificador, params.origen);

  const texto = (() => {
    switch (params.cosa) {
      case 'live':
        // Presente y con urgencia: un vivo se comparte mientras pasa.
        return `${params.titulo} está en vivo ahora en VendoX`;
      case 'product':
        return params.precio
          ? `${params.titulo} — ${params.precio} en VendoX`
          : `${params.titulo} en VendoX`;
      case 'store':
      case 'seller':
        return `Mirá lo que vende ${params.titulo} en VendoX`;
    }
  })();

  return { url, texto: `${texto}\n${url}` };
}
