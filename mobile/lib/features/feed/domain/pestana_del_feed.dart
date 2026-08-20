import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Cuál de las dos pestañas del feed se está mirando.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «SIGUIENDO» ERA UNA ETIQUETA, NO UNA PESTAÑA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Estaba dibujada al lado de «Para vos» con el subrayado apagado y **sin nada
/// que la escuchara**: ni `onTap`, ni estado, ni provider. Tocarla no hacía
/// nada porque no había nada que hacer.
///
/// La elección vive en un provider y no en el `State` de la pantalla porque la
/// barra de arriba es un widget aparte del cuerpo: con `setState` la barra
/// tendría el dato y el feed no.
enum PestanaDelFeed {
  paraVos,
  siguiendo;

  bool get esSiguiendo => this == PestanaDelFeed.siguiendo;
}

class PestanaDelFeedNotifier extends Notifier<PestanaDelFeed> {
  @override
  PestanaDelFeed build() => PestanaDelFeed.paraVos;

  /// ⚠️ Cambiar de pestaña NO recarga nada.
  ///
  /// Cada pestaña tiene su propio provider con su lista ya cargada. Ir y volver
  /// entre ellas no cuesta una petición ni pierde el lugar donde alguien estaba
  /// mirando — que es la diferencia entre una pestaña y un botón de recargar.
  void elegir(PestanaDelFeed cual) => state = cual;
}

final pestanaDelFeedProvider =
    NotifierProvider<PestanaDelFeedNotifier, PestanaDelFeed>(PestanaDelFeedNotifier.new);
