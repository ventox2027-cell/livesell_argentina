/// Qué producto se está mostrando en el vivo, según el vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// DESTACAR TARDABA DOS VIAJES EN SERIE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El vendedor tocaba un producto de la bandeja y:
///
///   1. `POST /live/:id/feature` — un viaje a Railway.
///   2. `GET /live/:id/panel`    — OTRO viaje, para enterarse de lo que acaba
///      de mandar.
///   3. Recién ahí cambiaba algo en su pantalla.
///
/// En medio de un vivo, con gente mirando, eso es una eternidad: el vendedor
/// dice «mirá este» y su propia pantalla tarda un segundo largo en acompañarlo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PROBLEMA DIFÍCIL NO ES LA VELOCIDAD: ES EL ORDEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Con red lenta, destacar A y enseguida B deja dos peticiones viajando. La
/// respuesta de A puede llegar DESPUÉS de la de B, y si cada respuesta pisa lo
/// que se muestra, el vivo termina exhibiendo A cuando el vendedor eligió B —
/// que es peor que la lentitud, porque nadie lo entiende y nadie lo reporta.
///
/// Por eso cada elección lleva un número. Una respuesta que no corresponde a la
/// última elección no toca nada: llegó tarde y ya no describe lo que se quiere
/// mostrar.
class DestacadoOptimista {
  const DestacadoOptimista({this.eleccion, this.secuencia = 0});

  /// Lo que el vendedor acaba de elegir, mientras el servidor no lo confirme.
  ///
  /// `null` significa que no hay elección pendiente y manda el servidor. Ojo
  /// con la diferencia: `(variantId: null)` sí es una elección — es «dejá de
  /// destacar», que es una acción tan válida como cualquier otra.
  final ({String? variantId})? eleccion;

  /// Cuántas elecciones van. Es lo que distingue una respuesta vieja.
  final int secuencia;

  bool get hayEleccionPendiente => eleccion != null;

  /// Qué variante mostrar, dado lo que dice el servidor.
  ///
  /// Mientras hay una elección pendiente manda ella. Es todo el efecto
  /// «inmediato»: la pantalla del vendedor cambia en el mismo frame del toque.
  String? mostrado(String? delServidor) =>
      eleccion != null ? eleccion!.variantId : delServidor;

  /// El vendedor eligió. Devuelve el estado nuevo y el número de este intento.
  DestacadoOptimista elegir(String? variantId) =>
      DestacadoOptimista(eleccion: (variantId: variantId), secuencia: secuencia + 1);

  /// El servidor contestó, y el panel dice `delServidor`.
  ///
  /// ⚠️ La elección local NO se suelta hasta que el panel diga lo mismo.
  /// Soltarla antes deja un hueco: entre que se suelta y llega el panel nuevo
  /// —hasta cinco segundos, que es cada cuánto se refresca— se ve el destacado
  /// ANTERIOR. El producto parpadea hacia atrás y vuelve.
  ///
  /// ─── Por qué acá NO hace falta mirar la secuencia ───
  ///
  /// La primera versión recibía además el número del intento y descartaba las
  /// respuestas viejas. Se sacó porque ningún sabotaje podía romperlo: la
  /// comparación con el panel ya hace ese trabajo.
  ///
  /// Si llega la respuesta de A cuando ya se eligió B, sólo hay dos casos. O el
  /// panel todavía dice A, y entonces no coincide con la elección —que es B— y
  /// no se suelta nada. O el panel ya dice B, y soltar es exactamente lo
  /// correcto: lo que se muestra y lo que hay en el servidor coinciden.
  ///
  /// En `fallo` sí hace falta, y ahí sí hay un test que lo demuestra.
  DestacadoOptimista confirmado({required String? delServidor}) {
    if (delServidor == eleccion?.variantId) return DestacadoOptimista(secuencia: secuencia);
    return this;
  }

  /// El intento `deSecuencia` falló.
  ///
  /// Se suelta la elección y vuelve a mandar el servidor: es el rollback. Si ya
  /// hay una elección más nueva, no se toca nada — el fracaso de la anterior no
  /// puede deshacer lo que el vendedor acaba de pedir.
  DestacadoOptimista fallo({required int deSecuencia}) {
    if (deSecuencia != secuencia) return this;
    return DestacadoOptimista(secuencia: secuencia);
  }
}
