import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/politicas_models.dart';

/// Las políticas de la tienda: envío, costo del medio de pago y devoluciones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ENDPOINTS APARTE DE "EDITAR TIENDA"
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cambiar el nombre de la tienda no le cuesta plata a nadie. Cambiar el envío
/// sí: define lo que se le va a cobrar a compradores reales en todos los
/// pedidos que vengan después. Y las devoluciones definen obligaciones legales.
///
/// Van por rutas propias para que la interfaz tenga que mostrarlas enteras, en
/// su propia pantalla, en vez de esconderlas como dos campos más de un
/// formulario largo donde se tocan sin pensar.
class PoliticasApi {
  PoliticasApi(this._api);
  final ApiClient _api;

  Future<PoliticaDeEnvioEditable> guardarEnvio(String storeId, PoliticaDeEnvioEditable p) async {
    final r = await _api.patch<Map<String, dynamic>>(
      '/stores/$storeId/shipping',
      data: {
        'shippingMode': p.modo.name,
        'shippingFlatAmount': p.montoFijo,
        'shippingNote': p.nota,
        'processorFeeMode': p.trasladaCostoDelProcesador ? 'PASSED_TO_BUYER' : 'ABSORBED',
      },
    );
    return PoliticaDeEnvioEditable.fromJson(r.data ?? const {});
  }

  Future<PoliticaDeCambiosEditable> guardarCambios(
    String storeId,
    PoliticaDeCambiosEditable p,
  ) async {
    final r = await _api.patch<Map<String, dynamic>>(
      '/stores/$storeId/exchange-policy',
      data: {
        'exchangeMode': p.modo.name,
        'exchangeWindowDays': p.dias,
        'returnShippingPaidBy': p.envioDeVueltaLoPagaElVendedor ? 'VENDEDOR' : 'COMPRADOR',
        'exchangeNote': p.nota,
      },
    );
    return PoliticaDeCambiosEditable.fromJson(r.data ?? const {});
  }
}

final politicasApiProvider =
    Provider<PoliticasApi>((ref) => PoliticasApi(ref.watch(apiClientProvider)));
