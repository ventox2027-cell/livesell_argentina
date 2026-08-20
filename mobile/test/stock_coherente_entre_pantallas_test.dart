import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/inventory/data/ajustes_en_vuelo.dart';
import 'package:vendox/features/inventory/data/inventory_repository.dart';
import 'package:vendox/features/inventory/domain/inventory_models.dart';

/// El stock que se ve, en las dos pantallas que lo muestran.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// DOS A CINCO SEGUNDOS CON EL NÚMERO VIEJO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: sumar unidades adentro de Stock andaba bien, pero al
/// volver atrás el resumen del editor seguía mostrando lo de antes.
///
/// No era la red. Eran dos fuentes para el mismo dato: `StockScreen` armaba la
/// mezcla —servidor + toques pendientes— y `_AccesoStock` leía el provider
/// pelado. Al volver, el editor invalidaba y pedía de nuevo... y el servidor
/// devolvía el número VIEJO, porque el ajuste todavía estaba esperando los
/// 450 ms del rebote antes de salir.
///
/// O sea: un viaje de red entero para traer un dato desactualizado, y otro
/// cuando el ajuste por fin llegaba.
void main() {
  late _RepoDeStock repo;

  ProviderContainer contenedor() {
    repo = _RepoDeStock();
    final c = ProviderContainer(
      overrides: [inventoryRepositoryProvider.overrideWithValue(repo)],
    );
    addTearDown(c.dispose);
    return c;
  }

  Future<void> cargar(ProviderContainer c) async {
    await c.read(stockDeProductoProvider('prd_1').future);
  }

  /// ⛔ EL TEST DEL BUG.
  ///
  /// Un toque que todavía no salió a la red ya se ve en el valor visible. Es lo
  /// que hace que volver atrás muestre el número nuevo sin pedir nada.
  test('⛔ un toque pendiente ya se ve, sin viaje de red', () async {
    final c = contenedor();
    await cargar(c);

    expect(c.read(stockVisibleProvider('prd_1')).value!.totalOnHand, 10);

    c.read(ajustesEnVueloProvider.notifier).tocar(
          productId: 'prd_1',
          variantId: 'var_1',
          delta: 4,
          destino: 14,
        );

    expect(c.read(stockVisibleProvider('prd_1')).value!.totalOnHand, 14);
    expect(repo.vecesQuePidio, 1, reason: 'no tuvo que volver a preguntar');
  });

  /// ⛔ Y las dos pantallas leen EXACTAMENTE lo mismo.
  ///
  /// El bug no era que una estuviera mal: era que había dos. Este test fija que
  /// hay una sola fuente.
  test('⛔ el valor visible es uno solo', () async {
    final c = contenedor();
    await cargar(c);

    c.read(ajustesEnVueloProvider.notifier).tocar(
          productId: 'prd_1',
          variantId: 'var_1',
          delta: -3,
          destino: 7,
        );

    final unaLectura = c.read(stockVisibleProvider('prd_1')).value!;
    final otraLectura = c.read(stockVisibleProvider('prd_1')).value!;

    expect(unaLectura.totalOnHand, otraLectura.totalOnHand);
    expect(unaLectura.totalOnHand, 7);
  });

  /// ⛔ Lo reservado NUNCA es optimista.
  ///
  /// Es lo que están comprando otras personas ahora mismo. Un número inventado
  /// ahí deja vender algo que ya está apartado.
  test('⛔ las apartadas siguen siendo las del servidor', () async {
    final c = contenedor();
    await cargar(c);

    c.read(ajustesEnVueloProvider.notifier).tocar(
          productId: 'prd_1',
          variantId: 'var_1',
          delta: 5,
          destino: 15,
        );

    final vista = c.read(stockVisibleProvider('prd_1')).value!;
    expect(vista.totalReservado, 2);
    expect(vista.totalDisponible, 13, reason: '15 mostradas menos 2 apartadas');
  });

  /// Sin toques pendientes, es tal cual lo que dijo el servidor.
  test('sin toques, manda el servidor', () async {
    final c = contenedor();
    await cargar(c);

    expect(c.read(stockVisibleProvider('prd_1')).value!.totalOnHand, 10);
  });
}

class _RepoDeStock extends Fake implements InventoryRepository {
  int vecesQuePidio = 0;

  @override
  Future<StockProducto> stockDeProducto(String productId) async {
    vecesQuePidio += 1;
    return StockProducto.fromJson(const {
      'productId': 'prd_1',
      'variants': [
        {
          'variantId': 'var_1',
          'title': 'Único',
          'onHand': 10,
          'reserved': 2,
          'available': 8,
        },
      ],
    });
  }
}
