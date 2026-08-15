import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/core/design/componentes.dart';
import 'package:vendox/core/design/tokens.dart';

/// La identidad visual, como reglas que se ejecutan.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO ES UN TEST Y NO UNA GUÍA DE ESTILO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Una guía de estilo dice «el texto tiene que contrastar». Seis meses después
/// alguien aclara un violeta para que se vea más lindo en su monitor, el
/// contraste baja de 4,5 a 3,9, y nadie se entera hasta que una persona con
/// poca visión no puede leer el botón de comprar.
///
/// Estos tests calculan el contraste de verdad, con la fórmula de la WCAG. Si
/// alguien toca un color de marca y rompe la accesibilidad, el build falla y
/// tiene que decidirlo a propósito.
void main() {
  /// Luminancia relativa según la WCAG 2.1.
  ///
  /// No es el brillo que uno ve: es una fórmula con una corrección de gamma y
  /// pesos distintos por canal, porque el ojo humano es mucho más sensible al
  /// verde que al azul. Por eso el cyan «se ve» brillante y el violeta no,
  /// aunque los dos sean colores saturados.
  double luminancia(Color c) {
    double canal(double v) {
      final s = v / 255.0;
      return s <= 0.03928 ? s / 12.92 : math.pow((s + 0.055) / 1.055, 2.4).toDouble();
    }

    return 0.2126 * canal(c.r * 255) + 0.7152 * canal(c.g * 255) + 0.0722 * canal(c.b * 255);
  }

  double contraste(Color a, Color b) {
    final la = luminancia(a);
    final lb = luminancia(b);
    final claro = math.max(la, lb);
    final oscuro = math.min(la, lb);
    return (claro + 0.05) / (oscuro + 0.05);
  }

  group('Contraste', () {
    const minimoAA = 4.5;

    test('⛔ el texto blanco sobre el violeta de acción pasa AA', () {
      /**
       * El botón de comprar. Es el contraste más importante de la app: si
       * falla, la acción que genera plata es la que no se puede leer.
       *
       * `#6D4AFF` da 5,2:1. El violeta que se había elegido primero —`#8B5CF6`,
       * más lindo— daba 4,3:1 y no pasaba. Ese es el motivo de que el token sea
       * el que es y no otro.
       */
      expect(contraste(Colors.white, AppColor.acento), greaterThanOrEqualTo(minimoAA));
    });

    test('⛔ el texto blanco sobre el magenta de EN VIVO pasa AA', () {
      // El badge lleva la palabra EN VIVO en blanco encima.
      expect(contraste(Colors.white, AppColor.vivo), greaterThanOrEqualTo(minimoAA));
    });

    test('⛔ el gradiente de acción es legible en TODO su recorrido', () {
      /**
       * Es la regla que justifica que existan dos gradientes.
       *
       * Un gradiente no tiene un color: tiene infinitos. El texto blanco tiene
       * que pasar AA en los dos extremos, porque en el medio el contraste nunca
       * es peor que en el peor de los dos.
       */
      for (final color in AppColor.gradienteAccion.colors) {
        expect(
          contraste(Colors.white, color),
          greaterThanOrEqualTo(minimoAA),
          reason: 'El blanco no se lee sobre $color, que está en gradienteAccion',
        );
      }
    });

    test('⛔ el gradiente de MARCA no sería legible: por eso no lleva texto', () {
      /**
       * Este test verifica una imposibilidad, y es a propósito.
       *
       * Documenta por qué `gradienteMarca` no se puede usar debajo de texto: no
       * existe un color de letra que funcione sobre el cyan Y sobre el violeta.
       * Si algún día alguien "arregla" el gradiente para que sí se pueda, este
       * test falla y lo obliga a leer la nota de `tokens.dart` antes de meter
       * texto encima.
       */
      final blancoSobreCyan = contraste(Colors.white, AppColor.cyanNeon);
      final negroSobreVioleta = contraste(AppColor.sobreCyan, AppColor.acento);

      expect(blancoSobreCyan, lessThan(minimoAA),
          reason: 'Si esto pasa, el cyan de marca cambió y hay que revisar la regla');
      expect(negroSobreVioleta, lessThan(minimoAA));
    });

    test('los colores de estado se leen sobre el fondo oscuro', () {
      // Casi siempre son texto o ícono sobre negro o sobre superficie.
      for (final (nombre, color) in [
        ('exito', AppColor.exito),
        ('info', AppColor.info),
        ('alerta', AppColor.alerta),
        ('error', AppColor.error),
      ]) {
        expect(
          contraste(color, AppColor.superficie),
          greaterThanOrEqualTo(minimoAA),
          reason: '$nombre no se lee sobre una tarjeta',
        );
      }
    });

    test('⛔ el texto sobre rellenos claros es oscuro, no blanco', () {
      // Lima y cyan son clarísimos: el blanco encima es ilegible.
      expect(contraste(AppColor.sobreLima, AppColor.exito), greaterThanOrEqualTo(minimoAA));
      expect(contraste(AppColor.sobreCyan, AppColor.info), greaterThanOrEqualTo(minimoAA));
      expect(contraste(Colors.white, AppColor.exito), lessThan(minimoAA));
    });
  });

  group('Cada color tiene un trabajo', () {
    test('⛔ el acento y el de EN VIVO son colores distintos', () {
      // Uno invita a tocar, el otro indica estado. Si fueran el mismo, el
      // badge del vivo parecería un botón.
      expect(AppColor.acento, isNot(AppColor.vivo));
    });

    test('⛔ el error no se confunde con el magenta del vivo', () {
      // ═══════════════════════════════════════════════════════════════════════
      // LA PRIMERA VERSIÓN DE ESTE TEST MEDÍA LO EQUIVOCADO
      // ═══════════════════════════════════════════════════════════════════════
      //
      // Medía distancia de TONO y exigía 40°. Rojo (359°) y magenta (328°)
      // están a 31°, así que fallaba.
      //
      // Y el test estaba mal, no los colores. Con el magenta en 328° y el ámbar
      // de alerta en 38°, el arco disponible para un rojo son 70°: cualquier
      // rojo que se aleje 40° del magenta queda a menos de 30° del ámbar. El
      // umbral pedía algo imposible, así que la única forma de «arreglarlo»
      // hubiera sido romper otra cosa.
      //
      // Lo que de verdad separa un rojo de un magenta no es el tono: es cuánto
      // azul tienen. El magenta es rojo CON azul; el rojo puro no tiene. Eso es
      // lo que el ojo usa para distinguirlos, y es lo que se mide acá.
      double inclinacionAlAzul(Color c) => (c.b - c.g) * 255;

      expect(inclinacionAlAzul(AppColor.vivo), greaterThan(80),
          reason: 'El magenta perdió su componente azul y se volvió un rojo más');
      expect(inclinacionAlAzul(AppColor.error).abs(), lessThan(30),
          reason: 'El rojo de error se está yendo a magenta');
    });

    test('el gris de inactivo no tiene marca', () {
      // Lo apagado no es de nadie: saturación baja.
      expect(HSLColor.fromColor(AppColor.inactivo).saturation, lessThan(0.2));
    });
  });

  group('Los componentes de marca', () {
    testWidgets('el CTA apagado no muestra gradiente ni glow', (tester) async {
      // Un botón principal apagado que igual brilla invita a tocarlo.
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: BotonVendoX(etiqueta: 'Comprar', onTap: null)),
        ),
      );
      await tester.pump();

      final caja = tester.widget<AnimatedContainer>(find.byType(AnimatedContainer));
      final deco = caja.decoration! as BoxDecoration;
      expect(deco.gradient, isNull);
      expect(deco.boxShadow, isNull);
    });

    testWidgets('el CTA encendido usa el gradiente de acción', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: BotonVendoX(etiqueta: 'Comprar', onTap: () {})),
        ),
      );
      await tester.pump();

      final caja = tester.widget<AnimatedContainer>(find.byType(AnimatedContainer));
      final deco = caja.decoration! as BoxDecoration;
      expect(deco.gradient, AppColor.gradienteAccion);
    });

    testWidgets('⛔ el badge no inventa espectadores', (tester) async {
      /**
       * Sin dato real, no se muestra número. Es la regla de veracidad del
       * producto llevada al widget: la alternativa —un «0» o un placeholder—
       * se lee como información y no lo es.
       */
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: BadgeEnVivo())),
      );
      await tester.pump();

      expect(find.text('EN VIVO'), findsOneWidget);
      expect(find.text('0'), findsNothing);
    });

    testWidgets('con espectadores reales, los muestra', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: BadgeEnVivo(espectadores: 143))),
      );
      await tester.pump();

      expect(find.text('143'), findsOneWidget);
    });
  });
}
