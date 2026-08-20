import 'package:flutter/foundation.dart';

/// A dónde lleva un enlace.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UN SOLO LUGAR DECIDE, PARA LOS DOS CAMINOS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Este módulo lo usan las dos formas de entrar a la app desde afuera: un
/// enlace de `vendox.com.ar` y el toque en un aviso push. Con dos resolutores
/// distintos, el mismo producto abriría una pantalla desde WhatsApp y otra
/// desde una notificación — y el día que difieran, nadie va a saber cuál está
/// bien.
///
/// Es puro a propósito: sin `BuildContext`, sin Navigator, sin Firebase. Se
/// prueba con una cadena de texto y se lee de un vistazo, que es lo que hace
/// falta para discutir si una ruta está bien resuelta.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE RECONOCE NO VA AL FEED
/// ═══════════════════════════════════════════════════════════════════════════
///
/// `vendox.com.ar/privacidad` es una página web, no una pantalla. Y una ruta
/// que no existe es un error o un enlace viejo.
///
/// En los dos casos la respuesta es [DestinoWeb] o `null` — nunca el feed.
/// Mandar al feed «por las dudas» es peor que no hacer nada: la persona tocó
/// esperando algo concreto y termina en una pantalla que no pidió, sin
/// entender qué pasó y sin forma de volver a donde iba.

/// El dominio de los enlaces propios.
const dominioDeVendoX = 'vendox.com.ar';

/// Qué hacer con un enlace.
@immutable
sealed class Destino {
  const Destino();
}

/// Abre una pantalla de la app.
@immutable
final class DestinoEnApp extends Destino {
  const DestinoEnApp(this.tipo, this.id);

  final TipoDeDestino tipo;

  /// El id o el slug, según el tipo. Ya viene sin barras ni parámetros.
  final String id;

  @override
  bool operator ==(Object other) =>
      other is DestinoEnApp && other.tipo == tipo && other.id == id;

  @override
  int get hashCode => Object.hash(tipo, id);

  @override
  String toString() => 'DestinoEnApp(${tipo.name}, $id)';
}

/// Es una página web nuestra: se abre en el navegador, no en la app.
@immutable
final class DestinoWeb extends Destino {
  const DestinoWeb(this.url);

  final String url;

  @override
  bool operator ==(Object other) => other is DestinoWeb && other.url == url;

  @override
  int get hashCode => url.hashCode;

  @override
  String toString() => 'DestinoWeb($url)';
}

enum TipoDeDestino {
  producto,
  vivo,
  tienda,
  vendedor,

  /// Pantallas a las que sólo se llega desde un aviso, no desde un enlace web.
  pedido,
  venta,
  soporte,
  resena,
}

/// Las rutas web que existen y NO son pantallas de la app.
///
/// Se enumeran en vez de deducirse: cualquier ruta desconocida ya cae en
/// `null`, así que esta lista sólo sirve para las que sabemos que son páginas
/// reales y queremos abrir en el navegador en vez de descartar en silencio.
const _rutasWeb = {'privacidad', 'eliminar-cuenta'};

/// Las rutas de la app, tal como las sirve el backend en `landing.controller`.
const _prefijos = <String, TipoDeDestino>{
  'p': TipoDeDestino.producto,
  'v': TipoDeDestino.vivo,
  't': TipoDeDestino.tienda,
  'u': TipoDeDestino.vendedor,

  /**
   * La vuelta de Mercado Pago.
   *
   * La URL la arma el backend al crear la preferencia y la abre Mercado Pago
   * al redirigir. Lleva además un `?estado=` que acá NO se mira: quien decide
   * si la orden está paga es el webhook, y un enlace de vuelta lo puede
   * escribir cualquiera.
   *
   * Va al detalle del pedido, que es donde se ve el estado de verdad.
   */
  'pago': TipoDeDestino.pedido,
};

/// Largo máximo de un id o slug.
///
/// Los ULID del proyecto son de 30 caracteres con prefijo; los slugs, menos.
/// El tope no es por seguridad —el backend valida igual— sino para descartar
/// basura antes de abrir una pantalla que va a fallar.
const _largoMaximo = 80;

/// Resuelve un enlace entrante.
///
/// Devuelve `null` cuando no hay nada razonable que hacer: otro dominio, una
/// ruta desconocida, o un id que no puede ser un id.
Destino? resolverEnlace(Uri uri) {
  /**
   * ⚠️ El dominio se comprueba, aunque el intent-filter ya lo filtre.
   *
   * El mismo resolutor lo usa el push, donde el enlace no pasa por Android. Y
   * un enlace a otro dominio abriendo una pantalla nuestra es exactamente cómo
   * se construye una redirección abierta.
   */
  if (uri.host.isNotEmpty && uri.host != dominioDeVendoX) return null;

  // `pathSegments` ya descarta las barras vacías: /p/prd_1/ da ['p','prd_1'].
  final partes = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (partes.isEmpty) return null;

  // Una página web nuestra. Se abre en el navegador.
  if (partes.length == 1 && _rutasWeb.contains(partes.first)) {
    return DestinoWeb(uri.toString());
  }

  if (partes.length != 2) return null;

  final tipo = _prefijos[partes[0]];
  if (tipo == null) return null;

  final id = partes[1];
  if (!_idPlausible(id)) return null;

  return DestinoEnApp(tipo, id);
}

/// Resuelve el `data` de un aviso push.
///
/// El backend arma ese `data` distinto según quién crea el aviso: algunos
/// mandan `ruta` ya resuelta —`/live/liv_123`—, otros `tipo` más un id, y
/// otros sólo el id. Unificarlo del lado del servidor tocaría ocho archivos;
/// mientras tanto se absorbe acá, con las dos formas probadas.
Destino? resolverAviso(Map<String, dynamic> data) {
  // 1 · La ruta que armó el backend. Es la forma preferida.
  final ruta = data['ruta'];
  if (ruta is String && ruta.startsWith('/')) {
    final desde = _desdeRutaInterna(ruta);
    if (desde != null) return desde;
  }

  // 2 · Derivada del tipo del aviso más el id que corresponda.
  final tipo = data['type'];
  return switch (tipo) {
    'LIVE_STARTED' || 'LIVE_SOON' => _con(data, 'liveSessionId', TipoDeDestino.vivo),
    'SAVED_BACK_IN_STOCK' || 'STORE_REOPENED' => _con(data, 'productId', TipoDeDestino.producto),
    'SUPPORT_REPLY' => _con(data, 'ticketId', TipoDeDestino.soporte),
    'ORDER_STATUS' || 'PAYMENT_APPROVED' || 'PAYMENT_REJECTED' =>
      _con(data, 'orderId', TipoDeDestino.pedido),
    'ORDER_RECEIVED' => _con(data, 'orderId', TipoDeDestino.venta),
    'REVIEW_ANSWERED' || 'REVIEW_RECEIVED' => _con(data, 'reviewId', TipoDeDestino.resena),

    /**
     * `ACCOUNT` no lleva a ningún lado, y está bien.
     *
     * Un aviso de «tu producto fue ocultado» abre la app y listo: el detalle
     * está en el centro de notificaciones, que ya es la pantalla correcta.
     */
    _ => null,
  };
}

/// Las rutas internas que el backend manda en `data.ruta`.
Destino? _desdeRutaInterna(String ruta) {
  final partes = ruta.split('/').where((s) => s.isNotEmpty).toList();
  if (partes.length != 2) return null;

  final tipo = switch (partes[0]) {
    'live' => TipoDeDestino.vivo,
    'producto' => TipoDeDestino.producto,
    'pedido' => TipoDeDestino.pedido,
    'venta' => TipoDeDestino.venta,
    'soporte' => TipoDeDestino.soporte,
    'resena' => TipoDeDestino.resena,
    'tienda' => TipoDeDestino.tienda,
    'vendedor' => TipoDeDestino.vendedor,
    _ => null,
  };
  if (tipo == null) return null;
  if (!_idPlausible(partes[1])) return null;

  return DestinoEnApp(tipo, partes[1]);
}

Destino? _con(Map<String, dynamic> data, String clave, TipoDeDestino tipo) {
  final id = data[clave];
  if (id is! String || !_idPlausible(id)) return null;
  return DestinoEnApp(tipo, id);
}

/// Si esto puede ser un id o un slug.
///
/// No valida contra la base —eso lo hace el backend— sino que descarta lo que
/// seguro no lo es: vacío, larguísimo, o con caracteres que ningún id nuestro
/// tiene. Evita abrir una pantalla de carga para algo que va a dar 404.
bool _idPlausible(String valor) {
  if (valor.isEmpty || valor.length > _largoMaximo) return false;
  return RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(valor);
}
