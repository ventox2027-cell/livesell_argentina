// Lo que necesita quien transmite.
//
// Misma disciplina que `live_models.dart`: cada campo se lee a la defensiva,
// siempre `as X?` con un valor por omisión. Un campo faltante tiene que dar un
// texto vacío o un cero, nunca tumbar la pantalla — y acá menos que en ningún
// lado, porque del otro lado hay alguien transmitiendo en vivo.

/// Una variante en la bandeja del vendedor.
class VarianteEnBandeja {
  const VarianteEnBandeja({
    required this.id,
    required this.precioCentavos,
    required this.disponible,
    this.etiqueta,
  });

  factory VarianteEnBandeja.fromJson(Map<String, dynamic> j) => VarianteEnBandeja(
        id: j['id'] as String? ?? '',
        // `null` cuando es la variante interna del producto: no hay nada que
        // elegir, así que no hay nada que nombrar.
        etiqueta: j['etiqueta'] as String?,
        precioCentavos: (j['precioCentavos'] as num?)?.toInt() ?? 0,
        disponible: (j['disponible'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String? etiqueta;
  final int precioCentavos;
  final int disponible;

  bool get agotada => disponible <= 0;
}

/// Un producto preparado para el vivo.
class ProductoEnBandeja {
  const ProductoEnBandeja({
    required this.productId,
    required this.nombre,
    required this.variantes,
    required this.vendible,
    this.imagenUrl,
    this.vecesDestacado = 0,
  });

  factory ProductoEnBandeja.fromJson(Map<String, dynamic> j) => ProductoEnBandeja(
        productId: j['productId'] as String? ?? '',
        nombre: j['nombre'] as String? ?? '',
        imagenUrl: j['imagenUrl'] as String?,
        vecesDestacado: (j['vecesDestacado'] as num?)?.toInt() ?? 0,
        vendible: j['vendible'] as bool? ?? true,
        variantes: (j['variantes'] as List<dynamic>? ?? const [])
            .map((v) => VarianteEnBandeja.fromJson(v as Map<String, dynamic>))
            .toList(),
      );

  final String productId;
  final String nombre;
  final String? imagenUrl;
  final int vecesDestacado;

  /// `false` si el producto está pausado o borrado.
  ///
  /// Sigue en la bandeja a propósito: el vendedor lo preparó y sacarlo de la
  /// lista lo dejaría sin entender por qué desapareció. Se muestra apagado.
  final bool vendible;

  final List<VarianteEnBandeja> variantes;

  /// Suma de lo disponible en todas sus variantes.
  int get disponibleTotal => variantes.fold(0, (t, v) => t + v.disponible);

  bool get agotado => disponibleTotal <= 0;

  /// Qué variante se destaca al tocar el producto.
  ///
  /// La primera con stock; si están todas agotadas, la primera igual — así el
  /// vendedor puede mostrarla y decir "se agotó" en vez de no poder tocarla.
  VarianteEnBandeja? get variantePorDefecto {
    if (variantes.isEmpty) return null;
    return variantes.firstWhere((v) => !v.agotada, orElse: () => variantes.first);
  }
}

/// Las ventas ocurridas durante el vivo.
class VentasDelVivo {
  const VentasDelVivo({
    required this.ordenes,
    required this.brutoCentavos,
    required this.unidades,
  });

  factory VentasDelVivo.fromJson(Map<String, dynamic>? j) => VentasDelVivo(
        ordenes: (j?['ordenes'] as num?)?.toInt() ?? 0,
        brutoCentavos: (j?['brutoCentavos'] as num?)?.toInt() ?? 0,
        unidades: (j?['unidades'] as num?)?.toInt() ?? 0,
      );

  final int ordenes;
  final int brutoCentavos;
  final int unidades;

  bool get hubo => ordenes > 0;
}

/// Todo lo que la pantalla del vendedor muestra mientras transmite.
class PanelDelVivo {
  const PanelDelVivo({
    required this.id,
    required this.titulo,
    required this.estado,
    required this.duracionSegundos,
    required this.espectadores,
    required this.ventas,
    required this.bandeja,
    this.destacadoVariantId,
    this.espectadoresPico,
  });

  factory PanelDelVivo.fromJson(Map<String, dynamic> j) => PanelDelVivo(
        id: j['id'] as String? ?? '',
        titulo: j['titulo'] as String? ?? '',
        estado: j['estado'] as String? ?? 'SCHEDULED',
        duracionSegundos: (j['duracionSegundos'] as num?)?.toInt() ?? 0,
        espectadores: (j['espectadores'] as num?)?.toInt() ?? 0,
        espectadoresPico: (j['espectadoresPico'] as num?)?.toInt(),
        destacadoVariantId: j['destacadoVariantId'] as String?,
        ventas: VentasDelVivo.fromJson(j['ventas'] as Map<String, dynamic>?),
        bandeja: (j['bandeja'] as List<dynamic>? ?? const [])
            .map((b) => ProductoEnBandeja.fromJson(b as Map<String, dynamic>))
            .toList(),
      );

  final String id;
  final String titulo;
  final String estado;
  final int duracionSegundos;
  final int espectadores;
  final int? espectadoresPico;
  final String? destacadoVariantId;
  final VentasDelVivo ventas;
  final List<ProductoEnBandeja> bandeja;

  bool get alAire => estado == 'LIVE' || estado == 'RECONNECTING';
  bool get reconectando => estado == 'RECONNECTING';
  bool get terminado => estado == 'ENDED' || estado == 'FAILED';
}

/// Lo que devuelve preparar un vivo: el contexto y la credencial de video.
class VivoPreparado {
  const VivoPreparado({
    required this.id,
    required this.titulo,
    required this.estado,
    required this.productos,
    required this.token,
    required this.wsUrl,
    required this.sala,
  });

  factory VivoPreparado.fromJson(Map<String, dynamic> j) {
    final video = j['video'] as Map<String, dynamic>? ?? const {};
    return VivoPreparado(
      id: j['id'] as String? ?? '',
      titulo: j['titulo'] as String? ?? '',
      estado: j['estado'] as String? ?? 'SCHEDULED',
      productos: (j['productos'] as List<dynamic>? ?? const [])
          .map((p) => p as String? ?? '')
          .where((s) => s.isNotEmpty)
          .toList(),
      token: video['token'] as String? ?? '',
      wsUrl: video['wsUrl'] as String? ?? '',
      sala: video['sala'] as String? ?? '',
    );
  }

  final String id;
  final String titulo;
  final String estado;
  final List<String> productos;

  /// ⚠️ Credencial de publicación, emitida por el backend para esta persona y
  /// esta sala. **Nunca se arma en la app** y nunca sale de acá.
  final String token;
  final String wsUrl;
  final String sala;

  bool get puedeConectar => token.isNotEmpty && wsUrl.isNotEmpty;
}

/// El vivo abierto del vendedor, si tiene uno.
class MiVivoAbierto {
  const MiVivoAbierto({required this.id, required this.titulo, required this.estado});

  static MiVivoAbierto? fromJson(Map<String, dynamic> j) {
    final v = j['vivo'] as Map<String, dynamic>?;
    if (v == null) return null;
    return MiVivoAbierto(
      id: v['id'] as String? ?? '',
      titulo: v['titulo'] as String? ?? '',
      estado: v['estado'] as String? ?? 'SCHEDULED',
    );
  }

  final String id;
  final String titulo;
  final String estado;

  /// ¿Ya salió al aire, o quedó preparado sin empezar?
  bool get alAire => estado == 'LIVE' || estado == 'RECONNECTING';
}

/// El resumen que se muestra al terminar.
class ResumenDelVivo {
  const ResumenDelVivo({
    required this.ordenes,
    required this.unidades,
    required this.brutoCentavos,
    this.duracionSegundos,
    this.espectadoresPico,
  });

  factory ResumenDelVivo.fromJson(Map<String, dynamic> j) {
    final r = j['resumen'] as Map<String, dynamic>? ?? const {};
    return ResumenDelVivo(
      duracionSegundos: (r['duracionSegundos'] as num?)?.toInt(),
      // `null` es "no se midió", y se muestra distinto de cero. La regla del
      // proyecto es no inventar métricas.
      espectadoresPico: (r['espectadoresPico'] as num?)?.toInt(),
      ordenes: (r['ordenes'] as num?)?.toInt() ?? 0,
      unidades: (r['unidades'] as num?)?.toInt() ?? 0,
      brutoCentavos: (r['brutoCentavos'] as num?)?.toInt() ?? 0,
    );
  }

  final int? duracionSegundos;
  final int? espectadoresPico;
  final int ordenes;
  final int unidades;
  final int brutoCentavos;

  bool get huboVentas => ordenes > 0;
}

/// Segundos a `MM:SS` o `H:MM:SS`.
String comoDuracion(int segundos) {
  final s = segundos < 0 ? 0 : segundos;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final seg = s % 60;
  final mm = m.toString().padLeft(2, '0');
  final ss = seg.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
}
