import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/config/paginas_publicas.dart';

/// Las dos URLs públicas que Google Play verifica.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO SE TESTEA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La app declara dos direcciones y el repositorio tiene dos carpetas que
/// deberían responderlas. Nada más ata una cosa con la otra: renombrar
/// `backend/web/privacidad/` a `.../privacy/` compila, pasa el análisis y deja el
/// enlace de la app apuntando a un 404 — que es exactamente el motivo por el
/// que Google rechaza una publicación.
///
/// Este test es esa atadura.
void main() {
  group('Las páginas públicas', () {
    /// La raíz del repositorio. Los tests corren desde `mobile/`.
    final repo = Directory.current.parent;

    /// `https://vendox.com.ar/privacidad` → `backend/web/privacidad/index.html`
    File archivoDe(String url) {
      final ruta = Uri.parse(url).path.replaceAll(RegExp(r'^/|/$'), '');
      // ⚠️ `backend/web`, no `web`. El sitio lo sirve el backend, y el contexto
      // de construcción de su imagen es `backend/`: con la carpeta en la raíz
      // del repositorio Docker no la puede copiar y el sitio devuelve 404 en
      // producción sin que nada falle.
      return File('${repo.path}/backend/web/$ruta/index.html');
    }

    test('⛔ la página de privacidad existe en el repositorio', () {
      final archivo = archivoDe(PaginasPublicas.privacidad);
      expect(
        archivo.existsSync(),
        isTrue,
        reason:
            'La app enlaza ${PaginasPublicas.privacidad} y no hay nada en ${archivo.path}. '
            'O se renombró la carpeta, o se cambió la constante.',
      );
    });

    test('⛔ la página de eliminación de cuenta existe en el repositorio', () {
      // Google Play la exige aparte de la política de privacidad, declarada en
      // Contenido de la app → Eliminación de datos.
      final archivo = archivoDe(PaginasPublicas.eliminarCuenta);
      expect(archivo.existsSync(), isTrue, reason: 'Falta ${archivo.path}');
    });

    test('las dos son https y del dominio oficial', () {
      for (final url in [PaginasPublicas.privacidad, PaginasPublicas.eliminarCuenta]) {
        final u = Uri.parse(url);
        expect(u.scheme, 'https');
        expect(u.host, 'vendox.com.ar');
      }
    });

    test('cada página enlaza a la otra', () {
      // Quien llega a una tiene que poder llegar a la otra: son las dos únicas
      // páginas públicas y separarlas obliga a volver a la app para navegar.
      final privacidad = archivoDe(PaginasPublicas.privacidad).readAsStringSync();
      final eliminar = archivoDe(PaginasPublicas.eliminarCuenta).readAsStringSync();

      expect(privacidad, contains('/eliminar-cuenta'));
      expect(eliminar, contains('/privacidad'));
    });

    test('⛔ ninguna promete un correo distinto del que publicamos', () {
      /**
       * Las dos páginas prometen respuesta en 10 días corridos a una dirección
       * concreta. Si cada una dice una distinta, una de las dos no la lee
       * nadie.
       */
      for (final url in [PaginasPublicas.privacidad, PaginasPublicas.eliminarCuenta]) {
        final html = archivoDe(url).readAsStringSync();
        final correos = RegExp(r'mailto:([^"?]+)')
            .allMatches(html)
            .map((m) => m.group(1))
            .toSet();
        expect(correos, {'privacidad@vendox.com.ar'});
      }
    });
  });

  group('El enlace legal', () {
    testWidgets('se ve y se puede tocar', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: EnlacesLegales(prefijo: 'Al continuar aceptás los Términos y la '),
          ),
        ),
      );

      // El texto completo, con el enlace adentro.
      expect(
        find.text('Al continuar aceptás los Términos y la Política de privacidad.',
            findRichText: true),
        findsOneWidget,
      );

      /**
       * Y "Política de privacidad" tiene un reconocedor de toques.
       *
       * Sin esto, el test pasaría con el texto plano de antes: la frase se leía
       * igual y no se podía tocar, que era justamente el problema.
       */
      final rich = tester.widget<Text>(find.byType(Text));
      final tramos = (rich.textSpan! as TextSpan).children!.cast<TextSpan>();
      final enlace = tramos.firstWhere((t) => t.text == 'Política de privacidad');
      expect(enlace.recognizer, isNotNull);
    });
  });
}
