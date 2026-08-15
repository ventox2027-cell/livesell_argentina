import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/state/auth_providers.dart';

/// Una categoría del catálogo.
class Categoria {
  const Categoria({required this.id, required this.slug, required this.nombre});

  factory Categoria.fromJson(Map<String, dynamic> j) => Categoria(
        id: j['id'] as String,
        slug: j['slug'] as String? ?? '',
        nombre: j['nombre'] as String? ?? '',
      );

  final String id;
  final String slug;
  final String nombre;
}

/// El catálogo de categorías.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE PIDE AL SERVIDOR Y NO SE COPIA EN LA APP
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Copiar las catorce categorías acá sería más rápido y arruinaría lo único
/// que hace configurable al catálogo: el día que se agregue una, habría que
/// publicar una versión de la app y esperar a que todo el mundo actualice.
///
/// Con `keepAlive` la lista se pide una vez por sesión. Cambia una vez por
/// trimestre; volver a pedirla cada vez que se abre el editor de un producto
/// sería un viaje por cada carga de un formulario.
final categoriasProvider = FutureProvider<List<Categoria>>((ref) async {
  ref.keepAlive();

  final api = ref.watch(apiClientProvider);
  final res = await api.get<List<dynamic>>('/categories');
  if (res.statusCode != 200 || res.data == null) {
    throw Exception('No se pudieron cargar las categorías');
  }

  return res.data!
      .map<Categoria>((e) => Categoria.fromJson(e as Map<String, dynamic>))
      .toList(growable: false);
});
