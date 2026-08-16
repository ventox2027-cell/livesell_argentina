import 'package:flutter/material.dart';

import '../../features/lives/presentation/live_viewer_screen.dart';
import '../../features/lives/presentation/seller_profile_screen.dart';
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
/// Hay destinos que el resolutor entiende y para los que todavía no hay una
/// pantalla a la que llevar directo: la tienda y la venta se ven dentro de
/// otras pantallas, no tienen una propia con su id en la URL.
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
     * La tienda se ve dentro del perfil del vendedor, y la venta dentro de
     * «Mis ventas»: ninguna tiene pantalla propia con su id.
     *
     * Se dejan sin resolver en vez de aproximar. Ver la nota de arriba.
     */
    TipoDeDestino.tienda => null,
    TipoDeDestino.venta => null,
    TipoDeDestino.resena => null,
  };
}
