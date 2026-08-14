import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/lives/domain/live_models.dart';
import 'package:vendox/features/orders/domain/order_models.dart';

/// Contrato del envío, el recargo del procesador y las devoluciones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL JSON NO ESTÁ ESCRITO ACÁ. ESTÁ COPIADO DEL SERVIDOR.
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Los archivos de `test/contratos/` los genera
/// `backend/test/integration/capturar-contrato.spec.ts`, que arranca la
/// aplicación de verdad contra PostgreSQL de verdad, pide los endpoints y
/// guarda las respuestas tal cual salen.
///
/// La regla existe porque ya se rompió una vez, y caro: un test de contrato con
/// un JSON **inventado a mano** pasaba en verde mientras la app real mostraba
/// `$0,00` en la hoja de variantes. El JSON inventado se parecía al real, pero
/// no lo era, y el test confirmaba una fantasía en vez de un contrato.
///
/// Si el backend cambia la forma de una respuesta, se vuelve a correr la
/// captura y estos tests fallan solos. Eso es exactamente lo que tienen que
/// hacer.
void main() {
  Map<String, dynamic> leer(String nombre) {
    final archivo = File('test/contratos/$nombre.json');
    expect(
      archivo.existsSync(),
      isTrue,
      reason:
          'Falta test/contratos/$nombre.json. Se regenera con:\n'
          '  cd backend && pnpm vitest run test/integration/capturar-contrato.spec.ts',
    );
    return jsonDecode(archivo.readAsStringSync()) as Map<String, dynamic>;
  }

  group('Detalle público del producto', () {
    late DetalleDeProducto producto;

    setUp(() => producto = DetalleDeProducto.fromJson(leer('catalogo-producto')));

    test('lee el producto y sus variantes', () {
      expect(producto.nombre, 'Buzo oversize de algodón');
      expect(producto.precioBaseCentavos, 890000);
      expect(producto.ejes.length, 2);
      expect(producto.variantes.length, 2);
      expect(producto.variantes.first.disponible, 4);
    });

    test('lee la política de envío con retiro', () {
      expect(producto.envio.modo, 'FIXED_OR_PICKUP');
      expect(producto.envio.costo, 350000);
      expect(producto.envio.permiteEnvio, isTrue);
      expect(producto.envio.permiteRetiro, isTrue);
      // Es lo que hace que la hoja muestre las dos opciones en vez de una línea.
      expect(producto.envio.hayQueElegir, isTrue);
      expect(producto.envio.nota, contains('martes'));
    });

    test('avisa que el costo del medio de pago se traslada', () {
      // Se avisa ANTES del checkout: un recargo que aparece con la tarjeta en
      // la mano se siente escondido aunque esté explicado.
      expect(producto.envio.trasladaCostoDelProcesador, isTrue);
    });

    test('lee la política de cambios y sus líneas', () {
      expect(producto.cambios.modo, 'CAMBIO_SIN_CAUSA');
      expect(producto.cambios.dias, 30);
      expect(producto.cambios.ofreceMasQueElMinimo, isTrue);
      expect(producto.cambios.lineas, isNotEmpty);
      expect(producto.cambios.lineas.join(' '), contains('30 días'));
    });

    test('⛔ el derecho de arrepentimiento llega y no está vacío', () {
      /**
       * La Resolución 424/2020 pide que sea visible y fácil de encontrar. Si el
       * backend dejara de mandarlo, la pantalla lo mostraría igual —hay un
       * respaldo en el modelo— pero este test tiene que avisar que el contrato
       * cambió, porque el respaldo puede quedar desactualizado.
       */
      expect(producto.cambios.derechoDeArrepentimiento, contains('10 días corridos'));
      expect(producto.cambios.derechoDeArrepentimiento, contains('sin costo'));
      expect(producto.cambios.derechoDeArrepentimiento, contains('no depende del vendedor'));
    });

    test('el nombre de la tienda llega', () {
      expect(producto.nombreDeTienda, contains('Tejidos Marta'));
    });
  });

  group('Pedido con envío', () {
    late Pedido pedido;

    setUp(() => pedido = Pedido.fromJson(leer('orden-con-envio')));

    test('el total es producto + envío + recargo', () {
      expect(pedido.itemsSubtotal, 890000);
      expect(pedido.shippingAmount, 350000);
      expect(pedido.recargoProcesador, 76756);
      expect(pedido.grossAmount, 1316756);

      // La suma tiene que cerrar en la app igual que en la base.
      expect(
        pedido.itemsSubtotal + pedido.shippingAmount + pedido.recargoProcesador,
        pedido.grossAmount,
      );
    });

    test('guarda la política con la que se cobró', () {
      // No la actual de la tienda: la de ESTE pedido. Es lo que permite explicar
      // dentro de un año por qué cobró lo que cobró.
      expect(pedido.modoDeEnvio, 'FIXED_OR_PICKUP');
      expect(pedido.retiraEnPersona, isFalse);
    });
  });

  group('Pedido con retiro en persona', () {
    late Pedido pedido;

    setUp(() => pedido = Pedido.fromJson(leer('orden-con-retiro')));

    test('no cobra envío y queda marcado', () {
      expect(pedido.shippingAmount, 0);
      /**
       * ⚠️ `retiraEnPersona` NO se deduce de `shippingAmount == 0`.
       *
       * Hay tiendas con envío gratis. Confundir las dos cosas hace que la app
       * le diga al vendedor "no despaches" en un pedido que sí hay que
       * despachar, o al revés: que alguien espere en su casa un paquete que
       * tiene que ir a buscar.
       */
      expect(pedido.retiraEnPersona, isTrue);
    });

    test('el recargo se calcula sin el envío', () {
      // 890.000 × 6,19 % = 55.091. Si la base incluyera el envío que no se
      // cobró, daría 76.756 y alguien pagaría de más.
      expect(pedido.recargoProcesador, 55091);
      expect(pedido.grossAmount, 945091);
    });
  });

  group('Centro de notificaciones', () {
    test('la respuesta vacía tiene la forma esperada', () {
      final j = leer('notificaciones-vacio');
      expect(j['items'], isA<List<dynamic>>());
      expect(j['sinLeer'], 0);
      expect(j.containsKey('nextCursor'), isTrue);
    });
  });
}
