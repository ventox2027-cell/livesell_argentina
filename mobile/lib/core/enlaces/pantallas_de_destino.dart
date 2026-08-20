import 'package:flutter/material.dart';

import '../../features/lives/presentation/live_viewer_screen.dart';
import '../../features/lives/presentation/seller_profile_screen.dart';
import '../../features/lives/presentation/tienda_screen.dart';
import '../../features/orders/presentation/orders_screen.dart';
import '../../features/support/presentation/ticket_screen.dart';
import 'destino.dart';

/// Qué pantalla abre cada destino.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SEPARADO DEL RESOLUTOR A PROPÓSITO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `destino.dart` decide *qué* pidió el enlace y no importa una sola pantalla:
/// por eso se puede probar con una cadena de texto y sin `BuildContext`.
///
/// Este archivo es el otro lado, el que sí conoce las pantallas. Cuando la app
/// migre a un router de verdad, se reescribe éste y el resolutor queda igual.
///
/// ─── Los que devuelven `null` ───
///
/// Hay destinos que el resolutor entiende y para los que no hay una pantalla a
/// la que llevar directo: la venta se ve dentro de «Mis ventas» y el producto
/// se abre como hoja sobre la pantalla actual, no como ruta propia.
///
/// Devolver `null` hace que el enlace abra la app y no navegue. Es lo correcto:
/// abrir una pantalla parecida sería llevar a alguien a un lugar que no pidió,
/// y es más difícil de entender que no pasar nada.
Widget? pantallaDeDestino(DestinoEnApp destino) {
  return switch (destino.tipo) {
    TipoDeDestino.vivo => LiveViewerScreen(liveId: destino.id),
    TipoDeDestino.vendedor => SellerProfileScreen(sellerId: destino.id),
    TipoDeDestino.pedido => OrderDetailScreen(orderId: destino.id),
    TipoDeDestino.soporte => TicketScreen(ticketId: destino.id),

    /**
     * El producto se abre en una hoja sobre la pantalla actual, no en una
     * pantalla propia — así se diseñó la compra desde el feed y desde el vivo.
     *
     * Una hoja necesita un `BuildContext` y un `showModalBottomSheet`, que no
     * es un `Widget` que se pueda devolver acá. Se resuelve en el llamador.
     */
    TipoDeDestino.producto => null,

    /**
     * ⚠️ La tienda llega con SLUG, no con id.
     *
     * `vendox.com.ar/t/lanas-del-sur` es lo que se comparte, porque un slug se
     * lee y un id no. Quien traduce es el backend: ahí viven las reglas de qué
     * tienda se puede mostrar, y una copia en Dart dejaría la vidriera de un
     * vendedor suspendido abierta para cualquiera con el enlace guardado.
     *
     * La traducción ocurre DENTRO de la pantalla y no acá: esta función es
     * pura y sincrónica, y volverla `async` obligaría a todos los destinos a
     * pasar por un camino que ninguno necesita. Ver `TiendaScreen.porSlug`.
     */
    TipoDeDestino.tienda => TiendaScreen.porSlug(destino.id),

    /**
     * La venta se ve dentro de «Mis ventas»: no tiene pantalla propia con su
     * id. Se deja sin resolver en vez de aproximar — ver la nota de arriba.
     */
    TipoDeDestino.venta => null,
    TipoDeDestino.resena => null,
  };
}
