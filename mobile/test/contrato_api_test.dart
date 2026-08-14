import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/feed/domain/feed_models.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';
import 'package:vendox/features/seller/domain/seller_models.dart';

/// El contrato entre el backend y la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ EXISTE ESTE ARCHIVO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La lista de productos del vendedor se caía entera con:
///
///     type 'Null' is not a subtype of type 'String' in type cast
///
/// La causa: los endpoints de listado mandaban sólo `url` en cada imagen —
/// alcanza para dibujar la portada— y el modelo hacía `j['id'] as String`.
///
/// Y sólo pasaba cuando un producto TENÍA foto, así que sobrevivió a 366 tests
/// de backend, a `flutter analyze` limpio y a varias pruebas en el teléfono.
/// Lo encontró el usuario.
///
/// Es la segunda vez que un defecto vive **en la costura** entre las dos
/// mitades: la primera fue el `content-type` de los DELETE. Los dos lados
/// estaban bien probados por separado y nadie probaba el medio.
///
/// Estos tests son ese medio. Los JSON de acá abajo son **respuestas reales**
/// del servidor, copiadas tal cual, no lo que suponemos que devuelve.
void main() {
  group('Producto en el listado del vendedor', () {
    // Copiado de GET /api/v1/products/mine
    final json = {
      'id': 'prd_01KZYNRD582N6MV5M4NQKTAAZ4',
      'storeId': 'sto_01KZYNRCPHT5FEVXTQ1RHXFBWQ',
      'categoryId': null,
      'name': 'Con foto',
      'slug': 'con-foto',
      'description': null,
      'status': 'ACTIVE',
      'currency': 'ARS',
      'basePriceCents': 990000,
      'compareAtPriceCents': null,
      'createdAt': '2026-08-13T22:12:00.000Z',
      'updatedAt': '2026-08-13T22:12:00.000Z',
      'images': [
        {
          'id': 'img_01KZYNRDJDE8TEZQ8VJFN4WZDH',
          'url': 'https://ejemplo.test/media/products/prd_x/a97a709d.jpg',
          'position': 0,
        },
      ],
      '_count': {'variants': 1},
    };

    test('se parsea completo', () {
      final p = Producto.fromJson(json);

      expect(p.id, 'prd_01KZYNRD582N6MV5M4NQKTAAZ4');
      expect(p.name, 'Con foto');
      expect(p.basePriceCents, 990000);
      expect(p.publicado, isTrue);
      expect(p.cantidadVariantes, 1);
      expect(p.portada, isNotNull);
      expect(p.images.single.id, 'img_01KZYNRDJDE8TEZQ8VJFN4WZDH');
    });

    test('⛔ una imagen SIN id no tumba la pantalla', () {
      /**
       * Este es el test de la regresión.
       *
       * El contrato del backend ya se unificó, pero la app vive en teléfonos
       * que no se actualizan al mismo tiempo que el servidor. Un campo que
       * falta tiene que degradar lo que se muestra, nunca hacer estallar la
       * lista completa.
       */
      final parcial = {
        ...json,
        'images': [
          {'url': 'https://ejemplo.test/foto.jpg'},
        ],
      };

      final p = Producto.fromJson(parcial);

      expect(p.portada, 'https://ejemplo.test/foto.jpg');
      expect(p.images.single.esManipulable, isFalse);
    });

    test('sin fotos no rompe', () {
      final p = Producto.fromJson({...json, 'images': <dynamic>[]});
      expect(p.portada, isNull);
      expect(p.images, isEmpty);
    });

    test('los campos opcionales pueden faltar por completo', () {
      // Un backend más viejo, o una proyección más chica.
      final p = Producto.fromJson({
        'id': 'prd_x',
        'name': 'Mínimo',
        'basePriceCents': 100,
      });

      expect(p.id, 'prd_x');
      expect(p.esBorrador, isTrue);
      expect(p.variants, isEmpty);
      expect(p.portada, isNull);
    });
  });

  group('Publicación del feed', () {
    // Copiado de GET /api/v1/discover/products
    final json = {
      'id': 'prd_01KZXRRDFXSMK9210J4PTK7JMT',
      'name': 'Vela aromática',
      'slug': 'vela-aromatica',
      'description': 'Cera de soja',
      'basePriceCents': 890000,
      'compareAtPriceCents': 1200000,
      'images': [
        {'id': 'img_x', 'url': 'https://ejemplo.test/vela.jpg', 'position': 0},
      ],
      'store': {
        'id': 'sto_x',
        'name': 'Velas del Sur',
        'slug': 'velas-del-sur',
        'logoUrl': null,
        'seller': {
          'id': 'sel_x',
          'displayName': 'Velas del Sur',
          'slug': 'velas-del-sur',
          'avatarUrl': null,
          'verificationStatus': 'UNVERIFIED',
        },
      },
      'variants': [
        {
          'id': 'var_01KZXRRDG1MQ59SM72R6J6R0B6',
          'title': 'Default',
          'priceOverrideCents': null,
          'isDefault': true,
          'priceCents': 890000,
          'availability': 'LOW_STOCK',
          'remaining': 2,
        },
      ],
      '_count': {'variants': 1},
    };

    test('se parsea completo, con la variante para comprar', () {
      final p = PublicacionFeed.fromJson(json);

      expect(p.nombre, 'Vela aromática');
      expect(p.vendedor, 'Velas del Sur');
      expect(p.variantePorDefectoId, 'var_01KZXRRDG1MQ59SM72R6J6R0B6');
      expect(p.sePuedeComprar, isTrue);
      expect(p.disponibilidad!.quedanPocas, isTrue);
      expect(p.disponibilidad!.etiqueta, 'Últimas 2');
    });

    test('trae los ids del vendedor y de la tienda', () {
      /**
       * Venían en la respuesta y el modelo los tiraba.
       *
       * Sin ellos el feed sólo tenía el NOMBRE del vendedor: no podía abrir su
       * perfil ni seguirlo de verdad. Por eso el botón "Seguir" del feed era un
       * booleano local que se olvidaba al cerrar la app — la persona creía que
       * iba a recibir avisos de los vivos y no iba a recibir ninguno.
       */
      final p = PublicacionFeed.fromJson(json);

      expect(p.vendedorId, 'sel_x');
      expect(p.storeId, 'sto_x');
    });

    test('sin tienda en la respuesta, los ids quedan vacíos y no rompe', () {
      // La fila del vendedor deja de ser tocable en vez de abrir un perfil en
      // blanco. Es el mismo criterio defensivo que el resto del archivo.
      final sinTienda = Map<String, dynamic>.from(json)..remove('store');
      final p = PublicacionFeed.fromJson(sinTienda);

      expect(p.vendedorId, '');
      expect(p.storeId, '');
      expect(p.vendedor, 'Vendedor');
    });

    test('agotado: aparece igual, pero no se puede comprar', () {
      // El producto NO desaparece del feed. Se muestra con el botón apagado:
      // esconderlo le sacaría al vendedor la prueba de que hubo demanda.
      final agotado = {
        ...json,
        'variants': [
          {...(json['variants']! as List).first as Map<String, dynamic>,
            'availability': 'OUT_OF_STOCK',
            'remaining': null},
        ],
      };

      final p = PublicacionFeed.fromJson(agotado);

      expect(p.disponibilidad!.hay, isFalse);
      expect(p.sePuedeComprar, isFalse);
      expect(p.disponibilidad!.etiqueta, 'Agotado');
    });

    test('sin variantes no se puede comprar y no revienta', () {
      final p = PublicacionFeed.fromJson({...json, 'variants': <dynamic>[]});

      expect(p.variantePorDefectoId, isNull);
      expect(p.sePuedeComprar, isFalse);
      expect(p.nombre, 'Vela aromática');
    });

    test('el descuento se calcula sólo si se nota', () {
      final p = PublicacionFeed.fromJson(json);
      expect(p.descuento, 26); // 12000 → 8900

      // Por debajo del 5 % no se muestra: un "-2 % OFF" resta credibilidad.
      final chico = PublicacionFeed.fromJson({
        ...json,
        'basePriceCents': 990000,
        'compareAtPriceCents': 1000000,
      });
      expect(chico.descuento, isNull);
    });
  });

  group('Reserva', () {
    // Copiado de POST /api/v1/inventory/reservations
    final json = {
      'reservationId': 'rsv_01KZXT9CWZ62RY3H4V761R9GS8',
      'status': 'ACTIVE',
      'productVariantId': 'var_x',
      'quantity': 1,
      'expiresAt': DateTime.now().add(const Duration(minutes: 5)).toIso8601String(),
      'remainingSeconds': 300,
      'reused': false,
    };

    test('se parsea y el contador arranca del servidor', () {
      final r = Reserva.fromJson(json);

      expect(r.activa, isTrue);
      expect(r.remainingSeconds, 300);
      expect(r.segundosRestantes(), greaterThan(290));
    });

    test('una reserva ya vencida da cero, nunca negativo', () {
      // Al volver del segundo plano se recalcula contra `expiresAt`. Si el
      // servidor ya la venció, el contador tiene que decir 00:00 y no un
      // número negativo.
      final vencida = Reserva.fromJson({
        ...json,
        'expiresAt': DateTime.now().subtract(const Duration(minutes: 1)).toIso8601String(),
      });

      expect(vencida.segundosRestantes(), 0);
    });

    test('el formato del contador', () {
      expect(Reserva.formatearCuenta(299), '04:59');
      expect(Reserva.formatearCuenta(60), '01:00');
      expect(Reserva.formatearCuenta(5), '00:05');
      expect(Reserva.formatearCuenta(0), '00:00');
    });
  });

  group('Stock del vendedor', () {
    // Copiado de GET /api/v1/products/:id/inventory
    final json = {
      'productId': 'prd_x',
      'variants': [
        {
          'variantId': 'var_a',
          'title': 'Negro / S',
          'status': 'ACTIVE',
          'isDefault': false,
          'inventoryId': 'inv_a',
          'onHand': 10,
          'reserved': 2,
          'available': 8,
          'lowStockThreshold': null,
        },
        {
          'variantId': 'var_b',
          'title': 'Negro / M',
          'status': 'ACTIVE',
          'isDefault': false,
          'inventoryId': 'inv_b',
          'onHand': 0,
          'reserved': 0,
          'available': 0,
          'lowStockThreshold': null,
        },
      ],
    };

    test('suma los totales de todas las variantes', () {
      final s = StockProducto.fromJson(json);

      expect(s.totalOnHand, 10);
      expect(s.totalReservado, 2);
      expect(s.totalDisponible, 8);
      expect(s.esSimple, isFalse);
    });

    test('un producto simple se reconoce por su variante DEFAULT', () {
      final s = StockProducto.fromJson({
        'productId': 'prd_y',
        'variants': [
          {
            'variantId': 'var_d',
            'title': 'Default',
            'isDefault': true,
            'onHand': 5,
            'reserved': 0,
            'available': 5,
          },
        ],
      });

      expect(s.esSimple, isTrue);
      expect(s.variants.single.agotada, isFalse);
    });

    test('una variante sin fila de inventario se muestra en cero', () {
      // No se omite de la lista: si desapareciera, el vendedor no tendría
      // forma de cargarle stock.
      final s = StockProducto.fromJson({
        'productId': 'prd_z',
        'variants': [
          {
            'variantId': 'var_sin',
            'title': 'Sin inventario',
            'inventoryId': null,
            'onHand': 0,
            'reserved': 0,
            'available': 0,
          },
        ],
      });

      expect(s.variants.single.inventoryId, isNull);
      expect(s.variants.single.agotada, isTrue);
    });
  });

  group('Dinero', () {
    test('formato argentino: punto para miles, coma para decimales', () {
      // Un precio escrito como si fuera de otro país genera desconfianza justo
      // en el momento de comprar.
      expect(formatearPesos(1250050), r'$ 12.500,50');
      expect(formatearPesos(100), r'$ 1,00');
      expect(formatearPesos(0), r'$ 0,00');
      expect(formatearPesos(123456789), r'$ 1.234.567,89');
    });

    test('acepta lo que la gente realmente escribe', () {
      expect(parsearPesos('12500'), 1250000);
      expect(parsearPesos('12.500'), 1250000);
      expect(parsearPesos('12.500,50'), 1250050);
      expect(parsearPesos(r'$ 12.500,50'), 1250050);
      expect(parsearPesos('  8900  '), 890000);
    });

    test('devuelve null en vez de adivinar', () {
      // Es preferible pedir que corrija a guardar un precio equivocado.
      expect(parsearPesos(''), isNull);
      expect(parsearPesos('abc'), isNull);
      expect(parsearPesos('1,2,3'), isNull);
    });
  });
}
