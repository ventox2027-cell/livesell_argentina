import 'seller_models.dart';

/// Los productos que se están borrando en este momento.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL PROBLEMA: BORRAR TARDA CUATRO SEGUNDOS EN VERSE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono: se toca «Borrar», se confirma, y no pasa nada durante
/// unos cuatro segundos. El editor sigue abierto, con el producto y el botón
/// que ya se tocó.
///
/// Son DOS viajes a Railway, uno detrás del otro:
///
///   1. `DELETE /products/:id` — el editor lo espera antes de cerrarse.
///   2. `GET /products/mine`   — al volver, Mi tienda invalida su listado, que
///                               queda en `loading` y muestra el spinner.
///
/// Con ~650 ms de latencia a la base, más el trabajo del backend, eso es lo que
/// se siente. Y en el medio no hay ninguna señal de que algo esté pasando: la
/// lectura natural es que el botón no funcionó.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE HACE: TOCAR EL CONTADOR DEL PLAN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es tentador restarle uno a «3 de 3 productos publicados» al mismo tiempo que
/// se esconde la fila. No se hace.
///
/// Ese número es una regla de negocio que vive en el servidor —ver
/// [EstadoDelCatalogo]—, y una resta hecha acá sería una segunda verdad. El día
/// que difiera, le mostraría al vendedor un cupo que no tiene, y el error
/// aparecería recién al intentar publicar.
///
/// La fila desaparece al instante; el contador espera el número real, que llega
/// enseguida porque la reconciliación sale apenas el servidor confirma.
class BorradosEnCurso {
  const BorradosEnCurso({this.ids = const {}, this.fallo});

  /// Los ids que ya no se muestran, mientras el servidor confirma.
  final Set<String> ids;

  /// El último borrado que no se pudo hacer, hasta que alguien lo cuenta.
  ///
  /// Vive acá y no en la pantalla del editor porque el editor **ya se cerró**:
  /// esa es toda la idea. Quien avisa es Mi tienda, que sí sigue a la vista.
  final FalloDeBorrado? fallo;

  bool contiene(String id) => ids.contains(id);

  BorradosEnCurso empezando(String id) =>
      BorradosEnCurso(ids: {...ids, id}, fallo: fallo);

  BorradosEnCurso terminando(String id) =>
      BorradosEnCurso(ids: {...ids}..remove(id), fallo: fallo);

  BorradosEnCurso conFallo(FalloDeBorrado f) => BorradosEnCurso(ids: ids, fallo: f);

  BorradosEnCurso sinFallo() => BorradosEnCurso(ids: ids);
}

/// Un borrado que el servidor rechazó, o que no llegó.
class FalloDeBorrado {
  const FalloDeBorrado({required this.productId, required this.nombre, required this.error});

  final String productId;

  /// Para poder decir QUÉ producto volvió, y no «algo falló».
  final String nombre;

  final Object error;
}

/// El listado como se ve, sin los que se están borrando.
///
/// ⚠️ `nextCursor` y `catalogo` se conservan tal cual. El cursor sigue siendo el
/// del servidor —esconder una fila no mueve la paginación— y el catálogo es el
/// conteo real, que no se toca por lo dicho arriba.
Pagina<Producto> sinLosQueSeBorran(Pagina<Producto> pagina, BorradosEnCurso borrados) {
  if (borrados.ids.isEmpty) return pagina;

  return Pagina(
    items: pagina.items.where((p) => !borrados.contiene(p.id)).toList(),
    nextCursor: pagina.nextCursor,
    catalogo: pagina.catalogo,
  );
}
