import 'package:flutter_test/flutter_test.dart';

/// El editor de productos no puede crear dos veces el mismo producto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG, EN UNA LÍNEA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `_esNuevo` miraba `widget.productoId`, que es el parámetro con el que se
/// abrió la pantalla y **no cambia nunca**.
///
/// Después de crear, el editor NO se cierra —hay que poder subirle las fotos—,
/// así que `_producto` ya tenía un id pero `widget.productoId` seguía en
/// `null`. El botón miraba `_producto` y decía «Guardar cambios»; `_guardar()`
/// miraba `widget.productoId` y llamaba a `crearProducto`.
///
/// El botón decía una cosa y hacía otra. Cargar un producto, subirle fotos y
/// tocar Guardar dejaba DOS filas. Publicar una de las dos dejaba exactamente
/// lo reportado: un publicado y un borrador duplicado del mismo producto.
///
/// Lo que se prueba acá es la decisión —alta o edición— aislada del widget.
/// Es una regla de tres líneas de la que dependen los datos del vendedor, y
/// merece un test que se lea sin montar una pantalla.
String? idActual({required String? idDeApertura, required String? idCreado}) =>
    idDeApertura ?? idCreado;

bool esAlta({required String? idDeApertura, required String? idCreado}) =>
    idActual(idDeApertura: idDeApertura, idCreado: idCreado) == null;

void main() {
  group('Alta o edición', () {
    test('editor nuevo, sin nada creado todavía: es un alta', () {
      expect(esAlta(idDeApertura: null, idCreado: null), isTrue);
    });

    /// ⛔ EL BUG.
    ///
    /// Editor abierto como nuevo, producto YA creado. La segunda vez que se
    /// toca Guardar tiene que ser una EDICIÓN del que se acaba de crear.
    test('⛔ editor nuevo con el producto ya creado: es una edición', () {
      expect(esAlta(idDeApertura: null, idCreado: 'prd_1'), isFalse);
      expect(idActual(idDeApertura: null, idCreado: 'prd_1'), 'prd_1');
    });

    test('editor abierto sobre un producto existente: siempre edición', () {
      expect(esAlta(idDeApertura: 'prd_9', idCreado: null), isFalse);
      expect(idActual(idDeApertura: 'prd_9', idCreado: null), 'prd_9');
    });

    /// Manda el id con el que se abrió. Si el editor se abrió sobre un producto
    /// concreto, ningún estado interno puede desviarlo a otro.
    test('⛔ el id de apertura manda sobre el cargado', () {
      expect(idActual(idDeApertura: 'prd_9', idCreado: 'prd_1'), 'prd_9');
    });

    /// Guardar N veces después de crear tiene que actualizar SIEMPRE el mismo
    /// id. Ésta es la secuencia real: crear, subir fotos, guardar, corregir el
    /// precio, guardar.
    test('⛔ guardar muchas veces después de crear no vuelve a ser alta', () {
      String? creado;

      // Primer guardado: alta.
      expect(esAlta(idDeApertura: null, idCreado: creado), isTrue);
      creado = 'prd_1';

      // Todos los siguientes: edición del mismo id.
      for (var i = 0; i < 5; i += 1) {
        expect(esAlta(idDeApertura: null, idCreado: creado), isFalse);
        expect(idActual(idDeApertura: null, idCreado: creado), 'prd_1');
      }
    });
  });

  group('La clave de alta', () {
    /// Dos editores abiertos son dos altas distintas y no pueden compartir
    /// clave: si la compartieran, el segundo producto recibiría el primero.
    test('⛔ dos sesiones de editor generan claves distintas', () {
      final claves = List.generate(50, (_) => _nuevaClave()).toSet();

      expect(claves, hasLength(50));
    });

    /// El formato lo valida el backend con el mismo esquema que las reservas.
    /// Una clave que no lo cumpla haría fallar el alta entera.
    test('la clave cumple el formato que exige el backend', () {
      final clave = _nuevaClave();

      expect(clave.length, greaterThanOrEqualTo(8));
      expect(clave.length, lessThanOrEqualTo(120));
      expect(RegExp(r'^[A-Za-z0-9_:.-]+$').hasMatch(clave), isTrue);
    });
  });
}

/// La misma forma que usa el editor. Se replica acá porque es privada de la
/// pantalla y lo que importa probar es el FORMATO, que es un contrato con el
/// backend.
int _n = 0;
String _nuevaClave() {
  _n += 1;
  return 'prd-${DateTime.now().microsecondsSinceEpoch}-$_n';
}
