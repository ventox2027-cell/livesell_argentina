/// Acumular toques de stock y mandarlos de a uno.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA PARTE DONDE SE PUEDE PERDER STOCK
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Consolidar toques es fácil de escribir mal de una manera que no se nota: los
/// toques que llegan MIENTRAS una petición viaja tienen que sobrevivir. Si se
/// pisan, el vendedor ve 8 en pantalla, el servidor guarda 5, y el error recién
/// aparece cuando alguien compra y no hay.
///
/// Por eso la aritmética vive acá, separada del widget, y se prueba sola. La
/// pantalla decide cuándo llamar; esto decide qué se manda.
///
/// ⚠️ Esto NO es autoridad de stock. PostgreSQL sigue siendo el único que
/// decide cuánto hay: acá sólo se junta lo que el dedo pidió para no hacer una
/// petición por toque. El backend aplica `on_hand = on_hand + delta` de forma
/// atómica, así que mandar `+4` una vez y `+1` cuatro veces terminan igual.
class AjustesAcumulados {
  int _pendiente = 0;
  bool _enVuelo = false;

  /// Lo que se tocó y todavía no salió.
  int get pendiente => _pendiente;

  /// Si hay una petición en el aire.
  bool get enVuelo => _enVuelo;

  /// Si todavía queda algo por resolver: sin esto, un refresco del servidor
  /// pisaría los toques que la persona dio mientras la petición viajaba.
  bool get hayTrabajo => _pendiente != 0 || _enVuelo;

  /// Registra un toque.
  void sumar(int delta) => _pendiente += delta;

  /// Toma lo acumulado para mandarlo, o `null` si no hay nada que mandar.
  ///
  /// Limpia el pendiente ANTES de que la petición salga: los toques que lleguen
  /// mientras viaja se acumulan para la próxima tanda en vez de perderse.
  ///
  /// Devuelve `null` también si ya hay algo en el aire. Dos peticiones
  /// simultáneas de la misma variante llegarían en cualquier orden, y aunque el
  /// resultado final sería el mismo —los deltas son relativos—, el refresco
  /// intermedio haría saltar el número en pantalla.
  int? tomar() {
    if (_enVuelo || _pendiente == 0) return null;
    final delta = _pendiente;
    _pendiente = 0;
    _enVuelo = true;
    return delta;
  }

  /// La petición terminó bien.
  void confirmar() => _enVuelo = false;

  /// La petición falló.
  ///
  /// ⚠️ Se descarta TAMBIÉN lo que quedó pendiente, y es a propósito.
  ///
  /// Si el ajuste que viajaba no entró, los toques posteriores se calcularon
  /// sobre un número que nunca existió. Mandarlos igual dejaría el stock en un
  /// valor que nadie pidió: el vendedor tocó `+3` sobre lo que creía que eran
  /// 5, pero el servidor sigue en 2.
  ///
  /// Se vuelve a lo que dice el servidor y se le avisa. Perder tres toques es
  /// molesto; guardar un stock que nadie eligió se descubre cuando alguien
  /// compra y no hay.
  void fallar() {
    _enVuelo = false;
    _pendiente = 0;
  }

  /// Lo que quedó sin mandar al cerrar la pantalla.
  ///
  /// Salir dos décimas después de tocar `+` es lo más normal del mundo, y
  /// perder ese toque haría que el stock que el vendedor vio no sea el que
  /// quedó guardado.
  int? alSalir() {
    if (_pendiente == 0) return null;
    final delta = _pendiente;
    _pendiente = 0;
    return delta;
  }
}
