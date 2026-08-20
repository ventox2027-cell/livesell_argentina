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

/// Un cambio en vuelo: de dónde venía y a dónde va.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ SE GUARDA EL «ANTES»
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes sólo se guardaba el estado nuevo, y el efecto sobre el cupo se
/// deducía comparándolo con el producto **de la lista que estaba en pantalla**.
/// Eso ataba el contador a que el producto estuviera en la página cargada: si
/// no estaba —porque el catálogo tiene más de los que entran en una página—, el
/// cambio no sumaba ni restaba nada y el cupo quedaba corrido.
///
/// Con el «antes» adentro, la cuenta sale del cambio mismo. Ninguna lista hace
/// falta.
class CambioPendiente {
  const CambioPendiente({required this.antes, required this.despues});

  /// El estado que tenía cuando se tocó. Es a donde vuelve si el servidor
  /// rechaza.
  final String antes;

  /// El estado que se está mostrando mientras el `PATCH` viaja.
  final String despues;

  /// Cuánto mueve este cambio el conteo de publicados: `1`, `-1` o `0`.
  int get efectoEnElCupo {
    final estaba = antes == 'ACTIVE';
    final queda = despues == 'ACTIVE';
    if (estaba == queda) return 0;
    return queda ? 1 : -1;
  }
}

class CambiosDeEstado {
  const CambiosDeEstado({this.pendientes = const {}});

  /// `productId → el cambio que está viajando`.
  final Map<String, CambioPendiente> pendientes;

  bool enCurso(String productId) => pendientes.containsKey(productId);

  /// El estado que se ve. Mientras hay uno pendiente, manda ése.
  String estadoDe(Producto p) => pendientes[p.id]?.despues ?? p.status;

  /// Cuánto mueven el cupo TODOS los cambios en vuelo, juntos.
  int get efectoEnElCupo =>
      pendientes.values.fold(0, (suma, c) => suma + c.efectoEnElCupo);

  CambiosDeEstado con(String productId, {required String antes, required String despues}) =>
      CambiosDeEstado(
        pendientes: {
          ...pendientes,
          productId: CambioPendiente(antes: antes, despues: despues),
        },
      );

  CambiosDeEstado sin(String productId) =>
      CambiosDeEstado(pendientes: {...pendientes}..remove(productId));
}

/// Cuántos publicados hay que mostrar, contando lo que está en vuelo.
///
/// ⚠️ Suma la DIFERENCIA sobre el número del servidor; NO recuenta la lista.
///
/// La lista que tiene la pantalla es una página, y el conteo del servidor
/// abarca el catálogo entero. Recontar acá daría un número más chico apenas
/// alguien tenga más productos que los que entran en una página.
///
/// Y la diferencia no acumula error: cuando llega un listado nuevo del
/// servidor, `pendientes` ya está vacío —los cambios se sueltan recién después
/// de reconciliar— así que el número vuelve a ser el del servidor, tal cual.
EstadoDelCatalogo? catalogoVisible({
  required EstadoDelCatalogo? delServidor,
  required CambiosDeEstado cambios,
}) {
  if (delServidor == null) return null;

  final diferencia = cambios.efectoEnElCupo;
  if (diferencia == 0) return delServidor;

  final publicados = (delServidor.publicados + diferencia).clamp(0, 1 << 30);
  final limite = delServidor.limite;

  return EstadoDelCatalogo(
    publicados: publicados,
    limite: limite,
    puedePublicar: limite == null || publicados < limite,
  );
}

/// Por qué no se puede publicar ahora mismo.
enum MotivoDeBloqueo {
  /// Ya tiene tantos publicados como le permite su plan.
  cupoDelPlanLleno,
}

/// Si publicar este producto se puede, según lo que la app sabe HOY.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ESTO NO ES LA REGLA. ES EVITAR UN VIAJE QUE YA SABEMOS CÓMO TERMINA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La regla vive en el backend, con su cerrojo por vendedor, y ahí se queda:
/// un cliente modificado, uno viejo o dos peticiones a la vez chocan igual
/// contra el tope. Ver `LimiteDeCatalogo` del lado del servidor.
///
/// Lo que evita esta función es otra cosa: que el interruptor se mueva, la
/// persona lea «Publicado. Ya lo pueden comprar», y dos segundos después todo
/// se deshaga solo. Ese estado intermedio es una afirmación falsa sobre algo
/// que importa —si su producto está a la venta— sostenida durante segundos.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ⚠️ SI NO SABEMOS, NO SE BLOQUEA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Con `catalogo == null` —el listado todavía no llegó, o falló— devuelve
/// `null`: se deja pasar y decide el servidor.
///
/// Es deliberado y va en un solo sentido. Bloquear por un dato que no tenemos
/// le impediría publicar a alguien que sí puede, y sin forma de entender por
/// qué. Dejar pasar de más, en cambio, termina en el rechazo del backend, que
/// es exactamente lo que pasaba antes: molesto, no roto.
MotivoDeBloqueo? motivoParaNoPublicar({
  required EstadoDelCatalogo? catalogo,
  required String actual,
  required String nuevo,
}) {
  // Sólo publicar consume cupo. Pausar, archivar o guardar un borrador, no.
  if (nuevo != 'ACTIVE') return null;

  // Ya estaba publicado: republicarlo no ocupa un lugar nuevo. Sin esto,
  // guardar un cambio de precio con el catálogo lleno quedaría bloqueado.
  if (actual == 'ACTIVE') return null;

  if (catalogo == null) return null;
  if (catalogo.puedePublicar) return null;

  return MotivoDeBloqueo.cupoDelPlanLleno;
}

/// Qué se le dice a alguien que no puede publicar.
///
/// El número sale del catálogo que mandó el servidor. ⚠️ No se escribe el 3 en
/// ningún lado: el día que el plan Free permita otra cantidad, este texto ya
/// dice la nueva sin que nadie lo toque.
String mensajeDeBloqueo(MotivoDeBloqueo motivo, EstadoDelCatalogo? catalogo) {
  switch (motivo) {
    case MotivoDeBloqueo.cupoDelPlanLleno:
      final limite = catalogo?.limite;
      if (limite == null) {
        return 'Alcanzaste el límite de productos publicados de tu plan Free. '
            'Pausá uno para publicar otro.';
      }
      return 'Alcanzaste el límite de $limite productos publicados de tu plan Free. '
          'Pausá uno para publicar otro.';
  }
}
