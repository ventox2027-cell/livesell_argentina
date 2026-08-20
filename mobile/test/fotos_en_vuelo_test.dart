import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/seller/data/seller_repository.dart';
import 'package:vendox/features/seller/data/subidas_de_fotos.dart';
import 'package:vendox/features/seller/domain/fotos_en_vuelo.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// Subir una foto de producto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SEIS SEGUNDOS ENTRE ELEGIR LA FOTO Y VERLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono. Todo en fila y todo esperado antes de dibujar:
///
///   1. `pickImage` achica la foto a 1600 px.
///   2. `POST /products/:id/images` sube el archivo a Railway, que va a R2.
///   3. `GET /products/:id` pide el producto ENTERO para enterarse de la foto
///      que la respuesta anterior ya había devuelto.
///   4. Recién ahí `setState` y aparece la miniatura.
///
/// El 3 era un viaje a otro continente por un dato que estaba en la mano. El 1
/// y el 2 hay que hacerlos igual — pero el archivo ya está en el teléfono desde
/// el paso 1, así que no hay razón para mirarlos.
void main() {
  late _RepoDeFotos repo;

  ProviderContainer contenedor() {
    repo = _RepoDeFotos();
    final c = ProviderContainer(overrides: [sellerRepositoryProvider.overrideWithValue(repo)]);
    addTearDown(c.dispose);
    return c;
  }

  /// Un archivo cualquiera del disco. No se lee: sólo viaja su ruta.
  File archivo(String nombre) => File(nombre);

  group('La tira de fotos', () {
    /// Las tres fuentes se ven como una sola.
    test('junta las del servidor, las recién subidas y las que están subiendo', () {
      final tira = armarTira(
        delServidor: [_imagen('img_1'), _imagen('img_2')],
        recienSubidas: [_imagen('img_3')],
        enVuelo: [_enVuelo('a')],
      );

      expect(tira.subidas.map((i) => i.id), ['img_1', 'img_2', 'img_3']);
      expect(tira.enVuelo.length, 1);
      expect(tira.largo, 4);
    });

    /// ⛔ Una foto no puede aparecer dos veces.
    ///
    /// Pasa siempre que el editor vuelve a pedir el producto: la imagen llega
    /// por el servidor Y sigue en la lista de recién subidas.
    test('⛔ no repite una foto que está en las dos listas', () {
      final tira = armarTira(
        delServidor: [_imagen('img_1')],
        recienSubidas: [_imagen('img_1')],
        enVuelo: const [],
      );

      expect(tira.subidas.length, 1);
    });
  });

  group('Subir', () {
    /// ⛔ EL TEST DEL BUG: la foto se ve sin esperar al servidor.
    ///
    /// El servidor no contesta NUNCA. Si la pantalla esperara la subida, no
    /// habría nada que mostrar — que es exactamente lo que pasaba, sólo que en
    /// el teléfono terminaba contestando a los seis segundos.
    test('⛔ la foto queda visible antes de que el servidor conteste', () async {
      final c = contenedor();
      repo.cuelga = true;

      unawaited(c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          ));
      await Future<void>.delayed(Duration.zero);

      final enVuelo = c.read(subidasDeFotosProvider).deProducto('prd_1');
      expect(enVuelo.length, 1);
      expect(enVuelo.first.rutaLocal, 'foto.jpg');
      expect(enVuelo.first.fallo, isFalse);
    });

    /// ⛔ Y NO se pide el producto entero después de subir.
    ///
    /// `subirImagen` ya devuelve la imagen creada. El `GET /products/:id` que
    /// había era un viaje completo a Railway por un dato que estaba en la
    /// respuesta anterior.
    test('⛔ no vuelve a pedir el producto después de subir', () async {
      final c = contenedor();

      await c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          );

      expect(repo.vecesQueSubio, 1);
      expect(repo.vecesQuePidioElProducto, 0);
    });

    /// Al terminar, la foto pasa de «subiendo» a subida, en un solo paso.
    ///
    /// ⚠️ Si fueran dos asignaciones, entre una y otra la tira se queda sin
    /// ninguna de las dos y la miniatura parpadea.
    test('⛔ al terminar no queda ni un instante sin la foto', () async {
      final c = contenedor();
      final vistos = <int>[];
      c.listen(subidasDeFotosProvider, (_, s) {
        vistos.add(s.deProducto('prd_1').length + s.subidasDe('prd_1').length);
      });

      await c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          );

      expect(vistos, isNotEmpty);
      expect(vistos, everyElement(greaterThanOrEqualTo(1)));
    });
  });

  group('Cuando falla', () {
    /// ⛔ La foto NO se pierde: queda marcada para reintentar.
    test('⛔ queda en la lista, con su error', () async {
      final c = contenedor();
      repo.falla = true;

      await c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          );

      final enVuelo = c.read(subidasDeFotosProvider).deProducto('prd_1');
      expect(enVuelo.length, 1);
      expect(enVuelo.first.fallo, isTrue);
    });

    /// ⛔ Y el reintento la sube de verdad.
    test('⛔ reintentar vuelve a subir la misma foto', () async {
      final c = contenedor();
      repo.falla = true;

      await c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          );
      final clave = c.read(subidasDeFotosProvider).deProducto('prd_1').first.clave;

      repo.falla = false;
      await c.read(subidasDeFotosProvider.notifier).reintentar(clave);

      expect(c.read(subidasDeFotosProvider).deProducto('prd_1'), isEmpty);
      expect(c.read(subidasDeFotosProvider).subidasDe('prd_1').length, 1);
      expect(repo.vecesQueSubio, 2);
    });

    /// Y se puede sacar de ahí.
    test('descartar la quita', () async {
      final c = contenedor();
      repo.falla = true;

      await c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          );
      final clave = c.read(subidasDeFotosProvider).deProducto('prd_1').first.clave;

      c.read(subidasDeFotosProvider.notifier).descartar(clave);

      expect(c.read(subidasDeFotosProvider).deProducto('prd_1'), isEmpty);
    });
  });

  group('Salir del editor', () {
    /// ⛔ LA SUBIDA SOBREVIVE A LA PANTALLA.
    ///
    /// Es la razón de que esto viva en el contenedor de Riverpod y no en el
    /// `State` del editor: un `Future` lanzado desde la pantalla muere con
    /// ella, y la foto se perdería sin que nadie se entere.
    test('⛔ la foto sigue subiendo aunque nadie la esté mirando', () async {
      final c = contenedor();
      final completar = Completer<ImagenProducto>();
      repo.respuesta = completar.future;

      unawaited(c.read(subidasDeFotosProvider.notifier).subir(
            productId: 'prd_1',
            archivo: archivo('foto.jpg'),
          ));
      await Future<void>.delayed(Duration.zero);

      // Acá la persona salió del editor. El servicio sigue vivo.
      completar.complete(_imagen('img_9'));
      await Future<void>.delayed(Duration.zero);

      expect(c.read(subidasDeFotosProvider).subidasDe('prd_1').map((i) => i.id), ['img_9']);
    });
  });

  /// Sacar una foto.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// EL BUG CONFIRMADO EN EL TELÉFONO
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// Tocar la X tardaba ~5 segundos y la foto **no desaparecía**. El segundo
  /// toque respondía «imagen no encontrada». Saliendo del producto y volviendo
  /// a entrar, ya no estaba.
  ///
  /// O sea: el backend y R2 borraban perfecto. Lo que quedaba viejo era la
  /// pantalla — y el segundo toque mandaba un `DELETE` de algo ya borrado.
  group('Borrar una foto', () {
    /// ⛔ EL TEST DEL BUG: la foto se va aunque el servidor no conteste.
    test('⛔ desaparece antes de que el servidor confirme', () async {
      final c = contenedor();
      repo.cuelgaAlBorrar = true;

      unawaited(c.read(subidasDeFotosProvider.notifier).borrarFoto(
            productId: 'prd_1',
            imageId: 'img_1',
          ));
      await Future<void>.delayed(Duration.zero);

      final tira = armarTira(
        delServidor: [_imagen('img_1'), _imagen('img_2')],
        recienSubidas: const [],
        enVuelo: const [],
        borradas: c.read(subidasDeFotosProvider).borradasDe('prd_1'),
      );

      expect(tira.subidas.map((i) => i.id), ['img_2']);
    });

    /// ⛔ EL SEGUNDO TOQUE NO MANDA NADA.
    ///
    /// Era la otra mitad del bug: como la foto seguía a la vista, volver a
    /// tocar la X mandaba un `DELETE` de algo que el servidor ya había borrado,
    /// y de ahí el «imagen no encontrada».
    test('⛔ tocar dos veces manda un solo DELETE', () async {
      final c = contenedor();
      repo.cuelgaAlBorrar = true;
      final n = c.read(subidasDeFotosProvider.notifier);

      unawaited(n.borrarFoto(productId: 'prd_1', imageId: 'img_1'));
      unawaited(n.borrarFoto(productId: 'prd_1', imageId: 'img_1'));
      await Future<void>.delayed(Duration.zero);

      expect(repo.vecesQueBorro, 1);
    });

    /// ⛔ Y si el servidor la rechaza, la foto VUELVE.
    test('⛔ si el DELETE falla, la foto vuelve a la tira', () async {
      final c = contenedor();
      repo.fallaAlBorrar = true;

      await expectLater(
        c.read(subidasDeFotosProvider.notifier).borrarFoto(
              productId: 'prd_1',
              imageId: 'img_1',
            ),
        throwsA(anything),
      );

      expect(c.read(subidasDeFotosProvider).borradasDe('prd_1'), isEmpty);
    });

    /// ⛔ Y DESPUÉS de fallar se puede volver a intentar.
    ///
    /// Si la marca quedara puesta, el segundo intento se frenaría solo y la
    /// foto no se podría sacar nunca más sin reiniciar la app.
    test('⛔ después de fallar, el siguiente intento sí sale', () async {
      final c = contenedor();
      final n = c.read(subidasDeFotosProvider.notifier);
      repo.fallaAlBorrar = true;

      await n.borrarFoto(productId: 'prd_1', imageId: 'img_1').catchError((_) {});
      repo.fallaAlBorrar = false;
      await n.borrarFoto(productId: 'prd_1', imageId: 'img_1');

      expect(repo.vecesQueBorro, 2);
      expect(c.read(subidasDeFotosProvider).borradasDe('prd_1'), {'img_1'});
    });

    /// ⛔ La marca sobrevive a que el servidor confirme.
    ///
    /// Es lo que impide que la foto reaparezca: el editor guarda el producto en
    /// memoria y esa copia sigue teniéndola hasta que vuelva a pedirlo.
    test('⛔ al confirmar, la foto NO vuelve a la tira', () async {
      final c = contenedor();

      await c.read(subidasDeFotosProvider.notifier).borrarFoto(
            productId: 'prd_1',
            imageId: 'img_1',
          );

      final tira = armarTira(
        delServidor: [_imagen('img_1')],
        recienSubidas: const [],
        enVuelo: const [],
        borradas: c.read(subidasDeFotosProvider).borradasDe('prd_1'),
      );

      expect(tira.subidas, isEmpty);
    });

    /// Y al recargar el producto se olvida: ahí ya no viene.
    test('recargar el producto limpia las borradas', () async {
      final c = contenedor();
      final n = c.read(subidasDeFotosProvider.notifier);

      await n.borrarFoto(productId: 'prd_1', imageId: 'img_1');
      n.olvidarSubidas('prd_1');

      expect(c.read(subidasDeFotosProvider).borradasDe('prd_1'), isEmpty);
    });
  });
}

ImagenProducto _imagen(String id) =>
    ImagenProducto(id: id, url: 'https://ejemplo/$id.jpg', position: 0);

FotoEnVuelo _enVuelo(String clave) =>
    FotoEnVuelo(clave: clave, productId: 'prd_1', rutaLocal: '$clave.jpg');

class _RepoDeFotos extends Fake implements SellerRepository {
  int vecesQueSubio = 0;
  int vecesQuePidioElProducto = 0;
  bool cuelga = false;
  bool falla = false;
  Future<ImagenProducto>? respuesta;

  @override
  Future<ImagenProducto> subirImagen(String productId, File archivo) async {
    vecesQueSubio += 1;
    if (cuelga) return Completer<ImagenProducto>().future;
    if (falla) throw ComercioException('no se pudo subir');
    final r = respuesta;
    if (r != null) return r;
    return _imagen('img_$vecesQueSubio');
  }

  int vecesQueBorro = 0;
  bool cuelgaAlBorrar = false;
  bool fallaAlBorrar = false;

  @override
  Future<void> borrarImagen(String productId, String imageId) async {
    vecesQueBorro += 1;
    if (cuelgaAlBorrar) return Completer<void>().future;
    if (fallaAlBorrar) throw ComercioException('no se pudo borrar');
  }

  @override
  Future<Producto> producto(String id) async {
    vecesQuePidioElProducto += 1;
    throw StateError('nadie tiene que pedir el producto para tocar una foto');
  }
}
