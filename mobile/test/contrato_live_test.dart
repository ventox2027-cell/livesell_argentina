import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/seller/domain/schedule_models.dart';

/// El contrato del vivo, la tienda y el vendedor.
///
/// Sigue la línea de `contrato_api_test.dart`: los JSON de acá abajo son las
/// formas que **arma el backend**, copiadas de `live.service.ts` y
/// `stores.service.ts`, no lo que suponemos que devuelve.
///
/// La costura entre las dos mitades ya nos rompió la app dos veces —el `as
/// String` sobre una imagen sin id, y el `content-type` de los DELETE—. Los dos
/// lados estaban bien probados por separado.
void main() {
  group('Detalle de un vivo al aire', () {
    // GET /api/v1/live/:id — `paraEspectador` en live.service.ts
    final json = <String, dynamic>{
      'id': 'lvs_01KZYNRD582N6MV5M4NQKTAAZ4',
      'titulo': 'Velas de soja',
      'portada': 'https://ejemplo.test/media/products/prd_x/a97a709d.jpg',
      'estado': 'LIVE',
      'vendedor': {
        'id': 'sel_01KZYNRCPHT5FEVXTQ1RHXFBWQ',
        'nombre': 'Taller Aroma',
        'identidadVerificada': true,
      },
      'tienda': {'id': 'sto_01KZYNRCPHT5FEVXTQ1RHXFBWQ', 'nombre': 'Aroma Deco'},
      'destacado': {
        'variantId': 'var_01KZYNRDJDE8TEZQ8VJFN4WZDH',
        'productId': 'prd_01KZYNRD582N6MV5M4NQKTAAZ4',
        'nombre': 'Vela lavanda',
        'variante': 'Grande',
        'imagenUrl': 'https://ejemplo.test/media/products/prd_x/a97a709d.jpg',
        'precioCentavos': 990000,
        'disponible': 3,
      },
      'iniciadoEl': '2026-08-14T01:12:00.000Z',
      'terminadoEl': null,
      'video': {
        'token': 'eyJhbGciOi.token.de.livekit',
        'wsUrl': 'wss://livekit.ejemplo.test',
        'sala': 'live_lvs_01KZYNRD582N6MV5M4NQKTAAZ4',
      },
    };

    test('se parsea completo', () {
      final l = DetalleDeLive.fromJson(json);

      expect(l.id, 'lvs_01KZYNRD582N6MV5M4NQKTAAZ4');
      expect(l.estado, 'LIVE');
      expect(l.vendedorNombre, 'Taller Aroma');
      expect(l.identidadVerificada, isTrue);
      expect(l.tiendaNombre, 'Aroma Deco');
      expect(l.destacado!.disponible, 3);
      expect(l.video!.sala, 'live_lvs_01KZYNRD582N6MV5M4NQKTAAZ4');
      expect(l.alAire, isTrue);
      expect(l.terminado, isFalse);
    });

    test('RECONNECTING sigue siendo "al aire": se puede comprar', () {
      final l = DetalleDeLive.fromJson({...json, 'estado': 'RECONNECTING'});

      expect(l.reconectando, isTrue);
      // Que al vendedor se le corte la red no cancela una compra en curso. El
      // backend admite comprar en RECONNECTING y la app tiene que coincidir.
      expect(l.alAire, isTrue);
      expect(l.terminado, isFalse);
    });
  });

  group('Un vivo terminado', () {
    // El mismo endpoint devuelve `video: null` y conserva el resto.
    final json = <String, dynamic>{
      'id': 'lvs_x',
      'titulo': 'Velas de soja',
      'portada': null,
      'estado': 'ENDED',
      'vendedor': {'id': 'sel_x', 'nombre': 'Taller Aroma', 'identidadVerificada': false},
      'tienda': {'id': 'sto_x', 'nombre': 'Aroma Deco'},
      'destacado': {
        'variantId': 'var_x',
        'productId': 'prd_x',
        'nombre': 'Vela lavanda',
        'precioCentavos': 990000,
        'disponible': 3,
      },
      'iniciadoEl': '2026-08-14T01:12:00.000Z',
      'terminadoEl': '2026-08-14T02:00:00.000Z',
      'video': null,
    };

    test('pierde el video pero CONSERVA el contexto comercial', () {
      final l = DetalleDeLive.fromJson(json);

      expect(l.terminado, isTrue);
      expect(l.video, isNull);

      // Lo que sostiene la venta después de que se cortó el video. Sin esto la
      // pantalla quedaría en negro y se perdería el momento de más intención de
      // compra de todo el vivo.
      expect(l.vendedorId, 'sel_x');
      expect(l.tiendaNombre, 'Aroma Deco');
      expect(l.storeId, 'sto_x');
      expect(l.destacado!.nombre, 'Vela lavanda');
      expect(l.terminadoEl, isNotNull);
    });

    test('FAILED también cuenta como terminado', () {
      expect(DetalleDeLive.fromJson({...json, 'estado': 'FAILED'}).terminado, isTrue);
    });
  });

  group('Producto destacado', () {
    test('sin stock conocido no dice que está agotado', () {
      // `disponible: null` es "no sabemos", no "no hay". Tratarlo como cero
      // deshabilitaría el botón de comprar de un producto que sí está.
      final p = ProductoDestacado.fromJson({
        'variantId': 'var_x',
        'productId': 'prd_x',
        'nombre': 'Vela',
      });

      expect(p.disponible, isNull);
      expect(p.agotado, isFalse);
    });

    test('disponible en cero sí está agotado', () {
      final p = ProductoDestacado.fromJson({
        'variantId': 'var_x',
        'productId': 'prd_x',
        'nombre': 'Vela',
        'disponible': 0,
      });

      expect(p.agotado, isTrue);
    });

    test('conDisponible aplica el evento sin perder nada', () {
      final p = ProductoDestacado.fromJson({
        'variantId': 'var_x',
        'productId': 'prd_x',
        'nombre': 'Vela',
        'variante': 'Grande',
        'precioCentavos': 990000,
        'disponible': 5,
      });

      final actualizado = p.conDisponible(1);

      expect(actualizado.disponible, 1);
      expect(actualizado.nombre, 'Vela');
      expect(actualizado.variante, 'Grande');
      expect(actualizado.precioCentavos, 990000);
    });
  });

  group('Perfil del vendedor', () {
    // GET /api/v1/sellers/:id/profile
    final json = <String, dynamic>{
      'id': 'sel_x',
      'nombre': 'Taller Aroma',
      'bio': 'Velas de soja hechas a mano.',
      'avatarUrl': null,
      'identidadVerificada': true,
      'vendedorConfiable': false,
      'seguidores': 1240,
      'rating': 4.7,
      'resenas': 38,
      'ventas': 210,
      'loSigo': false,
      'tienda': {'id': 'sto_x', 'nombre': 'Aroma Deco'},
      'horario': {'abierta': true, 'motivo': 'Abierta hasta las 20:00', 'abreEl': null},
      'enVivo': null,
    };

    test('las dos insignias son campos distintos', () {
      final p = PerfilDeVendedor.fromJson(json);

      /**
       * ⚠️ No se pueden fundir en un solo tilde.
       *
       * "Sabemos quién es" y "tiene historial" son cosas distintas. Este
       * vendedor tiene el documento validado y todavía no llegó a confiable:
       * mostrar un único badge lo haría parecer aprobado en ambas.
       */
      expect(p.identidadVerificada, isTrue);
      expect(p.vendedorConfiable, isFalse);
    });

    test('se parsea completo', () {
      final p = PerfilDeVendedor.fromJson(json);

      expect(p.seguidores, 1240);
      expect(p.rating, 4.7);
      expect(p.resenas, 38);
      expect(p.ventas, 210);
      expect(p.loSigo, isFalse);
      expect(p.storeId, 'sto_x');
      expect(p.horario!.abierta, isTrue);
      expect(p.sinReputacion, isFalse);
    });

    test('sin reseñas el rating es null, no cero', () {
      final p = PerfilDeVendedor.fromJson({
        ...json,
        'rating': null,
        'resenas': 0,
        'ventas': 0,
      });

      // 0,0 ⭐ sobre cero reseñas es matemáticamente falso y hunde a todo el
      // que arranca.
      expect(p.rating, isNull);
      expect(p.sinReputacion, isTrue);
    });

    test('sin sesión no viene loSigo y no se muestra el botón', () {
      final sinSesion = Map<String, dynamic>.from(json)..remove('loSigo');
      expect(PerfilDeVendedor.fromJson(sinSesion).loSigo, isNull);
    });

    test('conFollow toma el contador del servidor, no suma de a uno', () {
      final p = PerfilDeVendedor.fromJson(json);
      final despues = p.conFollow(true, 1241);

      expect(despues.loSigo, isTrue);
      expect(despues.seguidores, 1241);
      // Y no pierde el resto.
      expect(despues.rating, 4.7);
      expect(despues.identidadVerificada, isTrue);
      expect(despues.storeId, 'sto_x');
    });
  });

  group('Catálogo de la tienda', () {
    // GET /api/v1/stores/:id/catalog
    test('se parsea con su cursor', () {
      final pagina = PaginaDeCatalogo.fromJson({
        'items': [
          {
            'id': 'prd_x',
            'nombre': 'Vela lavanda',
            'imagenUrl': 'https://ejemplo.test/media/products/prd_x/a.jpg',
            'precioCentavos': 990000,
            'disponible': 4,
            'variantes': 3,
          },
          {
            'id': 'prd_y',
            'nombre': 'Vela sin foto',
            'imagenUrl': null,
            'precioCentavos': 450000,
            'disponible': 0,
            'variantes': 1,
          },
        ],
        'siguienteCursor': 'prd_y',
      });

      expect(pagina.items, hasLength(2));
      expect(pagina.items.first.variantes, 3);
      // El que nos rompió la app la primera vez: producto sin foto.
      expect(pagina.items.last.imagenUrl, isNull);
      expect(pagina.items.last.agotado, isTrue);
      expect(pagina.siguienteCursor, 'prd_y');
    });

    test('última página: sin cursor', () {
      final pagina = PaginaDeCatalogo.fromJson({'items': <dynamic>[]});
      expect(pagina.items, isEmpty);
      expect(pagina.siguienteCursor, isNull);
    });
  });

  /**
   * GET /api/v1/catalog/products/:id
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ESTE GRUPO ESTABA ESCRITO CONTRA UN JSON INVENTADO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Y por eso pasó en verde mientras la pantalla de variantes estaba rota para
   * cualquier comprador real.
   *
   * La app pedía `GET /products/:id`, que es el endpoint del VENDEDOR: resuelve
   * por dueño y contesta `SELLER_NOT_FOUND` a quien no tiene tienda. El test no
   * lo vio porque el JSON de acá abajo lo había escrito yo a mano, con la forma
   * que suponía. La cabecera de `contrato_api_test.dart` ya lo advertía: **los
   * JSON tienen que ser respuestas reales, copiadas tal cual**.
   *
   * El de abajo lo es: sale de `curl` contra el backend corriendo.
   */
  group('Producto con variantes', () {
    // Respuesta REAL, copiada de curl. Producto sin opciones, una sola variante.
    final real = <String, dynamic>{
      'id': 'prd_01KZZW0TPRV8AR3N065Q47RSVF',
      'nombre': 'Campera de lana',
      'descripcion': null,
      'precioCentavos': 4500000,
      'moneda': 'ARS',
      'imagenes': <dynamic>[],
      'ejes': <dynamic>[],
      'variantes': [
        {
          'id': 'var_01KZZW0TPV7NE42V3YQ1WD35DG',
          'titulo': 'Default',
          'precioCentavos': 4500000,
          'disponible': 3,
          'valoresDeOpcion': <dynamic>[],
        },
      ],
    };

    test('la respuesta real se parsea, y el precio NO es cero', () {
      final p = DetalleDeProducto.fromJson(real);

      // El síntoma exacto del defecto: la hoja mostraba "$ 0,00" y "Esa
      // combinación no existe" porque estaba parseando un cuerpo de error.
      expect(p.nombre, 'Campera de lana');
      expect(p.precioBaseCentavos, 4500000);
      expect(p.variantes, hasLength(1));
      expect(p.variantes.first.disponible, 3);
    });

    test('sin ejes, la única variante se resuelve sola', () {
      final p = DetalleDeProducto.fromJson(real);

      // Es lo que habilita "Comprar" de una: un producto sin talles no tiene
      // nada que elegir.
      expect(p.variantePara({}), isNotNull);
      expect(p.variantePara({})!.id, 'var_01KZZW0TPV7NE42V3YQ1WD35DG');
    });

    test('⛔ un cuerpo de error NO se parsea como producto vendible', () {
      /**
       * `ApiClient` no lanza con 4xx: usa `validateStatus: s < 500` para poder
       * reintentar tras refrescar el token. Así que el cuerpo del error llega
       * hasta acá, y la lectura defensiva lo convierte en un producto vacío.
       *
       * No se puede evitar que se parsee —es la misma tolerancia que sostiene
       * el resto del archivo— pero sí se puede exigir que el resultado sea
       * *inservible* de forma evidente: sin variantes, `variantePara` devuelve
       * null y el botón queda deshabilitado en vez de ofrecer algo a $0,00.
       */
      final p = DetalleDeProducto.fromJson({
        'error': {'code': 'SELLER_NOT_FOUND', 'message': 'Todavía no tenés un perfil de vendedor'},
      });

      expect(p.variantes, isEmpty);
      expect(p.variantePara({}), isNull);
    });

    // Producto con dos ejes, con la MISMA forma que arma `detalleParaComprar`.
    final json = <String, dynamic>{
      'id': 'prd_x',
      'nombre': 'Remera lisa',
      'descripcion': 'Algodón peinado.',
      'precioCentavos': 1500000,
      'moneda': 'ARS',
      'imagenes': ['https://ejemplo.test/media/products/prd_x/a.jpg'],
      'ejes': [
        {
          'id': 'opt_talle',
          'nombre': 'Talle',
          'valores': [
            {'id': 'ov_s', 'valor': 'S'},
            {'id': 'ov_m', 'valor': 'M'},
          ],
        },
        {
          'id': 'opt_color',
          'nombre': 'Color',
          'valores': [
            {'id': 'ov_negro', 'valor': 'Negro'},
            {'id': 'ov_blanco', 'valor': 'Blanco'},
          ],
        },
      ],
      'variantes': [
        {
          'id': 'var_s_negro',
          'titulo': 'S / Negro',
          'precioCentavos': 1500000,
          'disponible': 4,
          'valoresDeOpcion': ['ov_s', 'ov_negro'],
        },
        {
          'id': 'var_m_negro',
          'titulo': 'M / Negro',
          'precioCentavos': 1800000,
          'disponible': 0,
          'valoresDeOpcion': ['ov_m', 'ov_negro'],
        },
        {
          'id': 'var_m_blanco',
          'titulo': 'M / Blanco',
          'precioCentavos': 1500000,
          'disponible': 3,
          'valoresDeOpcion': ['ov_m', 'ov_blanco'],
        },
      ],
    };

    test('aplana el árbol en ejes y variantes', () {
      final p = DetalleDeProducto.fromJson(json);

      expect(p.ejes, hasLength(2));
      expect(p.ejes.first.nombre, 'Talle');
      expect(p.ejes.first.valores.map((v) => v.valor), ['S', 'M']);
      expect(p.variantes, hasLength(3));
      expect(p.imagenUrl, isNotNull);
    });

    test('el disponible viene del servidor, no se calcula acá', () {
      final p = DetalleDeProducto.fromJson(json);

      // Antes la app hacía `onHand - reserved`. Ahora lo manda el backend, y de
      // paso esos dos números internos del vendedor no viajan a quien compra.
      expect(p.variantes.firstWhere((v) => v.id == 'var_s_negro').disponible, 4);
      expect(p.variantes.firstWhere((v) => v.id == 'var_m_negro').disponible, 0);
      expect(p.variantes.firstWhere((v) => v.id == 'var_m_negro').agotada, isTrue);
    });

    test('cada variante trae su propio precio ya resuelto', () {
      final p = DetalleDeProducto.fromJson(json);

      expect(p.variantes.firstWhere((v) => v.id == 'var_s_negro').precioCentavos, 1500000);
      expect(p.variantes.firstWhere((v) => v.id == 'var_m_negro').precioCentavos, 1800000);
    });

    test('variantePara resuelve la combinación elegida', () {
      final p = DetalleDeProducto.fromJson(json);

      expect(p.variantePara({'ov_s', 'ov_negro'})!.id, 'var_s_negro');
      expect(p.variantePara({'ov_m', 'ov_blanco'})!.id, 'var_m_blanco');
    });

    test('una combinación a medias todavía no resuelve nada', () {
      final p = DetalleDeProducto.fromJson(json);
      expect(p.variantePara({'ov_m'}), isNull);
    });

    test('una combinación que no existe devuelve null, no una variante al azar', () {
      final p = DetalleDeProducto.fromJson(json);
      // No hay S en blanco: el vendedor nunca la cargó. Distinto de agotada.
      expect(p.variantePara({'ov_s', 'ov_blanco'}), isNull);
    });

    group('valorTieneStock', () {
      test('sin nada elegido, mira todas las variantes de ese valor', () {
        final p = DetalleDeProducto.fromJson(json);

        expect(p.valorTieneStock('ov_s', {}), isTrue);
        // M existe en negro (agotado) y en blanco (3): hay stock.
        expect(p.valorTieneStock('ov_m', {}), isTrue);
      });

      test('con un eje ya elegido, se restringe a esa combinación', () {
        final p = DetalleDeProducto.fromJson(json);

        // Elegido "Negro": M/Negro está agotado, así que M no se puede tocar.
        expect(p.valorTieneStock('ov_m', {'ov_negro'}), isFalse);
        expect(p.valorTieneStock('ov_s', {'ov_negro'}), isTrue);

        // Elegido "Blanco": S/Blanco ni siquiera existe.
        expect(p.valorTieneStock('ov_s', {'ov_blanco'}), isFalse);
        expect(p.valorTieneStock('ov_m', {'ov_blanco'}), isTrue);
      });
    });

    test('un producto sin ejes usa su única variante', () {
      final p = DetalleDeProducto.fromJson({
        'id': 'prd_simple',
        'nombre': 'Vela',
        'precioCentavos': 990000,
        'imagenes': <dynamic>[],
        'ejes': <dynamic>[],
        'variantes': [
          {
            'id': 'var_unica',
            'titulo': 'Única',
            'precioCentavos': 990000,
            'disponible': 7,
            'valoresDeOpcion': <dynamic>[],
          },
        ],
      });

      expect(p.variantePara({})!.id, 'var_unica');
      expect(p.variantePara({})!.disponible, 7);
    });
  });

  group('Estado de la tienda', () {
    test('cerrada trae el motivo', () {
      final e = EstadoDeTienda.fromJson({
        'abierta': false,
        'motivo': 'Abre el lunes a las 09:00',
        'abreEl': '2026-08-17T12:00:00.000Z',
      });

      expect(e.abierta, isFalse);
      expect(e.motivo, 'Abre el lunes a las 09:00');
      expect(e.abreEl, isNotNull);
    });

    test('una respuesta incompleta se asume abierta', () {
      // Mostrar "cerrada" por un campo que faltó frena una venta que el backend
      // habría aceptado. Al revés no pasa nada: el backend rechaza igual.
      expect(EstadoDeTienda.fromJson(<String, dynamic>{}).abierta, isTrue);
    });
  });

  group('Horario propio del vendedor', () {
    // GET /api/v1/stores/me/schedule
    final json = <String, dynamic>{
      'modo': 'SCHEDULED',
      'zona': 'America/Argentina/Buenos_Aires',
      'franjas': [
        {'dia': 1, 'abre': '09:00', 'cierra': '18:00', 'abreMinutos': 540, 'cierraMinutos': 1080},
        {'dia': 5, 'abre': '22:00', 'cierra': '02:00', 'abreMinutos': 1320, 'cierraMinutos': 120},
      ],
      'estadoActual': {'abierta': true, 'motivo': 'Abierta hasta las 18:00', 'abreEl': null},
    };

    test('se parsea con su estado actual', () {
      final h = HorarioDeTienda.fromJson(json);

      expect(h.modo, ModoDeApertura.scheduled);
      expect(h.zona, 'America/Argentina/Buenos_Aires');
      expect(h.franjas, hasLength(2));
      expect(h.abiertaAhora, isTrue);
      expect(h.motivo, 'Abierta hasta las 18:00');
    });

    test('una franja que cierra antes de abrir cruza la medianoche', () {
      final h = HorarioDeTienda.fromJson(json);

      final viernes = h.franjas.firstWhere((f) => f.dia == 5);
      // 22:00 a 02:00 no es un error de carga: es un vivo de noche.
      expect(viernes.cruzaMedianoche, isTrue);
      expect(h.franjas.first.cruzaMedianoche, isFalse);
    });

    test('un modo desconocido se lee como siempre abierta', () {
      // Un valor que la app no reconoce no puede terminar cerrando una tienda
      // que su dueño dejó abierta.
      expect(
        HorarioDeTienda.fromJson({'modo': 'MODO_QUE_NO_EXISTE'}).modo,
        ModoDeApertura.alwaysOpen,
      );
    });

    test('el nombre del modo es el que espera el backend', () {
      expect(ModoDeApertura.alwaysOpen.name, 'ALWAYS_OPEN');
      expect(ModoDeApertura.scheduled.name, 'SCHEDULED');
      expect(ModoDeApertura.liveOnly.name, 'LIVE_ONLY');
    });

    test('comoHora rellena con cero a la izquierda', () {
      expect(comoHora(540), '09:00');
      expect(comoHora(1080), '18:00');
      expect(comoHora(0), '00:00');
      expect(comoHora(1439), '23:59');
      expect(comoHora(125), '02:05');
    });
  });
}
