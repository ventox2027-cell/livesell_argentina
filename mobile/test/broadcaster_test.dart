import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/lives/domain/broadcaster_models.dart';

/// El contrato del lado que transmite.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LOS JSON DE ACÁ SON RESPUESTAS REALES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Copiados de la forma que arma `live.service.ts`, no inventados. Ya nos costó
/// una pantalla entera escribir un test contra un JSON supuesto: la hoja de
/// variantes pasaba en verde mientras mostraba "$ 0,00" en un teléfono real
/// porque el modelo leía un endpoint que le contestaba `SELLER_NOT_FOUND`.
void main() {
  group('Panel del vivo', () {
    // GET /api/v1/live/:id/panel
    final json = <String, dynamic>{
      'id': 'liv_01M003AS3BPNEEBWS61NETGZM8',
      'titulo': 'Camperas de lana',
      'estado': 'LIVE',
      'iniciadoEl': '2026-08-14T10:09:34.681Z',
      'duracionSegundos': 725,
      'espectadores': 12,
      'espectadoresPico': 18,
      'destacadoVariantId': 'var_negro_m',
      'ventas': {'ordenes': 3, 'brutoCentavos': 13500000, 'unidades': 4},
      'bandeja': [
        {
          'productId': 'prd_campera',
          'nombre': 'Campera de lana',
          'imagenUrl': null,
          'posicion': 0,
          'vecesDestacado': 2,
          'vendible': true,
          'variantes': [
            {'id': 'var_negro_s', 'etiqueta': 'S / Negro', 'precioCentavos': 4500000, 'disponible': 0},
            {'id': 'var_negro_m', 'etiqueta': 'M / Negro', 'precioCentavos': 4500000, 'disponible': 3},
          ],
        },
        {
          'productId': 'prd_pausado',
          'nombre': 'Producto pausado',
          'imagenUrl': null,
          'posicion': 1,
          'vecesDestacado': 0,
          'vendible': false,
          'variantes': <dynamic>[],
        },
      ],
    };

    test('se parsea completo', () {
      final p = PanelDelVivo.fromJson(json);

      expect(p.estado, 'LIVE');
      expect(p.alAire, isTrue);
      expect(p.espectadores, 12);
      expect(p.espectadoresPico, 18);
      expect(p.ventas.ordenes, 3);
      expect(p.ventas.unidades, 4);
      expect(p.bandeja, hasLength(2));
    });

    test('la bandeja conserva el orden que preparó el vendedor', () {
      final p = PanelDelVivo.fromJson(json);
      expect(p.bandeja.map((b) => b.productId), ['prd_campera', 'prd_pausado']);
    });

    test('un producto pausado sigue en la bandeja pero no es vendible', () {
      // Sacarlo de la lista dejaría al vendedor sin entender por qué desapareció
      // algo que él mismo preparó.
      final p = PanelDelVivo.fromJson(json);
      final pausado = p.bandeja.firstWhere((b) => b.productId == 'prd_pausado');

      expect(pausado.vendible, isFalse);
    });

    test('destacar elige la primera variante CON stock', () {
      final p = PanelDelVivo.fromJson(json);
      final campera = p.bandeja.first;

      // La S está agotada; tocar el producto tiene que mostrar la M.
      expect(campera.variantePorDefecto!.id, 'var_negro_m');
    });

    test('si están todas agotadas, igual se puede destacar', () {
      // Para poder mostrarla y decir "se agotó" en vez de no poder tocarla.
      final p = PanelDelVivo.fromJson({
        ...json,
        'bandeja': [
          {
            'productId': 'prd_x',
            'nombre': 'Agotado',
            'vendible': true,
            'variantes': [
              {'id': 'var_a', 'etiqueta': 'S', 'precioCentavos': 1000, 'disponible': 0},
            ],
          },
        ],
      });

      final producto = p.bandeja.first;
      expect(producto.agotado, isTrue);
      expect(producto.variantePorDefecto!.id, 'var_a');
    });

    test('el disponible total suma las variantes', () {
      final p = PanelDelVivo.fromJson(json);
      expect(p.bandeja.first.disponibleTotal, 3);
    });

    test('un panel sin bandeja no rompe', () {
      final p = PanelDelVivo.fromJson({'id': 'liv_x', 'estado': 'LIVE'});

      expect(p.bandeja, isEmpty);
      expect(p.ventas.ordenes, 0);
      expect(p.espectadoresPico, isNull);
    });
  });

  group('Vivo preparado', () {
    // POST /api/v1/live
    final json = <String, dynamic>{
      'id': 'liv_x',
      'titulo': 'Prueba',
      'estado': 'SCHEDULED',
      'productos': ['prd_1', 'prd_2'],
      'destacado': null,
      'video': {
        'token': 'eyJhbGciOi.token.de.livekit',
        'wsUrl': 'wss://ventox.livekit.cloud',
        'sala': 'live-liv_x',
        'venceEl': '2026-08-14T18:18:16.907Z',
      },
    };

    test('trae la credencial de video para publicar', () {
      final v = VivoPreparado.fromJson(json);

      expect(v.estado, 'SCHEDULED');
      expect(v.productos, ['prd_1', 'prd_2']);
      expect(v.puedeConectar, isTrue);
    });

    test('⛔ sin token no se intenta conectar', () {
      // Conectar con credencial vacía da un error opaco de LiveKit. Mejor
      // detectarlo y decir "no pudimos preparar la transmisión".
      final v = VivoPreparado.fromJson({...json, 'video': <String, dynamic>{}});
      expect(v.puedeConectar, isFalse);
    });
  });

  group('Mi vivo abierto', () {
    test('null cuando no hay ninguno', () {
      expect(MiVivoAbierto.fromJson({'vivo': null}), isNull);
    });

    test('un vivo preparado todavía no está al aire', () {
      // El botón tiene que decir "Volver a tu vivo" igual: existe y hay que
      // retomarlo, aunque la cámara nunca se haya publicado.
      final v = MiVivoAbierto.fromJson({
        'vivo': {'id': 'liv_x', 'titulo': 'Sin empezar', 'estado': 'SCHEDULED'},
      });

      expect(v, isNotNull);
      expect(v!.alAire, isFalse);
    });

    test('LIVE y RECONNECTING cuentan como al aire', () {
      for (final estado in ['LIVE', 'RECONNECTING']) {
        final v = MiVivoAbierto.fromJson({
          'vivo': {'id': 'liv_x', 'titulo': 'x', 'estado': estado},
        });
        expect(v!.alAire, isTrue, reason: estado);
      }
    });
  });

  group('Resumen final', () {
    test('el pico sin medir es null, no cero', () {
      // Cero diría "no miró nadie", que es una afirmación distinta. La regla
      // del proyecto es no inventar métricas.
      final r = ResumenDelVivo.fromJson({
        'ok': true,
        'resumen': {
          'duracionSegundos': 668,
          'espectadoresPico': null,
          'ordenes': 0,
          'unidades': 0,
          'brutoCentavos': 0,
        },
      });

      expect(r.espectadoresPico, isNull);
      expect(r.huboVentas, isFalse);
      expect(r.duracionSegundos, 668);
    });

    test('con ventas trae unidades y bruto', () {
      final r = ResumenDelVivo.fromJson({
        'resumen': {
          'duracionSegundos': 1800,
          'espectadoresPico': 47,
          'ordenes': 5,
          'unidades': 7,
          'brutoCentavos': 22500000,
        },
      });

      expect(r.huboVentas, isTrue);
      expect(r.unidades, 7);
      expect(r.espectadoresPico, 47);
    });
  });

  group('Duración', () {
    test('bajo la hora es MM:SS', () {
      expect(comoDuracion(0), '00:00');
      expect(comoDuracion(59), '00:59');
      expect(comoDuracion(725), '12:05');
    });

    test('pasada la hora agrega las horas', () {
      expect(comoDuracion(3600), '1:00:00');
      expect(comoDuracion(7325), '2:02:05');
    });

    test('un valor negativo no produce un reloj al revés', () {
      // El reloj corre local y se sincroniza con el servidor; un desfasaje no
      // puede mostrar "-1:-3".
      expect(comoDuracion(-10), '00:00');
    });
  });
}
