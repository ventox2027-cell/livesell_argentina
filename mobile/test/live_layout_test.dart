import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/lives/presentation/layout_del_vivo.dart';

/// La zona inferior del vivo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE AFIRMAN INVARIANTES, NO PÍXELES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Ninguno de estos tests dice "el producto va a 188". Las alturas se van a
/// tocar cuando esto se pruebe en un teléfono real, y un test que fije el
/// número obligaría a editarlo en cada ajuste — hasta que alguien lo edite sin
/// mirar y deje de proteger nada.
///
/// Lo que sí se afirma es lo que no puede cambiar nunca: que el producto no
/// baje, que no quede tapado, y que nada se pise.
void main() {
  // Un teclado de Android ocupa cerca del 40% de la pantalla.
  const teclado = 320.0;
  // La barra de gestos de un teléfono moderno.
  const abajo = 34.0;

  group('El producto destacado', () {
    test('con el teclado abierto NUNCA baja de donde estaba', () {
      final reposo = medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: true);
      final escribiendo = medirZonaInferior(teclado: teclado, abajo: abajo, hayProducto: true);

      expect(
        escribiendo.producto!,
        greaterThanOrEqualTo(reposo.producto!),
        reason: 'El producto se movió hacia abajo al abrir el teclado',
      );
    });

    test('con el teclado abierto NO queda tapado', () {
      final m = medirZonaInferior(teclado: teclado, abajo: abajo, hayProducto: true);

      /**
       * Esta es la razón de todo el módulo.
       *
       * Un producto clavado en su posición de reposo —unos 124 px— quedaría
       * detrás de un teclado de 320. Quieto, sí, pero invisible: exactamente el
       * problema que había que resolver.
       */
      expect(
        m.producto!,
        greaterThan(teclado),
        reason: 'El producto quedó detrás del teclado',
      );
    });

    test('no se dibuja si el vendedor no está destacando nada', () {
      final m = medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: false);
      expect(m.producto, isNull);
    });

    test('un teclado más bajo que su posición de reposo no lo mueve', () {
      // Caso real: teclado físico con barra de sugerencias, o el teclado de
      // emoji de algunos fabricantes. Sin el `max`, el producto bajaría.
      final reposo = medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: true);
      final chiquito = medirZonaInferior(teclado: 20, abajo: abajo, hayProducto: true);

      expect(chiquito.producto, reposo.producto);
    });
  });

  group('El composer', () {
    test('se ancla arriba del teclado', () {
      final m = medirZonaInferior(teclado: teclado, abajo: abajo, hayProducto: true);
      expect(m.composer, greaterThan(teclado));
    });

    test('en reposo deja lugar a la fila del vendedor', () {
      final m = medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: true);
      expect(m.composer, greaterThanOrEqualTo(m.vendedor + altoVendedor - aire));
    });

    test('nunca se superpone con el producto', () {
      for (final k in [0.0, 120.0, 250.0, teclado, 500.0]) {
        final m = medirZonaInferior(teclado: k, abajo: abajo, hayProducto: true);
        expect(
          m.producto!,
          greaterThanOrEqualTo(m.composer + altoComposer),
          reason: 'Se pisan con un teclado de $k',
        );
      }
    });
  });

  group('El chat', () {
    test('queda siempre por encima de todo lo demás', () {
      for (final k in [0.0, 120.0, teclado]) {
        for (final hayProducto in [true, false]) {
          final m = medirZonaInferior(teclado: k, abajo: abajo, hayProducto: hayProducto);

          final techo = m.producto != null
              ? m.producto! + altoProducto
              : m.composer + altoComposer;

          expect(
            m.chat,
            greaterThanOrEqualTo(techo),
            reason: 'El chat pisa la zona fija con teclado $k y producto $hayProducto',
          );
        }
      }
    });

    test('cede altura cuando aparece el teclado', () {
      final reposo = medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: true);
      final escribiendo = medirZonaInferior(teclado: teclado, abajo: abajo, hayProducto: true);

      expect(escribiendo.altoDelChat, lessThan(reposo.altoDelChat));
    });
  });

  group('La fila del vendedor', () {
    test('se esconde mientras se escribe', () {
      expect(
        medirZonaInferior(teclado: teclado, abajo: abajo, hayProducto: true).mostrarVendedor,
        isFalse,
      );
    });

    test('vuelve al cerrar el teclado', () {
      expect(
        medirZonaInferior(teclado: 0, abajo: abajo, hayProducto: true).mostrarVendedor,
        isTrue,
      );
    });
  });

  group('Sin barra de gestos', () {
    // Teléfonos con botones físicos, y el emulador con la barra oculta.
    test('nada queda con posición negativa', () {
      final m = medirZonaInferior(teclado: 0, abajo: 0, hayProducto: true);

      expect(m.chat, greaterThan(0));
      expect(m.producto!, greaterThan(0));
      expect(m.composer, greaterThan(0));
      expect(m.vendedor, greaterThanOrEqualTo(0));
    });
  });
}
