import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Que seguir a alguien SIEMPRE avise.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTE TEST LEE CÓDIGO EN VEZ DE EJECUTARLO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El bug era éste: se sigue a un vendedor desde tres pantallas —el feed, el
/// vivo y su perfil— y ninguna de las tres sabe que la pestaña «Siguiendo»
/// existe. Cada una llamaba a `LiveApi.seguir` por su cuenta, y el feed de
/// seguidos se quedaba con la lista vieja hasta reiniciar la app.
///
/// `Seguimientos` lo arregla: pasa por un solo lugar y avisa una sola vez. Pero
/// nada impide que la pantalla número cuatro vuelva a llamar a `LiveApi`
/// directo, y el síntoma sería otra vez «tengo que reiniciar para verlo» —el
/// tipo de bug que nadie asocia con la pantalla que lo causó.
///
/// Un test de comportamiento no puede pillar eso: probaría la pantalla que ya
/// está bien. Lo único que lo pilla es mirar quién llama a qué, que es
/// exactamente lo que hace este archivo.
void main() {
  /// Los únicos archivos donde se puede seguir a alguien.
  ///
  /// `seguimientos.dart` es la puerta que avisa a la pestaña «Siguiendo», y
  /// `perfil_de_vendedor.dart` es el estado compartido por `sellerId` que la
  /// atraviesa. Cualquier pantalla que llame por su cuenta se saltea los dos:
  /// no avisa, y deja su propia copia de «lo sigo» que va a contradecir a las
  /// otras superficies del mismo vendedor.
  const puertasUnicas = [
    'lib/features/social/data/seguimientos.dart',
    'lib/features/social/data/perfil_de_vendedor.dart',
  ];

  /// Y el archivo donde vive la llamada HTTP.
  const definicion = 'lib/features/lives/data/live_api.dart';

  List<File> dartDeLib() => Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .toList();

  String rutaNormal(File f) => f.path.replaceAll(r'\', '/');

  test('⛔ sólo Seguimientos llama a seguir/dejarDeSeguir', () {
    // Quien llama a la API: `algo.seguir(...)` o `algo.dejarDeSeguir(...)`.
    final llamada = RegExp(r'\.(seguir|dejarDeSeguir)\(');

    final culpables = <String>[];
    for (final archivo in dartDeLib()) {
      final ruta = rutaNormal(archivo);
      if (puertasUnicas.any(ruta.endsWith) || ruta.endsWith(definicion)) continue;

      final texto = archivo.readAsStringSync();
      for (final linea in texto.split('\n')) {
        // Las llamadas al notifier son las correctas: pasan por Seguimientos.
        if (linea.contains('seguimientos.')) continue;
        if (llamada.hasMatch(linea)) culpables.add('$ruta: ${linea.trim()}');
      }
    }

    expect(
      culpables,
      isEmpty,
      reason:
          'Seguir a alguien tiene que pasar por `seguimientosProvider`, que es lo '
          'que avisa a la pestaña «Siguiendo». Llamando a `LiveApi` directo, el '
          'feed de seguidos no se entera hasta reiniciar la app.',
    );
  });

  /// Y que la puerta única siga siendo la que avisa.
  ///
  /// Sin esto, alguien podría vaciar `Seguimientos` —dejándolo como un simple
  /// reenvío a `LiveApi`— y el test de arriba seguiría en verde mientras el bug
  /// vuelve entero.
  test('⛔ Seguimientos sube su versión al seguir', () {
    final texto = File(puertasUnicas.first).readAsStringSync();

    expect(texto, contains('state = state + 1'));
  });
}
