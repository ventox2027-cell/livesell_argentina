import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/fotos_en_vuelo.dart';
import '../domain/seller_models.dart';
import 'seller_repository.dart';

/// El estado de las subidas de fotos, por producto.
class EstadoDeSubidas {
  const EstadoDeSubidas({this.enVuelo = const [], this.recienSubidas = const {}});

  final List<FotoEnVuelo> enVuelo;

  /// Lo que ya subió y el producto en memoria todavía no tiene, por producto.
  final Map<String, List<ImagenProducto>> recienSubidas;

  List<FotoEnVuelo> deProducto(String productId) =>
      enVuelo.where((f) => f.productId == productId).toList();

  List<ImagenProducto> subidasDe(String productId) => recienSubidas[productId] ?? const [];
}

/// Sube las fotos por atrás, sin hacer esperar a nadie.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO NO VIVE EN EL EDITOR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Porque una de las cosas que se pidieron es no perder la foto si la persona
/// sale del editor mientras sube. Un `Future` lanzado desde el `State` de la
/// pantalla muere con la pantalla: la subida sigue viajando pero no queda nadie
/// para guardar el resultado ni para avisar si falló.
///
/// Acá vive en el contenedor de Riverpod, igual que los ajustes de stock y los
/// borrados. Salir y volver al editor encuentra la foto donde estaba.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL VIAJE QUE SE SACÓ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El editor hacía `subirImagen(...)` y después `producto(id)` — un `GET` del
/// producto entero para enterarse de la foto que `subirImagen` **ya había
/// devuelto**. Un viaje completo a Railway para traer algo que estaba en la
/// mano.
///
/// Ahora se usa la respuesta. El `GET` no existe más en este camino.
class SubidasDeFotos extends Notifier<EstadoDeSubidas> {
  int _contador = 0;

  @override
  EstadoDeSubidas build() => const EstadoDeSubidas();

  /// Empieza a subir. La miniatura local ya se puede mostrar.
  ///
  /// No hay nada que esperar de este `Future`: quien llama sigue con lo suyo.
  Future<void> subir({required String productId, required File archivo}) async {
    final foto = FotoEnVuelo(
      clave: 'foto-${_contador++}',
      productId: productId,
      rutaLocal: archivo.path,
    );

    state = EstadoDeSubidas(
      enVuelo: [...state.enVuelo, foto],
      recienSubidas: state.recienSubidas,
    );

    await _enviar(foto, archivo);
  }

  /// Vuelve a intentar una que falló.
  Future<void> reintentar(String clave) async {
    final foto = state.enVuelo.where((f) => f.clave == clave).firstOrNull;
    if (foto == null || !foto.fallo) return;

    // Se le saca la marca de error: vuelve a estar «subiendo».
    state = EstadoDeSubidas(
      enVuelo: [
        for (final f in state.enVuelo)
          if (f.clave == clave)
            FotoEnVuelo(clave: f.clave, productId: f.productId, rutaLocal: f.rutaLocal)
          else
            f,
      ],
      recienSubidas: state.recienSubidas,
    );

    await _enviar(foto, File(foto.rutaLocal));
  }

  /// La descarta sin subirla. Para cuando alguien se rinde con una que falla.
  void descartar(String clave) {
    state = EstadoDeSubidas(
      enVuelo: state.enVuelo.where((f) => f.clave != clave).toList(),
      recienSubidas: state.recienSubidas,
    );
  }

  /// Olvida lo ya subido de un producto.
  ///
  /// Lo llama el editor cuando vuelve a traer el producto del servidor: a
  /// partir de ahí las fotos vienen ahí adentro y mantener la copia sería
  /// arrastrar una segunda lista que puede quedar vieja.
  void olvidarSubidas(String productId) {
    if (!state.recienSubidas.containsKey(productId)) return;
    state = EstadoDeSubidas(
      enVuelo: state.enVuelo,
      recienSubidas: {...state.recienSubidas}..remove(productId),
    );
  }

  Future<void> _enviar(FotoEnVuelo foto, File archivo) async {
    try {
      final imagen = await ref.read(sellerRepositoryProvider).subirImagen(foto.productId, archivo);

      /**
       * ⚠️ Primero se guarda la imagen que volvió y DESPUÉS se saca la que
       * estaba en vuelo, en la misma asignación.
       *
       * En dos pasos, entre uno y otro la tira se queda sin ninguna de las dos
       * y la miniatura parpadea: desaparece la local y todavía no está la del
       * servidor. Es el mismo orden que en el borrado de productos.
       */
      state = EstadoDeSubidas(
        enVuelo: state.enVuelo.where((f) => f.clave != foto.clave).toList(),
        recienSubidas: {
          ...state.recienSubidas,
          foto.productId: [...state.subidasDe(foto.productId), imagen],
        },
      );
    } catch (e) {
      state = EstadoDeSubidas(
        enVuelo: [
          for (final f in state.enVuelo)
            if (f.clave == foto.clave) f.conError(e) else f,
        ],
        recienSubidas: state.recienSubidas,
      );
    }
  }
}

final subidasDeFotosProvider =
    NotifierProvider<SubidasDeFotos, EstadoDeSubidas>(SubidasDeFotos.new);
