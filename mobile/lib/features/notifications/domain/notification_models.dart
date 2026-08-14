/// Un aviso del centro de notificaciones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL TEXTO VIENE ESCRITO, NO SE ARMA ACÁ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend manda `title` y `body` ya resueltos. La app no tiene plantillas.
///
/// Es a propósito: un aviso tiene que decir lo mismo dentro de un año. Una
/// plantilla renderizada al leer diría "Tu pedido de {producto}" con el nombre
/// ACTUAL del producto —que el vendedor pudo haber cambiado— y para un producto
/// archivado no diría nada.
class Aviso {
  const Aviso({
    required this.id,
    required this.tipo,
    required this.titulo,
    required this.cuerpo,
    required this.fecha,
    required this.datos,
    this.leidoEl,
  });

  factory Aviso.fromJson(Map<String, dynamic> j) {
    /// `data` viene como mapa de texto a texto. FCM sólo acepta texto, así que
    /// el backend ya lo convierte todo: acá no hay números que parsear.
    final datos = <String, String>{};
    final crudo = j['data'];
    if (crudo is Map) {
      for (final e in crudo.entries) {
        final valor = e.value;
        if (valor != null) datos[e.key.toString()] = valor.toString();
      }
    }

    return Aviso(
      id: j['id'] as String? ?? '',
      tipo: j['type'] as String? ?? 'ACCOUNT',
      titulo: j['title'] as String? ?? '',
      cuerpo: j['body'] as String? ?? '',
      fecha: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
      leidoEl: DateTime.tryParse(j['readAt'] as String? ?? ''),
      datos: datos,
    );
  }

  final String id;

  /// `STORE_REOPENED`, `ORDER_STATUS`, `LIVE_STARTED`… Lo define el backend.
  ///
  /// Se guarda como texto y no como enum: un tipo nuevo del servidor no puede
  /// hacer que la app reviente al leer la lista. Los que no reconoce caen en el
  /// caso por omisión y se muestran igual — el título y el cuerpo ya vienen
  /// escritos, así que se entienden sin que la app sepa qué son.
  final String tipo;

  final String titulo;
  final String cuerpo;
  final DateTime fecha;
  final DateTime? leidoEl;

  /// A dónde lleva tocarlo: `{tipo: 'order', orderId: 'ord_...'}`.
  final Map<String, String> datos;

  bool get sinLeer => leidoEl == null;

  /// El id de la entidad a la que apunta, si apunta a alguna.
  String? get destinoId => datos['orderId'] ?? datos['productId'] ?? datos['liveSessionId'];

  /// Qué clase de cosa es el destino. `null` si el aviso no lleva a ningún lado.
  String? get destinoTipo => datos['tipo'];

  Aviso comoLeido(DateTime cuando) => Aviso(
        id: id,
        tipo: tipo,
        titulo: titulo,
        cuerpo: cuerpo,
        fecha: fecha,
        datos: datos,
        leidoEl: leidoEl ?? cuando,
      );
}

/// Una página del centro de notificaciones.
class PaginaDeAvisos {
  const PaginaDeAvisos({required this.items, required this.sinLeer, this.nextCursor});

  factory PaginaDeAvisos.fromJson(Map<String, dynamic> j) => PaginaDeAvisos(
        items: (j['items'] as List<dynamic>? ?? const [])
            .map((e) => Aviso.fromJson(e as Map<String, dynamic>))
            .toList(),
        sinLeer: (j['sinLeer'] as num?)?.toInt() ?? 0,
        nextCursor: j['nextCursor'] as String?,
      );

  final List<Aviso> items;

  /// El número del globito. Viene con cada página para que no haga falta una
  /// segunda petición sólo para pintarlo.
  final int sinLeer;

  final String? nextCursor;
}
