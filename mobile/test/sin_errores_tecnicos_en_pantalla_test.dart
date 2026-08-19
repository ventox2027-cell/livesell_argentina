import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Nadie vuelve a mostrar un error del sistema en la pantalla.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO ES UN TEST Y NO UNA REGLA ESCRITA EN ALGÚN LADO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El bug no lo causó nadie distraído. `AppSnack.error(context, e.toString())`
/// es lo que uno escribe sin pensarlo: compila, se ve razonable en el editor, y
/// en un test contra un backend falso muestra un texto perfectamente legible.
///
/// Sólo falla en un teléfono real con el wifi caído, que es donde nadie mira.
/// Por eso hace falta algo que lo detenga antes:
///
///     DioException [connection error]: The connection errored:
///     Failed host lookup: 'api.vendox.com.ar' (OS Error: No address
///     associated with hostname, errno = 7)
///
/// Había 22 apariciones repartidas en 14 pantallas. Este test existe para que la
/// número 23 no llegue a un release.
void main() {
  /// Las pantallas del spike quedan afuera.
  ///
  /// Son herramientas de medición internas, detrás de `Entorno.herramientas`,
  /// que es una constante de compilación: el bloque no existe en el binario de
  /// release. Ahí el detalle técnico es justamente lo que se quiere ver.
  const exentos = ['lib/features/spike/'];

  test('⛔ ninguna pantalla muestra e.toString() a la persona', () {
    final culpables = <String>[];

    for (final archivo in Directory('lib/features')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))) {
      final ruta = archivo.path.replaceAll(r'\', '/');
      if (!ruta.contains('/presentation/')) continue;
      if (exentos.any(ruta.contains)) continue;

      final lineas = archivo.readAsLinesSync();
      for (var i = 0; i < lineas.length; i++) {
        // `e.toString()` y no cualquier `.toString()`: formatear un número o
        // un minuto es legítimo y no tiene nada que ver con esto. Lo que se
        // busca es el error atrapado en un `catch (e)` yendo a la pantalla.
        if (RegExp(r'\be\.toString\(\)').hasMatch(lineas[i])) {
          culpables.add('$ruta:${i + 1}');
        }
      }
    }

    expect(
      culpables,
      isEmpty,
      reason: 'Usá mensajeDeError(e) de core/network/errores_de_red.dart.\n'
          'Mostrar el error crudo publica el hostname del backend y un errno, y '
          'hace que la persona cierre la app en vez de esperar a que vuelva la '
          'señal.\n'
          'Encontrado en:\n  ${culpables.join('\n  ')}',
    );
  });

  /// ⛔ Y el estado de error se recarga solo cuando vuelve la red.
  ///
  /// Mostrar un mensaje amable no alcanza: si la pantalla sigue rota después de
  /// que volvió internet, el bug que se estaba arreglando sigue ahí. Toda
  /// pantalla con un estado de error de una carga tiene que envolverlo.
  ///
  /// La comprobación es por archivo y no por línea a propósito: buscar el
  /// widget exacto en cada `error:` obligaría a analizar sintaxis. Alcanza con
  /// que el archivo que muestra errores de carga sepa de la reconexión.
  test('⛔ las pantallas con estado de error se recargan al volver la red', () {
    /// Pantallas de carga con estado de error propio.
    ///
    /// Lista explícita y no descubierta: agregar una pantalla nueva a esta
    /// lista es una decisión, y así el test no se vuelve trivialmente
    /// satisfacible borrando una entrada sin querer.
    const pantallas = [
      'lib/features/feed/presentation/feed_screen.dart',
      'lib/features/inventory/presentation/stock_screen.dart',
      'lib/features/orders/presentation/orders_screen.dart',
      'lib/features/orders/presentation/seller_orders_screen.dart',
      'lib/features/seller/presentation/seller_home_screen.dart',
      // La segunda tanda. Estas cinco YA mostraban un texto escrito a mano —
      // nunca filtraron un `DioException`— pero no volvían solas: había que
      // tocar «Reintentar» aunque la señal ya hubiera vuelto.
      //
      // Mostrar un mensaje legible es la mitad del arreglo. La otra mitad es
      // que la pantalla se recupere sin que nadie la toque.
      'lib/features/lives/presentation/live_viewer_screen.dart',
      'lib/features/lives/presentation/seller_profile_screen.dart',
      'lib/features/moderation/presentation/bloqueados_screen.dart',
      'lib/features/notifications/presentation/notifications_screen.dart',
      'lib/features/support/presentation/soporte_screen.dart',
    ];

    for (final p in pantallas) {
      final fuente = File(p).readAsStringSync();
      expect(
        fuente,
        contains('ReintentarAlVolverLaRed'),
        reason: '$p muestra un error de carga pero no se recupera sola cuando '
            'vuelve la red.',
      );
    }
  });
}
