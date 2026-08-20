import 'seller_models.dart';

/// Cambios de estado de producto que todavía no confirmó el servidor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PUBLICAR TARDABA 6-8 SEGUNDOS EN VERSE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: pausar un producto publicado ~5 s, volver a
/// publicarlo ~8 s. Y todo ese rato el botón seguía diciendo lo de antes.
///
/// Publicar o pausar es un interruptor. La persona ya decidió; lo único que
/// falta es que el servidor lo anote. Hacerla mirar la pantalla mientras eso
/// viaja a otro continente es pedirle que espere a algo que no le aporta nada.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL CONTADOR DEL PLAN SÍ SE MUEVE ACÁ, Y ANTES NO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// En el borrado de un producto se decidió lo contrario —no tocar el contador—
/// y la diferencia es real: ahí el efecto sobre el cupo depende del estado en
/// que estaba el producto, y hacerlo bien exigía saber cosas que la pantalla no
/// tenía.
///
/// Acá la operación ES el cambio de estado. Pasar a `ACTIVE` suma exactamente
/// uno al conteo de publicados y pasar a `PAUSED` le resta exactamente uno. No
/// hay nada que estimar.
///
/// ⚠️ Lo que NO cambia es quién decide. El backend sigue siendo el único que
/// deja o no publicar —con su `pg_advisory_xact_lock`— y si dice que no, esto
/// se deshace entero. El número de acá acompaña una decisión ya tomada; no
/// habilita ninguna.
class CambiosDeEstado {
  const CambiosDeEstado({this.pendientes = const {}});

  /// `productId → estado que se está mostrando`.
  final Map<String, String> pendientes;

  bool enCurso(String productId) => pendientes.containsKey(productId);

  /// El estado que se ve. Mientras hay uno pendiente, manda ése.
  String estadoDe(Producto p) => pendientes[p.id] ?? p.status;

  CambiosDeEstado con(String productId, String estado) =>
      CambiosDeEstado(pendientes: {...pendientes, productId: estado});

  CambiosDeEstado sin(String productId) =>
      CambiosDeEstado(pendientes: {...pendientes}..remove(productId));
}

/// Cuántos publicados hay que mostrar, contando lo que está en vuelo.
///
/// ⚠️ Recorre los productos y cuenta los que se ven como `ACTIVE`, en vez de
/// sumar y restar sobre el número del servidor.
///
/// La diferencia importa: sumar y restar acumula error. Dos cambios seguidos,
/// uno que falla, un refresco en el medio, y el contador queda corrido sin que
/// nadie sepa desde cuándo. Contando, cada vez que llega un dato nuevo del
/// servidor el número se recalcula solo.
EstadoDelCatalogo? catalogoVisible({
  required EstadoDelCatalogo? delServidor,
  required List<Producto> productos,
  required CambiosDeEstado cambios,
}) {
  if (delServidor == null) return null;
  if (cambios.pendientes.isEmpty) return delServidor;

  /**
   * Sólo se recuenta la DIFERENCIA que producen los cambios en vuelo.
   *
   * No se puede recontar desde cero: la lista que tiene la pantalla es una
   * página, y el conteo del servidor abarca el catálogo entero. Contar acá
   * daría un número más chico apenas alguien tenga más productos que los que
   * entran en una página.
   */
  var diferencia = 0;
  for (final p in productos) {
    final pendiente = cambios.pendientes[p.id];
    if (pendiente == null) continue;

    final estabaActivo = p.status == 'ACTIVE';
    final quedaActivo = pendiente == 'ACTIVE';
    if (estabaActivo == quedaActivo) continue;

    diferencia += quedaActivo ? 1 : -1;
  }

  if (diferencia == 0) return delServidor;

  final publicados = (delServidor.publicados + diferencia).clamp(0, 1 << 30);
  final limite = delServidor.limite;

  return EstadoDelCatalogo(
    publicados: publicados,
    limite: limite,
    puedePublicar: limite == null || publicados < limite,
  );
}
