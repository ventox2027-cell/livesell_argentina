import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/core/enlaces/destino.dart';
import 'package:vendox/core/enlaces/navegador_de_enlaces.dart';

/// A dónde lleva un enlace.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE RECONOCE NO VA AL FEED
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la regla que ordena el archivo entero. Una ruta desconocida, un enlace
/// viejo, un id con basura: en todos los casos la respuesta es `null` o
/// [DestinoWeb], nunca el feed.
///
/// Mandar al feed «por las dudas» es peor que no hacer nada. La persona tocó un
/// enlace esperando algo concreto —un producto, un vivo— y termina en una
/// pantalla que no pidió, sin entender qué pasó y sin forma de volver.
///
/// Y el mismo resolutor lo usan los dos caminos: el enlace de WhatsApp y el
/// toque en un aviso push. Con dos, el mismo producto abriría pantallas
/// distintas según de dónde vino.

Destino? porUrl(String url) => resolverEnlace(Uri.parse(url));

void main() {
  // `GlobalKey.currentState` toca el binding de Flutter, y en un `test()`
  // pelado no existe.
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Las cuatro rutas de la app', () {
    test('producto', () {
      expect(
        porUrl('https://vendox.com.ar/p/prd_01M02SMF4EJ7KG5RYZV96CR52J'),
        const DestinoEnApp(TipoDeDestino.producto, 'prd_01M02SMF4EJ7KG5RYZV96CR52J'),
      );
    });

    test('vivo', () {
      expect(
        porUrl('https://vendox.com.ar/v/liv_abc123'),
        const DestinoEnApp(TipoDeDestino.vivo, 'liv_abc123'),
      );
    });

    test('tienda', () {
      // Las tiendas van por slug, no por id.
      expect(
        porUrl('https://vendox.com.ar/t/tienda-de-lana'),
        const DestinoEnApp(TipoDeDestino.tienda, 'tienda-de-lana'),
      );
    });

    test('vendedor', () {
      expect(
        porUrl('https://vendox.com.ar/u/ana-tejidos'),
        const DestinoEnApp(TipoDeDestino.vendedor, 'ana-tejidos'),
      );
    });

    test('una barra final no cambia nada', () {
      // Los enlaces compartidos la traen la mitad de las veces.
      expect(
        porUrl('https://vendox.com.ar/p/prd_1/'),
        const DestinoEnApp(TipoDeDestino.producto, 'prd_1'),
      );
    });

    test('los parámetros de seguimiento se ignoran', () {
      /**
       * Un enlace pegado desde una campaña trae `?utm_source=...`. Si el id
       * saliera con la cadena de consulta pegada, la pantalla pediría un
       * producto que no existe.
       */
      expect(
        porUrl('https://vendox.com.ar/p/prd_1?utm_source=wpp&utm_campaign=x'),
        const DestinoEnApp(TipoDeDestino.producto, 'prd_1'),
      );
    });
  });

  group('Las páginas web se quedan en la web', () {
    test('privacidad', () {
      /**
       * Google Play exige que esa URL exista y sea alcanzable. Abrirla dentro
       * de la app, sin barra de direcciones, hace imposible comprobar que el
       * texto es el nuestro — y es justo lo que alguien va a querer verificar.
       */
      final d = porUrl('https://vendox.com.ar/privacidad');
      expect(d, isA<DestinoWeb>());
      expect((d! as DestinoWeb).url, contains('/privacidad'));
    });

    test('eliminar-cuenta', () {
      expect(porUrl('https://vendox.com.ar/eliminar-cuenta'), isA<DestinoWeb>());
    });

    test('⛔ ninguna de las dos abre una pantalla de la app', () {
      for (final url in [
        'https://vendox.com.ar/privacidad',
        'https://vendox.com.ar/eliminar-cuenta',
      ]) {
        expect(porUrl(url), isNot(isA<DestinoEnApp>()), reason: url);
      }
    });
  });

  group('Lo que NO se reconoce', () {
    test('⛔ una ruta desconocida no lleva a ningún lado', () {
      // Ni al feed. Ver la nota de la cabecera.
      expect(porUrl('https://vendox.com.ar/algo-que-no-existe'), isNull);
      expect(porUrl('https://vendox.com.ar/x/prd_1'), isNull);
    });

    test('⛔ la raíz del dominio tampoco', () {
      expect(porUrl('https://vendox.com.ar/'), isNull);
      expect(porUrl('https://vendox.com.ar'), isNull);
    });

    test('⛔ OTRO dominio nunca abre una pantalla nuestra', () {
      /**
       * EL TEST DE SEGURIDAD.
       *
       * El intent-filter ya filtra por dominio, pero este mismo resolutor lo
       * usa el push, donde el enlace no pasa por Android. Un enlace ajeno
       * abriendo una pantalla nuestra es exactamente cómo se construye una
       * redirección abierta.
       */
      expect(porUrl('https://vendox.com.ar.malicioso.com/p/prd_1'), isNull);
      expect(porUrl('https://otrodominio.com/p/prd_1'), isNull);
      expect(porUrl('https://vendoxcom.ar/p/prd_1'), isNull);
    });

    test('⛔ un id con caracteres imposibles se descarta', () {
      // No es validación contra la base —eso lo hace el backend— sino
      // descartar lo que no puede ser un id antes de abrir una pantalla de
      // carga que va a dar 404.
      expect(porUrl('https://vendox.com.ar/p/..%2F..%2Fetc'), isNull);
      expect(porUrl('https://vendox.com.ar/p/con espacio'), isNull);
    });

    test('⛔ un id vacío o larguísimo, tampoco', () {
      expect(porUrl('https://vendox.com.ar/p/'), isNull);
      expect(porUrl('https://vendox.com.ar/p/${'a' * 200}'), isNull);
    });

    test('⛔ tres segmentos no son ninguna ruta nuestra', () {
      expect(porUrl('https://vendox.com.ar/p/prd_1/editar'), isNull);
    });
  });

  group('Los avisos push usan el MISMO resolutor', () {
    test('con `ruta` armada por el backend', () {
      // Es la forma preferida: el servidor ya la resolvió.
      expect(
        resolverAviso({'type': 'LIVE_STARTED', 'ruta': '/live/liv_9', 'liveSessionId': 'liv_9'}),
        const DestinoEnApp(TipoDeDestino.vivo, 'liv_9'),
      );
    });

    test('sin `ruta`, se deriva del tipo y el id', () {
      /**
       * El payload del backend no es uniforme: unos avisos mandan `ruta`, otros
       * `tipo` más un id, otros sólo el id. Se absorbe acá en vez de tocar los
       * ocho archivos que los crean.
       */
      expect(
        resolverAviso({'type': 'SAVED_BACK_IN_STOCK', 'productId': 'prd_7'}),
        const DestinoEnApp(TipoDeDestino.producto, 'prd_7'),
      );
      expect(
        resolverAviso({'type': 'SUPPORT_REPLY', 'tipo': 'support', 'ticketId': 'sup_3'}),
        const DestinoEnApp(TipoDeDestino.soporte, 'sup_3'),
      );
    });

    test('un aviso de venta lleva al vendedor, no al comprador', () {
      // Son dos pantallas distintas del mismo pedido. Confundirlas le muestra
      // al vendedor la vista del comprador de su propia venta.
      expect(
        resolverAviso({'type': 'ORDER_RECEIVED', 'orderId': 'ord_1'}),
        const DestinoEnApp(TipoDeDestino.venta, 'ord_1'),
      );
      expect(
        resolverAviso({'type': 'ORDER_STATUS', 'orderId': 'ord_1'}),
        const DestinoEnApp(TipoDeDestino.pedido, 'ord_1'),
      );
    });

    test('⛔ ACCOUNT no navega a ningún lado, y está bien', () {
      /**
       * «Tu producto fue ocultado» abre la app y listo. El detalle está en el
       * centro de notificaciones, que ya es la pantalla correcta — inventarle
       * un destino sería llevar a alguien a una pantalla que no explica nada.
       */
      expect(resolverAviso({'type': 'ACCOUNT', 'tipo': 'product', 'productId': 'prd_1'}), isNull);
    });

    test('⛔ un tipo desconocido no navega', () {
      // Un aviso nuevo del backend abre la app y nada más, en vez de mandar a
      // una pantalla equivocada.
      expect(resolverAviso({'type': 'ALGO_NUEVO', 'orderId': 'ord_1'}), isNull);
      expect(resolverAviso({}), isNull);
    });

    test('⛔ una `ruta` que apunta afuera no se sigue', () {
      // El backend nunca la mandaría así, pero el payload llega por la red.
      expect(resolverAviso({'ruta': 'https://otro.com/p/prd_1', 'type': 'X'}), isNull);
      expect(resolverAviso({'ruta': '/etc/passwd', 'type': 'X'}), isNull);
    });

    test('⛔ un id inválido en el payload se descarta', () {
      expect(resolverAviso({'type': 'ORDER_STATUS', 'orderId': ''}), isNull);
      expect(resolverAviso({'type': 'ORDER_STATUS', 'orderId': 123}), isNull);
    });
  });

  group('Arranque en frío y en caliente', () {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL ENLACE LLEGA ANTES QUE LA APP
     * ═══════════════════════════════════════════════════════════════════════
     *
     * En arranque en frío el enlace está resuelto mucho antes de que exista el
     * árbol de widgets: la pantalla todavía es el indicador de carga mientras
     * se lee la sesión del Keychain, y `Navigator` no existe.
     *
     * Sin guardarlo, ese enlace se pierde — y «toqué el enlace y me abrió el
     * feed» es el bug clásico de cualquier app con deep links.
     */

    setUp(NavegadorDeEnlaces.instance.reiniciar);

    test('⛔ en frío, el destino QUEDA ESPERANDO en vez de perderse', () {
      final nav = NavegadorDeEnlaces.instance;

      // Llega el enlace antes de que la app avise que puede navegar.
      nav.manejar(const DestinoEnApp(TipoDeDestino.vivo, 'liv_1'));

      expect(nav.pendiente, const DestinoEnApp(TipoDeDestino.vivo, 'liv_1'));
    });

    test('en caliente sin Navigator montado, vuelve a la cola', () {
      /**
       * El árbol se pudo haber desmontado entre que llegó el enlace y que se
       * intentó abrir. Descartarlo ahí perdería un enlace que la persona sí
       * tocó; volver a encolarlo lo recupera en el próximo intento.
       */
      final nav = NavegadorDeEnlaces.instance;
      nav.listoParaNavegar();

      nav.manejar(const DestinoEnApp(TipoDeDestino.vivo, 'liv_2'));

      expect(nav.pendiente, const DestinoEnApp(TipoDeDestino.vivo, 'liv_2'));
    });

    test('⛔ un enlace no reconocido NO queda esperando', () {
      /**
       * Guardarlo dejaría una bomba: la próxima vez que la app avise que puede
       * navegar, intentaría abrir algo que ya se descartó.
       */
      final nav = NavegadorDeEnlaces.instance;
      nav.manejar(null);

      expect(nav.pendiente, isNull);
    });

    test('una página web no se guarda como pendiente de navegación', () {
      // Va al navegador, no a una pantalla. Encolarla la abriría dos veces.
      final nav = NavegadorDeEnlaces.instance;
      final abiertas = <String>[];
      nav.abrirEnNavegador = (url) async {
        abiertas.add(url);
        return true;
      };
      nav.listoParaNavegar();

      nav.manejar(const DestinoWeb('https://vendox.com.ar/privacidad'));

      expect(abiertas, ['https://vendox.com.ar/privacidad']);
      expect(nav.pendiente, isNull);
    });
  });
}
