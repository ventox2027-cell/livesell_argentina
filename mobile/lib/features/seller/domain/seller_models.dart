/// Modelos del bloque comercial.
///
/// El dinero llega y viaja SIEMPRE en centavos enteros, igual que en el
/// backend. La conversión a pesos ocurre sólo al mostrar — nunca al calcular.
library;

import 'politicas_models.dart';

int _int(Object? v, [int fallback = 0]) =>
    v is int ? v : v is num ? v.toInt() : fallback;

class Seller {
  const Seller({
    required this.id,
    required this.displayName,
    required this.slug,
    required this.status,
    required this.verificationStatus,
    this.bio,
    this.avatarUrl,
    this.coverUrl,
  });

  factory Seller.fromJson(Map<String, dynamic> j) => Seller(
        id: j['id'] as String,
        displayName: j['displayName'] as String? ?? '',
        slug: j['slug'] as String? ?? '',
        status: j['status'] as String? ?? 'ACTIVE',
        verificationStatus: j['verificationStatus'] as String? ?? 'UNVERIFIED',
        bio: j['bio'] as String?,
        avatarUrl: j['avatarUrl'] as String?,
        coverUrl: j['coverUrl'] as String?,
      );

  final String id;
  final String displayName;
  final String slug;
  final String status;
  final String verificationStatus;
  final String? bio;
  final String? avatarUrl;
  final String? coverUrl;

  bool get activo => status == 'ACTIVE';
  bool get verificado => verificationStatus == 'VERIFIED';

  /// Mensaje para el vendedor cuando no puede operar. `null` si está todo bien.
  String? get avisoDeEstado => switch (status) {
        'SUSPENDED' => 'Tu cuenta está suspendida. Escribinos para resolverlo.',
        'BLOCKED' => 'Tu cuenta fue bloqueada.',
        'CLOSED' => 'Cerraste tu cuenta de vendedor.',
        'PENDING' => 'Estamos revisando tu cuenta.',
        _ => null,
      };
}

class Store {
  const Store({
    required this.id,
    required this.name,
    required this.slug,
    required this.status,
    this.description,
    this.logoUrl,
    this.coverUrl,
    this.envio = const PoliticaDeEnvioEditable(
      modo: ModoDeEnvio.free,
      montoFijo: 0,
      trasladaCostoDelProcesador: false,
    ),
    this.cambios = const PoliticaDeCambiosEditable(
      modo: ModoDeCambios.soloLegal,
      dias: PoliticaDeCambiosEditable.diasMinimosLegales,
      envioDeVueltaLoPagaElVendedor: true,
    ),
  });

  factory Store.fromJson(Map<String, dynamic> j) => Store(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        slug: j['slug'] as String? ?? '',
        status: j['status'] as String? ?? 'ACTIVE',
        description: j['description'] as String?,
        logoUrl: j['logoUrl'] as String?,
        coverUrl: j['coverUrl'] as String?,
        // Las políticas viajan dentro del mismo objeto `store`: el backend las
        // guarda ahí, y separarlas obligaría a una segunda petición para pintar
        // una pantalla que ya tiene todo lo que necesita.
        envio: PoliticaDeEnvioEditable.fromJson(j),
        cambios: PoliticaDeCambiosEditable.fromJson(j),
      );

  final String id;
  final String name;
  final String slug;
  final String status;
  final String? description;
  final String? logoUrl;
  final String? coverUrl;

  /// Cómo cobra el envío y quién paga el costo del cobro.
  final PoliticaDeEnvioEditable envio;

  /// Cambios y devoluciones. El piso legal se aplica igual.
  final PoliticaDeCambiosEditable cambios;

  bool get pausada => status == 'PAUSED';
}

class PerfilVendedor {
  const PerfilVendedor({required this.seller, this.store, this.productos = 0});

  factory PerfilVendedor.fromJson(Map<String, dynamic> j) => PerfilVendedor(
        seller: Seller.fromJson(j['seller'] as Map<String, dynamic>),
        store: j['store'] == null ? null : Store.fromJson(j['store'] as Map<String, dynamic>),
        productos: _int((j['stats'] as Map<String, dynamic>?)?['productos']),
      );

  final Seller seller;
  final Store? store;
  final int productos;
}

/// Eje de variación: "Color", "Talle".
class OpcionProducto {
  const OpcionProducto({required this.id, required this.name, required this.values});

  factory OpcionProducto.fromJson(Map<String, dynamic> j) => OpcionProducto(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        values: (j['values'] as List<dynamic>? ?? [])
            .map((v) => ValorOpcion.fromJson(v as Map<String, dynamic>))
            .toList(),
      );

  final String id;
  final String name;
  final List<ValorOpcion> values;
}

class ValorOpcion {
  const ValorOpcion({required this.id, required this.value});

  factory ValorOpcion.fromJson(Map<String, dynamic> j) =>
      ValorOpcion(id: j['id'] as String, value: j['value'] as String? ?? '');

  final String id;
  final String value;
}

class Variante {
  const Variante({
    required this.id,
    required this.title,
    required this.priceCents,
    required this.status,
    required this.isDefault,
    this.sku,
    this.priceOverrideCents,
    this.optionValueIds = const [],
  });

  factory Variante.fromJson(Map<String, dynamic> j) => Variante(
        id: j['id'] as String,
        title: j['title'] as String? ?? '',
        // El precio efectivo lo resuelve el backend. La app NO reimplementa la
        // regla: si lo hiciera, un día mostraría un número y se cobraría otro.
        priceCents: _int(j['priceCents']),
        status: j['status'] as String? ?? 'ACTIVE',
        isDefault: j['isDefault'] as bool? ?? false,
        sku: j['sku'] as String?,
        priceOverrideCents: j['priceOverrideCents'] == null
            ? null
            : _int(j['priceOverrideCents']),
        optionValueIds:
            (j['optionValueIds'] as List<dynamic>? ?? []).map((e) => e as String).toList(),
      );

  final String id;
  final String title;
  final int priceCents;
  final String status;
  final bool isDefault;
  final String? sku;
  final int? priceOverrideCents;
  final List<String> optionValueIds;

  bool get activa => status == 'ACTIVE';
}

class ImagenProducto {
  const ImagenProducto({required this.id, required this.url, required this.position});

  /// ─── Por qué nada de acá es un cast estricto ───
  ///
  /// Esto crasheaba la lista de productos del vendedor con
  /// `type 'Null' is not a subtype of type 'String'`: los endpoints de listado
  /// mandaban sólo `url` —alcanza para la portada— y el `j['id'] as String`
  /// reventaba. Y no reventaba una imagen: reventaba la pantalla entera, y
  /// sólo cuando un producto tenía foto, que es la razón por la que tardó en
  /// aparecer.
  ///
  /// El contrato del backend se unificó para que siempre manden los tres
  /// campos. Esto queda tolerante igual: **un campo que falta tiene que
  /// degradar lo que muestra, nunca tumbar la pantalla**. La app está en
  /// teléfonos que no se pueden actualizar al mismo tiempo que el servidor.
  factory ImagenProducto.fromJson(Map<String, dynamic> j) => ImagenProducto(
        id: j['id'] as String? ?? '',
        url: j['url'] as String? ?? '',
        position: _int(j['position']),
      );

  final String id;
  final String url;
  final int position;

  /// Sin id no se puede borrar ni reordenar: vino de una proyección parcial.
  bool get esManipulable => id.isNotEmpty;
}

class Producto {
  const Producto({
    required this.id,
    required this.name,
    required this.slug,
    required this.status,
    required this.basePriceCents,
    this.description,
    this.compareAtPriceCents,
    this.options = const [],
    this.variants = const [],
    this.images = const [],
    this.portada,
    this.cantidadVariantes = 0,
  });

  factory Producto.fromJson(Map<String, dynamic> j) {
    final imagenes = (j['images'] as List<dynamic>? ?? [])
        .map((e) => ImagenProducto.fromJson(e as Map<String, dynamic>))
        .toList();

    return Producto(
      id: j['id'] as String,
      name: j['name'] as String? ?? '',
      slug: j['slug'] as String? ?? '',
      status: j['status'] as String? ?? 'DRAFT',
      basePriceCents: _int(j['basePriceCents']),
      description: j['description'] as String?,
      compareAtPriceCents:
          j['compareAtPriceCents'] == null ? null : _int(j['compareAtPriceCents']),
      options: (j['options'] as List<dynamic>? ?? [])
          .map((e) => OpcionProducto.fromJson(e as Map<String, dynamic>))
          .toList(),
      variants: (j['variants'] as List<dynamic>? ?? [])
          .map((e) => Variante.fromJson(e as Map<String, dynamic>))
          .toList(),
      images: imagenes,
      portada: imagenes.isNotEmpty ? imagenes.first.url : null,
      cantidadVariantes: _int((j['_count'] as Map<String, dynamic>?)?['variants']),
    );
  }

  final String id;
  final String name;
  final String slug;
  final String status;
  final int basePriceCents;
  final String? description;
  final int? compareAtPriceCents;
  final List<OpcionProducto> options;
  final List<Variante> variants;
  final List<ImagenProducto> images;
  final String? portada;
  final int cantidadVariantes;

  bool get publicado => status == 'ACTIVE';
  bool get esBorrador => status == 'DRAFT';
  bool get tieneVariantes => options.isNotEmpty;

  String get etiquetaEstado => switch (status) {
        'DRAFT' => 'Borrador',
        'ACTIVE' => 'Publicado',
        'PAUSED' => 'Pausado',
        'ARCHIVED' => 'Archivado',
        _ => status,
      };
}

/// Página de resultados con cursor.
class Pagina<T> {
  const Pagina({required this.items, this.nextCursor});

  final List<T> items;
  final String? nextCursor;

  bool get hayMas => nextCursor != null;
}

/// Formato argentino: punto para miles, coma para decimales.
///
/// `1250050` → `"$ 12.500,50"`. Un precio escrito como si fuera de otro país
/// genera desconfianza justo en el momento de comprar.
String formatearPesos(int centavos) {
  final entero = centavos ~/ 100;
  final decimales = (centavos % 100).toString().padLeft(2, '0');

  final s = entero.abs().toString();
  final buffer = StringBuffer();
  for (var i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 == 0) buffer.write('.');
    buffer.write(s[i]);
  }

  return '${centavos < 0 ? '-' : ''}\$ $buffer,$decimales';
}

/// Convierte lo que la persona escribe en centavos.
///
/// Acepta `12500`, `12.500`, `12500,50` y `$ 12.500,50`. Devuelve `null` si no
/// se puede interpretar con confianza — es preferible pedir que corrija a
/// guardar un precio equivocado.
int? parsearPesos(String texto) {
  var t = texto.trim().replaceAll(RegExp(r'[^\d.,]'), '');
  if (t.isEmpty) return null;

  // Se asume formato argentino: el punto separa miles, la coma decimales.
  t = t.replaceAll('.', '');
  final partes = t.split(',');
  if (partes.length > 2) return null;

  final enteros = int.tryParse(partes[0].isEmpty ? '0' : partes[0]);
  if (enteros == null) return null;

  var centavos = 0;
  if (partes.length == 2) {
    final dec = partes[1].padRight(2, '0').substring(0, 2);
    final parsed = int.tryParse(dec);
    if (parsed == null) return null;
    centavos = parsed;
  }

  return enteros * 100 + centavos;
}
