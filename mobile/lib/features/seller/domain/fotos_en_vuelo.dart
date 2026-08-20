import 'seller_models.dart';

/// Una foto que todavía no terminó de subir.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SEIS SEGUNDOS ENTRE ELEGIR LA FOTO Y VERLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono. El camino era éste, todo en fila y todo esperado
/// antes de dibujar nada:
///
///   1. El selector achica la foto a 1600 px  — dentro de `pickImage`.
///   2. `POST /products/:id/images` sube el archivo a Railway, que lo manda
///      a R2.
///   3. `GET /products/:id` vuelve a pedir el producto ENTERO para enterarse
///      de la foto que la respuesta anterior **ya había devuelto**.
///   4. Recién ahí `setState` y aparece la miniatura.
///
/// El paso 3 es un viaje a otro continente para traer un dato que estaba en la
/// mano. Los pasos 1 y 2 hay que hacerlos igual, pero no hay ninguna razón para
/// mirarlos: el archivo está en el teléfono desde el paso 1.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE TOCA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El redimensionado a 1600 px con calidad 85. Una foto de 12 MP son varios
/// megas y en una red móvil argentina eso es un minuto de subida; a 1600 se ve
/// igual en una pantalla de 6". Bajarlo más sería vender productos con fotos
/// peores para ganar un segundo.
class FotoEnVuelo {
  const FotoEnVuelo({
    required this.clave,
    required this.productId,
    required this.rutaLocal,
    this.error,
  });

  /// Identifica ESTE intento. No es el id de la imagen: todavía no existe.
  final String clave;

  final String productId;

  /// El archivo en el teléfono. Es lo que se muestra mientras sube.
  final String rutaLocal;

  /// Con qué falló, si falló. `null` mientras está en curso.
  final Object? error;

  bool get fallo => error != null;

  FotoEnVuelo conError(Object e) =>
      FotoEnVuelo(clave: clave, productId: productId, rutaLocal: rutaLocal, error: e);
}

/// Lo que hay que dibujar en la tira de fotos.
///
/// Tres orígenes que la pantalla no tiene por qué distinguir:
///
///   · las que ya están en el producto que trajo el servidor,
///   · las que terminaron de subir después de eso —el servidor todavía no lo
///     sabe porque nadie volvió a preguntarle—,
///   · y las que están subiendo o fallaron, que sólo existen como archivo.
class TiraDeFotos {
  const TiraDeFotos({required this.subidas, required this.enVuelo});

  final List<ImagenProducto> subidas;
  final List<FotoEnVuelo> enVuelo;

  int get largo => subidas.length + enVuelo.length;
}

/// Junta las tres fuentes en una sola tira, sin repetir y sin las borradas.
///
/// ⚠️ La deduplicación por id es lo que evita que una foto aparezca dos veces
/// cuando el editor vuelve a pedir el producto: ahí la imagen llega por el
/// servidor Y sigue en la lista de recién subidas.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ HACE FALTA `borradas`
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: tocar la X tardaba ~5 segundos y la foto **no
/// desaparecía**. Tocarla de nuevo respondía «imagen no encontrada». Saliendo
/// del producto y volviendo a entrar, ya no estaba.
///
/// O sea: el backend y R2 borraban bien. Lo que quedaba viejo era la pantalla.
/// El editor guarda el producto en `_producto` y esa copia sigue teniendo la
/// imagen hasta que alguien vuelva a pedirla — y el segundo toque mandaba un
/// `DELETE` de algo que ya no existía.
///
/// Con esto, la foto se va de la tira apenas se confirma el borrado y no vuelve
/// aunque `_producto` siga teniéndola.
TiraDeFotos armarTira({
  required List<ImagenProducto> delServidor,
  required List<ImagenProducto> recienSubidas,
  required List<FotoEnVuelo> enVuelo,
  Set<String> borradas = const {},
}) {
  final vistas = <String>{};
  final subidas = <ImagenProducto>[];

  for (final img in [...delServidor, ...recienSubidas]) {
    if (borradas.contains(img.id)) continue;
    if (img.id.isEmpty || vistas.add(img.id)) subidas.add(img);
  }

  return TiraDeFotos(subidas: subidas, enVuelo: enVuelo);
}
