import 'package:dio/dio.dart';
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

  /**
   * Se pide como `dynamic` y no como `List<dynamic>`.
   *
   * `ApiClient` no lanza por códigos menores a 500, así que un 404 llega acá
   * como respuesta normal — con un objeto de error en el cuerpo. Pedirlo
   * tipado hace que Dio intente meter ese objeto en un `List` y reviente con
   * un `TypeError` antes de que podamos mirar el código de estado, que es
   * justo el dato que necesitamos para decir la verdad.
   */
  final res = await api.get<dynamic>('/categories');

  if (res.statusCode != 200) {
    throw FalloDeCategorias(MotivoDeFallo.servidor, statusCode: res.statusCode);
  }

  final cuerpo = res.data;
  if (cuerpo is! List) {
    throw const FalloDeCategorias(MotivoDeFallo.respuestaInesperada);
  }

  return cuerpo
      .map<Categoria>((e) => Categoria.fromJson(e as Map<String, dynamic>))
      .toList(growable: false);
});

/// Por qué no se pudo traer el catálogo.
enum MotivoDeFallo {
  /// No se llegó al servidor: no hay red, o la dirección no responde.
  sinConexion,

  /// Se llegó y contestó algo que no es la lista. Lleva el código.
  servidor,

  /// Se llegó y no contestó a tiempo.
  demorado,

  /// Contestó 200 con algo que no es una lista.
  respuestaInesperada,
}

class FalloDeCategorias implements Exception {
  const FalloDeCategorias(this.motivo, {this.statusCode});

  final MotivoDeFallo motivo;
  final int? statusCode;

  @override
  String toString() => 'FalloDeCategorias($motivo, status: $statusCode)';
}

/// Qué decirle a la persona cuando el rubro no carga.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «SIN CONEXIÓN» ERA MENTIRA LA MAYORÍA DE LAS VECES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La pantalla descartaba el error y mostraba siempre el mismo texto. Con el
/// servidor arriba y contestando 404 —porque el proceso era viejo y no tenía
/// la ruta— el cartel decía «Sin conexión con el servidor».
///
/// Eso mandó a buscar un problema de red que no existía: WiFi, firewall, IP.
/// El servidor estaba a un `curl` de distancia contestando perfecto.
///
/// El número del código va en el texto a propósito. No es ruido: es la
/// diferencia entre veinte minutos de búsqueda y dos.
///
/// Función pura para poder probarla sin levantar una pantalla.
String mensajeDeFalloDeCategorias(Object error) {
  final motivo = switch (error) {
    FalloDeCategorias(:final motivo) => motivo,
    DioException(:final type) => switch (type) {
        DioExceptionType.connectionError ||
        DioExceptionType.connectionTimeout =>
          MotivoDeFallo.sinConexion,
        DioExceptionType.receiveTimeout ||
        DioExceptionType.sendTimeout =>
          MotivoDeFallo.demorado,
        // 500 o más: `ApiClient` sí lanza en ese rango.
        DioExceptionType.badResponse => MotivoDeFallo.servidor,
        _ => MotivoDeFallo.respuestaInesperada,
      },
    _ => MotivoDeFallo.respuestaInesperada,
  };

  final codigo = switch (error) {
    FalloDeCategorias(:final statusCode) => statusCode,
    DioException(:final response) => response?.statusCode,
    _ => null,
  };

  return switch (motivo) {
    MotivoDeFallo.sinConexion => 'Sin conexión con el servidor',
    MotivoDeFallo.demorado => 'El servidor tardó demasiado en responder',
    MotivoDeFallo.servidor => codigo == null
        ? 'El servidor no pudo darnos la lista'
        : 'El servidor no pudo darnos la lista ($codigo)',
    MotivoDeFallo.respuestaInesperada => 'No pudimos leer la lista',
  };
}
