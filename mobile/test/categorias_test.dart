import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/data/categorias_api.dart';
import 'package:vendox/features/seller/presentation/product_editor_screen.dart';

/// El selector de rubro del editor de producto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// QUÉ PROTEGE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El rubro es obligatorio para publicar. Si el selector no aparece, o aparece
/// roto, el vendedor carga el producto y descubre el requisito recién cuando
/// toca Publicar y el backend lo rechaza — con todo el trabajo ya hecho.
void main() {
  const catalogo = [
    Categoria(id: 'cat_indumentaria', slug: 'indumentaria', nombre: 'Indumentaria'),
    Categoria(id: 'cat_calzado', slug: 'calzado', nombre: 'Calzado'),
    Categoria(id: 'cat_otros', slug: 'otros', nombre: 'Otros'),
  ];

  Widget editor({AsyncValue<List<Categoria>>? estado}) => ProviderScope(
        overrides: [
          categoriasProvider.overrideWith(
            (ref) async => switch (estado) {
              AsyncError(:final error) => throw error,
              _ => catalogo,
            },
          ),
        ],
        child: const MaterialApp(home: ProductEditorScreen()),
      );

  testWidgets('el rubro aparece en el formulario de un producto nuevo', (tester) async {
    await tester.pumpWidget(editor());
    await tester.pumpAndSettle();

    expect(find.text('Rubro'), findsOneWidget);
    // Y dice para qué sirve: sin esto es un campo más que se saltea.
    expect(find.textContaining('Hace falta para publicar'), findsOneWidget);
  });

  testWidgets('se puede elegir una categoría de la lista', (tester) async {
    await tester.pumpWidget(editor());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();

    // Las tres del catálogo, en el desplegable abierto.
    expect(find.text('Calzado').hitTestable(), findsOneWidget);

    await tester.tap(find.text('Calzado').hitTestable());
    await tester.pumpAndSettle();

    expect(find.text('Calzado'), findsOneWidget);
  });

  testWidgets('⛔ si el catálogo no carga, el formulario sigue usable', (tester) async {
    /**
     * El caso de la mala señal. Un vendedor en un sótano tiene que poder
     * guardar el borrador igual: lo único que no va a poder es publicar, y eso
     * ya se lo dice el botón de publicar.
     *
     * Sin esto, un `throw` dentro de un `when` sin rama de error tumba la
     * pantalla entera del editor.
     */
    await tester.pumpWidget(editor(estado: AsyncError(Exception('sin red'), StackTrace.empty)));
    await tester.pumpAndSettle();

    expect(find.textContaining('No se pudo cargar'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);

    // El resto del formulario está entero.
    expect(find.text('¿Qué vendés?'), findsOneWidget);
    expect(find.text('Precio'), findsOneWidget);
    expect(find.text('Crear producto'), findsOneWidget);
  });
}
