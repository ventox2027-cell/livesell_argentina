import 'package:flutter/material.dart';

import '../../inventory/domain/inventory_models.dart';
import '../../seller/domain/seller_models.dart';

/// Una publicación del feed.
///
/// Es una vista aplanada de producto + tienda + vendedor. El feed no necesita
/// el árbol completo —opciones, variantes, todas las fotos— y traerlo entero
/// haría el scroll más pesado sin mostrar nada más.
class PublicacionFeed {
  const PublicacionFeed({
    required this.id,
    required this.nombre,
    required this.precioCentavos,
    required this.vendedor,
    required this.tiendaSlug,
    required this.tiendaNombre,
    this.vendedorId = '',
    this.storeId = '',
    this.descripcion,
    this.precioTachadoCentavos,
    this.portada,
    this.avatarUrl,
    this.verificado = false,
    this.variantes = 1,
    this.variantePorDefectoId,
    this.disponibilidad,
    this.promocionado = false,
  });

  factory PublicacionFeed.fromJson(Map<String, dynamic> j) {
    final store = j['store'] as Map<String, dynamic>?;
    final seller = store?['seller'] as Map<String, dynamic>?;
    final imagenes = j['images'] as List<dynamic>? ?? const [];

    final variantes = j['variants'] as List<dynamic>? ?? const [];

    return PublicacionFeed(
      id: j['id'] as String,
      nombre: j['name'] as String? ?? '',
      precioCentavos: (j['basePriceCents'] as num?)?.toInt() ?? 0,
      // Variante por defecto para comprar de un toque. Si el producto tiene
      // opciones, el feed manda la primera y la elección fina queda para el
      // detalle: en un vivo, frenar a alguien con un selector antes de que
      // haya decidido comprar es perderlo.
      variantePorDefectoId:
          variantes.isEmpty ? null : (variantes.first as Map<String, dynamic>)['id'] as String?,
      // Si el backend dejara de mandar la tienda, el feed no puede mostrar una
      // publicación sin dueño: mejor un texto neutro que un hueco.
      vendedor: seller?['displayName'] as String? ?? store?['name'] as String? ?? 'Vendedor',
      // Los ids ya venían en la respuesta y el modelo los tiraba. Sin ellos el
      // feed sólo podía mostrar el NOMBRE del vendedor: no se podía abrir su
      // perfil ni seguirlo de verdad, y por eso el botón "Seguir" del feed era
      // un booleano local que se olvidaba al cerrar la app.
      vendedorId: seller?['id'] as String? ?? '',
      storeId: store?['id'] as String? ?? '',
      tiendaSlug: store?['slug'] as String? ?? '',
      tiendaNombre: store?['name'] as String? ?? '',
      descripcion: j['description'] as String?,
      precioTachadoCentavos: (j['compareAtPriceCents'] as num?)?.toInt(),
      portada: imagenes.isEmpty ? null : (imagenes.first as Map<String, dynamic>)['url'] as String?,
      avatarUrl: seller?['avatarUrl'] as String?,
      verificado: seller?['verificationStatus'] == 'VERIFIED',
      variantes: ((j['_count'] as Map<String, dynamic>?)?['variants'] as num?)?.toInt() ?? 1,
      // La disponibilidad viene resuelta por el backend, como etiqueta.
      // La app NO la calcula: si lo hiciera, mostraría "disponible" sobre
      // datos de hace treinta segundos justo cuando queda una unidad.
      disponibilidad: variantes.isEmpty
          ? null
          : Disponibilidad.fromJson(variantes.first as Map<String, dynamic>),
      /**
       * ⚠️ `is bool` y no `as bool?`.
       *
       * El cast TIRA si llega un texto o un número, y acá eso reventaría la
       * tarjeta entera por un campo decorativo. Ya nos pasó con `as String`
       * sobre la foto de un producto: la lista completa dejaba de cargar.
       *
       * Cualquier cosa que no sea un booleano se lee como `false`, que además
       * es la respuesta correcta: marcar como publicidad algo orgánico es tan
       * mentira como lo contrario.
       */
      promocionado: j['promocionado'] is bool ? j['promocionado'] as bool : false,
    );
  }

  final String id;
  final String nombre;
  final int precioCentavos;
  final String vendedor;

  /// Para abrir su perfil y seguirlo. Vacío si el backend no lo mandó, y ahí
  /// la fila del vendedor no es tocable: mejor que abrir un perfil en blanco.
  final String vendedorId;

  /// Para abrir el catálogo de la tienda.
  final String storeId;

  final String tiendaSlug;
  final String tiendaNombre;
  final String? descripcion;
  final int? precioTachadoCentavos;
  final String? portada;
  final String? avatarUrl;
  final bool verificado;
  final int variantes;

  /// Qué variante se aparta al tocar "Comprar" desde el feed.
  ///
  /// `null` si el backend no mandó variantes, y entonces no se puede reservar
  /// desde acá: hay que entrar al producto.
  final String? variantePorDefectoId;

  /// Disponibilidad de esa variante, resuelta por el backend.
  final Disponibilidad? disponibilidad;

  /// Si esta publicación ocupa una posición paga del feed.
  ///
  /// ⚠️ **Se muestra siempre que sea `true`.** No es una decisión de diseño que
  /// se pueda ajustar después: la ley de defensa del consumidor exige que la
  /// publicidad se distinga de un resultado, y sin la etiqueta no hay forma.
  ///
  /// Lo decide el servidor. Y pagar no mejora el puntaje: compra un lugar
  /// reservado y nada más. Ver `commerce/promociones.ts`.
  final bool promocionado;

  bool get sePuedeComprar => variantePorDefectoId != null && (disponibilidad?.hay ?? false);

  String get precio => formatearPesos(precioCentavos);
  String? get precioTachado =>
      precioTachadoCentavos == null ? null : formatearPesos(precioTachadoCentavos!);

  /// Porcentaje de descuento, si hay precio tachado y el ahorro se nota.
  ///
  /// Por debajo de 5 % no se muestra: un "-2 % OFF" resta credibilidad en vez
  /// de sumarla.
  int? get descuento {
    final tachado = precioTachadoCentavos;
    if (tachado == null || tachado <= precioCentavos) return null;
    final pct = ((tachado - precioCentavos) * 100 / tachado).round();
    return pct >= 5 ? pct : null;
  }

  /// Fondo mientras no hay video ni foto.
  ///
  /// Se deriva del id, así que el mismo producto tiene siempre el mismo color:
  /// un color al azar en cada rebuild haría parpadear el feed al desplazarse.
  List<Color> get coloresDeFondo {
    const paletas = [
      [Color(0xFF3A1C2E), Color(0xFF0D0508)],
      [Color(0xFF2B2013), Color(0xFF0A0705)],
      [Color(0xFF13291C), Color(0xFF040A07)],
      [Color(0xFF1B2440), Color(0xFF05070D)],
      [Color(0xFF2E1A3A), Color(0xFF08040A)],
    ];
    var suma = 0;
    for (final unidad in id.codeUnits) {
      suma += unidad;
    }
    return paletas[suma % paletas.length];
  }
}
