// Modelos del vivo, la tienda y el vendedor.
//
// ═══════════════════════════════════════════════════════════════════════════
// CADA CAMPO SE LEE A LA DEFENSIVA
// ═══════════════════════════════════════════════════════════════════════════
//
// Siempre `as X?` con un valor por omisión, nunca `as X` a secas.
//
// No es paranoia: ya nos pasó. Un `as String` sobre un campo nulo tumbó la
// pantalla de productos entera el día que un producto tuvo foto, porque el
// listado devolvía sólo la URL y el modelo esperaba también el id. La pantalla
// no mostró un error: se murió.
//
// Acá el costo de un campo faltante es un texto vacío o un `null`. La pantalla
// sigue en pie y quien la mira puede seguir comprando.

class ResumenDeLive {
  const ResumenDeLive({
    required this.id,
    required this.titulo,
    required this.estado,
    required this.vendedorId,
    required this.vendedorNombre,
    required this.storeId,
    required this.tiendaNombre,
    this.portada,
    this.identidadVerificada = false,
  });

  factory ResumenDeLive.fromJson(Map<String, dynamic> j) {
    final vendedor = j['vendedor'] as Map<String, dynamic>? ?? const {};
    final tienda = j['tienda'] as Map<String, dynamic>? ?? const {};

    return ResumenDeLive(
      id: j['id'] as String? ?? '',
      titulo: j['titulo'] as String? ?? '',
      estado: j['estado'] as String? ?? 'ENDED',
      portada: j['portada'] as String?,
      vendedorId: vendedor['id'] as String? ?? '',
      vendedorNombre: vendedor['nombre'] as String? ?? '',
      identidadVerificada: vendedor['identidadVerificada'] as bool? ?? false,
      storeId: tienda['id'] as String? ?? '',
      tiendaNombre: tienda['nombre'] as String? ?? '',
    );
  }

  final String id;
  final String titulo;
  final String estado;
  final String? portada;
  final String vendedorId;
  final String vendedorNombre;
  final bool identidadVerificada;
  final String storeId;
  final String tiendaNombre;
}

/// El producto que el vendedor está mostrando ahora.
class ProductoDestacado {
  const ProductoDestacado({
    required this.variantId,
    required this.productId,
    required this.nombre,
    this.variante,
    this.imagenUrl,
    this.precioCentavos,
    this.disponible,
  });

  factory ProductoDestacado.fromJson(Map<String, dynamic> j) => ProductoDestacado(
        variantId: j['variantId'] as String? ?? '',
        productId: j['productId'] as String? ?? '',
        nombre: j['nombre'] as String? ?? '',
        variante: j['variante'] as String?,
        imagenUrl: j['imagenUrl'] as String?,
        precioCentavos: (j['precioCentavos'] as num?)?.toInt(),
        disponible: (j['disponible'] as num?)?.toInt(),
      );

  final String variantId;
  final String productId;
  final String nombre;
  final String? variante;
  final String? imagenUrl;
  final int? precioCentavos;

  /// Cuánto queda.
  ///
  /// ⚠️ Es **de presentación**. Sirve para el "últimas 3" y para deshabilitar
  /// el botón; no autoriza ninguna compra. Quien decide si hay stock es el
  /// UPDATE condicional del backend cuando se reserva.
  final int? disponible;

  bool get agotado => disponible != null && disponible! <= 0;

  /// Copia con el stock actualizado, para aplicar un evento sin repedir todo.
  ProductoDestacado conDisponible(int nuevo) => ProductoDestacado(
        variantId: variantId,
        productId: productId,
        nombre: nombre,
        variante: variante,
        imagenUrl: imagenUrl,
        precioCentavos: precioCentavos,
        disponible: nuevo,
      );
}

class DatosDeVideo {
  const DatosDeVideo({required this.token, required this.wsUrl, required this.sala});

  factory DatosDeVideo.fromJson(Map<String, dynamic> j) => DatosDeVideo(
        token: j['token'] as String? ?? '',
        wsUrl: j['wsUrl'] as String? ?? '',
        sala: j['sala'] as String? ?? '',
      );

  final String token;
  final String wsUrl;
  final String sala;
}

class DetalleDeLive {
  const DetalleDeLive({
    required this.id,
    required this.titulo,
    required this.estado,
    required this.vendedorId,
    required this.vendedorNombre,
    required this.storeId,
    required this.tiendaNombre,
    this.portada,
    this.identidadVerificada = false,
    this.destacado,
    this.video,
    this.terminadoEl,
  });

  factory DetalleDeLive.fromJson(Map<String, dynamic> j) {
    final vendedor = j['vendedor'] as Map<String, dynamic>? ?? const {};
    final tienda = j['tienda'] as Map<String, dynamic>? ?? const {};
    final destacado = j['destacado'] as Map<String, dynamic>?;
    final video = j['video'] as Map<String, dynamic>?;

    return DetalleDeLive(
      id: j['id'] as String? ?? '',
      titulo: j['titulo'] as String? ?? '',
      estado: j['estado'] as String? ?? 'ENDED',
      portada: j['portada'] as String?,
      vendedorId: vendedor['id'] as String? ?? '',
      vendedorNombre: vendedor['nombre'] as String? ?? '',
      identidadVerificada: vendedor['identidadVerificada'] as bool? ?? false,
      storeId: tienda['id'] as String? ?? '',
      tiendaNombre: tienda['nombre'] as String? ?? '',
      destacado: destacado == null ? null : ProductoDestacado.fromJson(destacado),
      video: video == null ? null : DatosDeVideo.fromJson(video),
      terminadoEl: DateTime.tryParse(j['terminadoEl'] as String? ?? ''),
    );
  }

  final String id;
  final String titulo;
  final String estado;
  final String? portada;
  final String vendedorId;
  final String vendedorNombre;
  final bool identidadVerificada;
  final String storeId;
  final String tiendaNombre;
  final ProductoDestacado? destacado;

  /// `null` cuando el vivo terminó. **El resto del contexto sigue estando**:
  /// vendedor, tienda y producto. Eso es lo que permite seguir comprando
  /// después de que se cortó el video.
  final DatosDeVideo? video;
  final DateTime? terminadoEl;

  bool get terminado => estado == 'ENDED' || estado == 'FAILED';
  bool get reconectando => estado == 'RECONNECTING';
  bool get alAire => estado == 'LIVE' || estado == 'RECONNECTING';
}

class EstadoDeTienda {
  const EstadoDeTienda({required this.abierta, required this.motivo, this.abreEl});

  factory EstadoDeTienda.fromJson(Map<String, dynamic> j) => EstadoDeTienda(
        abierta: j['abierta'] as bool? ?? true,
        motivo: j['motivo'] as String? ?? '',
        abreEl: DateTime.tryParse(j['abreEl'] as String? ?? ''),
      );

  final bool abierta;
  final String motivo;
  final DateTime? abreEl;
}

class PerfilDeVendedor {
  const PerfilDeVendedor({
    required this.id,
    required this.nombre,
    required this.seguidores,
    required this.resenas,
    required this.ventas,
    this.bio,
    this.avatarUrl,
    this.rating,
    this.identidadVerificada = false,
    this.vendedorConfiable = false,
    this.loSigo,
    this.storeId,
    this.tiendaNombre,
    this.horario,
    this.liveEnCursoId,
  });

  factory PerfilDeVendedor.fromJson(Map<String, dynamic> j) {
    final tienda = j['tienda'] as Map<String, dynamic>?;
    final horario = j['horario'] as Map<String, dynamic>?;
    final enVivo = j['enVivo'] as Map<String, dynamic>?;

    return PerfilDeVendedor(
      id: j['id'] as String? ?? '',
      nombre: j['nombre'] as String? ?? '',
      bio: j['bio'] as String?,
      avatarUrl: j['avatarUrl'] as String?,
      identidadVerificada: j['identidadVerificada'] as bool? ?? false,
      vendedorConfiable: j['vendedorConfiable'] as bool? ?? false,
      seguidores: (j['seguidores'] as num?)?.toInt() ?? 0,
      /// `null` cuando no hay reseñas. Distinto de 0: "sin reseñas" no es
      /// "promedio cero", y mostrar 0,0 ⭐ haría parecer pésimo a un vendedor
      /// que simplemente es nuevo.
      rating: (j['rating'] as num?)?.toDouble(),
      resenas: (j['resenas'] as num?)?.toInt() ?? 0,
      ventas: (j['ventas'] as num?)?.toInt() ?? 0,
      loSigo: j['loSigo'] as bool?,
      storeId: tienda?['id'] as String?,
      tiendaNombre: tienda?['nombre'] as String?,
      horario: horario == null ? null : EstadoDeTienda.fromJson(horario),
      liveEnCursoId: enVivo?['id'] as String?,
    );
  }

  final String id;
  final String nombre;
  final String? bio;
  final String? avatarUrl;

  /// Un hecho comprobable: sabemos quién es.
  final bool identidadVerificada;

  /// Una reputación: tiene historial. **No es lo mismo que la anterior.**
  final bool vendedorConfiable;

  final int seguidores;
  final double? rating;
  final int resenas;
  final int ventas;

  /// `null` si no hay sesión: la app no muestra el botón de seguir.
  final bool? loSigo;

  final String? storeId;
  final String? tiendaNombre;
  final EstadoDeTienda? horario;
  final String? liveEnCursoId;

  bool get sinReputacion => resenas == 0 && ventas == 0;

  /// Copia con el estado de seguimiento que **devolvió el servidor**.
  ///
  /// Los dos valores vienen juntos de la misma respuesta. Separarlos —marcar
  /// "siguiendo" acá y sumar uno al contador allá— es cómo se llega a un perfil
  /// que dice "Siguiendo" con 0 seguidores.
  PerfilDeVendedor conFollow(bool siguiendo, int seguidores) => PerfilDeVendedor(
        id: id,
        nombre: nombre,
        bio: bio,
        avatarUrl: avatarUrl,
        identidadVerificada: identidadVerificada,
        vendedorConfiable: vendedorConfiable,
        seguidores: seguidores,
        rating: rating,
        resenas: resenas,
        ventas: ventas,
        loSigo: siguiendo,
        storeId: storeId,
        tiendaNombre: tiendaNombre,
        horario: horario,
        liveEnCursoId: liveEnCursoId,
      );
}

class ItemDeCatalogo {
  const ItemDeCatalogo({
    required this.id,
    required this.nombre,
    required this.precioCentavos,
    required this.disponible,
    required this.variantes,
    this.imagenUrl,
  });

  factory ItemDeCatalogo.fromJson(Map<String, dynamic> j) => ItemDeCatalogo(
        id: j['id'] as String? ?? '',
        nombre: j['nombre'] as String? ?? '',
        imagenUrl: j['imagenUrl'] as String?,
        precioCentavos: (j['precioCentavos'] as num?)?.toInt() ?? 0,
        disponible: (j['disponible'] as num?)?.toInt() ?? 0,
        variantes: (j['variantes'] as num?)?.toInt() ?? 1,
      );

  final String id;
  final String nombre;
  final String? imagenUrl;
  final int precioCentavos;
  final int disponible;
  final int variantes;

  bool get agotado => disponible <= 0;
}

class PaginaDeCatalogo {
  const PaginaDeCatalogo({required this.items, this.siguienteCursor});

  factory PaginaDeCatalogo.fromJson(Map<String, dynamic> j) => PaginaDeCatalogo(
        items: (j['items'] as List<dynamic>? ?? const [])
            .map((e) => ItemDeCatalogo.fromJson(e as Map<String, dynamic>))
            .toList(),
        siguienteCursor: j['siguienteCursor'] as String?,
      );

  final List<ItemDeCatalogo> items;
  final String? siguienteCursor;
}

// ─── Producto con variantes, para el selector de compra ──────────────────────

/// Un eje de variación: "Talle", "Color".
class EjeDeVariacion {
  const EjeDeVariacion({required this.nombre, required this.valores});

  final String nombre;
  /// Los valores posibles, con su id: `{ id: 'opv_1', valor: 'M' }`.
  final List<({String id, String valor})> valores;
}

class VarianteDeProducto {
  const VarianteDeProducto({
    required this.id,
    required this.titulo,
    required this.precioCentavos,
    required this.disponible,
    required this.valoresDeOpcion,
    this.sku,
  });

  final String id;
  final String titulo;
  final int precioCentavos;
  final int disponible;

  /// Los ids de los valores que la definen. Es lo que permite resolver
  /// "Negro + M" a una variante concreta sin que la app conozca la combinatoria.
  final List<String> valoresDeOpcion;
  final String? sku;

  bool get agotada => disponible <= 0;
}

class DetalleDeProducto {
  const DetalleDeProducto({
    required this.id,
    required this.nombre,
    required this.precioBaseCentavos,
    required this.ejes,
    required this.variantes,
    this.imagenUrl,
    this.descripcion,
  });

  /// Lee la respuesta de `GET /products/:id`.
  ///
  /// ─── Por qué se aplanan las opciones acá ───
  ///
  /// El backend devuelve el árbol completo —opciones, valores, variantes y qué
  /// valor tiene cada variante— porque es lo que necesita el editor del
  /// vendedor. El comprador sólo necesita "estos son los talles, éste es el que
  /// hay". Aplanarlo en el modelo evita que cada pantalla vuelva a recorrer el
  /// árbol y llegue a conclusiones distintas.
  factory DetalleDeProducto.fromJson(Map<String, dynamic> j) {
    final opciones = j['options'] as List<dynamic>? ?? const [];
    final variantesJson = j['variants'] as List<dynamic>? ?? const [];
    final imagenes = j['images'] as List<dynamic>? ?? const [];

    final ejes = opciones.map((o) {
      final op = o as Map<String, dynamic>;
      final valores = (op['values'] as List<dynamic>? ?? const [])
          .map((v) {
            final vv = v as Map<String, dynamic>;
            return (id: vv['id'] as String? ?? '', valor: vv['value'] as String? ?? '');
          })
          .toList();
      return EjeDeVariacion(nombre: op['name'] as String? ?? '', valores: valores);
    }).toList();

    final variantes = variantesJson.map((v) {
      final vv = v as Map<String, dynamic>;
      final inv = vv['inventory'] as Map<String, dynamic>?;
      final onHand = (inv?['onHand'] as num?)?.toInt() ?? 0;
      final reserved = (inv?['reserved'] as num?)?.toInt() ?? 0;

      return VarianteDeProducto(
        id: vv['id'] as String? ?? '',
        titulo: vv['title'] as String? ?? '',
        sku: vv['sku'] as String?,
        precioCentavos: (vv['priceOverrideCents'] as num?)?.toInt() ??
            (j['basePriceCents'] as num?)?.toInt() ??
            0,
        // El disponible se calcula acá y no se pide al backend como campo:
        // siempre es derivado, y una tercera fuente se puede desincronizar.
        disponible: onHand - reserved,
        valoresDeOpcion: (vv['options'] as List<dynamic>? ?? const [])
            .map((x) => (x as Map<String, dynamic>)['optionValueId'] as String? ?? '')
            .where((s) => s.isNotEmpty)
            .toList(),
      );
    }).toList();

    return DetalleDeProducto(
      id: j['id'] as String? ?? '',
      nombre: j['name'] as String? ?? '',
      descripcion: j['description'] as String?,
      precioBaseCentavos: (j['basePriceCents'] as num?)?.toInt() ?? 0,
      imagenUrl: imagenes.isEmpty
          ? null
          : (imagenes.first as Map<String, dynamic>)['url'] as String?,
      ejes: ejes,
      variantes: variantes,
    );
  }

  final String id;
  final String nombre;
  final String? descripcion;
  final int precioBaseCentavos;
  final String? imagenUrl;
  final List<EjeDeVariacion> ejes;
  final List<VarianteDeProducto> variantes;

  /// La variante que corresponde a una combinación de valores elegidos.
  ///
  /// Devuelve `null` si la combinación no existe — que no es lo mismo que
  /// agotada: hay productos que simplemente no vienen en negro talle XS.
  VarianteDeProducto? variantePara(Set<String> valoresElegidos) {
    if (ejes.isEmpty) return variantes.isEmpty ? null : variantes.first;
    if (valoresElegidos.length != ejes.length) return null;

    for (final v in variantes) {
      if (v.valoresDeOpcion.length == valoresElegidos.length &&
          v.valoresDeOpcion.every(valoresElegidos.contains)) {
        return v;
      }
    }
    return null;
  }

  /// ¿Hay alguna variante con stock que incluya este valor?
  ///
  /// Es lo que permite deshabilitar "XS" cuando ya se eligió "Negro" y no queda
  /// ninguno negro en XS — sin que la app tenga que conocer la combinatoria.
  bool valorTieneStock(String valorId, Set<String> yaElegidos) {
    final combinacion = {...yaElegidos, valorId};
    return variantes.any(
      (v) => combinacion.every(v.valoresDeOpcion.contains) && !v.agotada,
    );
  }
}
