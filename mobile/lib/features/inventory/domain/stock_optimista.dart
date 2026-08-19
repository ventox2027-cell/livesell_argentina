import 'inventory_models.dart';

/// El stock que se VE, mezclando lo del servidor con lo que el dedo acaba de
/// tocar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BUG: LA MISMA PANTALLA SE CONTRADECÍA A SÍ MISMA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El contador de una variante ya mostraba 14 mientras el resumen de arriba
/// seguía diciendo «Total 9 · Disponibles 9», y así se quedaba hasta que el
/// servidor contestara — con Railway y Neon en regiones distintas, un par de
/// segundos largos.
///
/// La causa era estructural, no un refresco que faltaba: el resumen leía los
/// datos del servidor y cada fila su propio estado local. **Dos fuentes de
/// verdad dentro de la misma pantalla.**
///
/// Este objeto es la única. El resumen y las filas leen de acá, así que no
/// pueden discrepar aunque alguien se olvide de refrescar algo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE ES OPTIMISTA Y LO QUE NO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// **`onHand` sí.** Es lo único que el vendedor edita, y es un ajuste relativo
/// que PostgreSQL aplica de forma atómica: adelantarse a mostrarlo no puede
/// contradecir al servidor en el resultado final.
///
/// **`reserved` NUNCA.** Las reservas son de los compradores y cambian por su
/// cuenta mientras el vendedor mira la pantalla. Inventar una disponibilidad
/// mayor que la real haría que el vendedor crea que puede vender algo que otro
/// ya tiene apartado.
///
/// Por eso `disponible` se calcula como `onHand mostrado − reserved DEL
/// SERVIDOR`: se adelanta lo que el vendedor hizo, no lo que hicieron otros.
class StockOptimista {
  const StockOptimista({required this.delServidor, this.ajustes = const {}});

  /// La última respuesta del servidor. La autoridad.
  final StockProducto delServidor;

  /// `variantId → onHand que se está mostrando`. Sólo las que se tocaron.
  final Map<String, int> ajustes;

  bool get hayAjustes => ajustes.isNotEmpty;

  /// Las variantes tal como se ven.
  ///
  /// `reserved` intacto. `available` recalculado con el `onHand` mostrado y
  /// clampeado en cero: con tres unidades reservadas y el vendedor bajando a
  /// cero, «-3 disponibles» no significa nada para nadie.
  List<StockVariante> get variantes => delServidor.variants.map((v) {
        final mostrado = ajustes[v.variantId];
        if (mostrado == null) return v;

        return StockVariante(
          variantId: v.variantId,
          title: v.title,
          onHand: mostrado,
          reserved: v.reserved,
          available: mostrado - v.reserved < 0 ? 0 : mostrado - v.reserved,
          inventoryId: v.inventoryId,
          status: v.status,
          isDefault: v.isDefault,
          lowStockThreshold: v.lowStockThreshold,
        );
      }).toList();

  int onHandDe(String variantId) =>
      ajustes[variantId] ??
      delServidor.variants
          .firstWhere(
            (v) => v.variantId == variantId,
            orElse: () => const StockVariante(
              variantId: '',
              title: '',
              onHand: 0,
              reserved: 0,
              available: 0,
            ),
          )
          .onHand;

  /// Lo que muestra el resumen de arriba. Los mismos números que las filas.
  int get totalOnHand => variantes.fold(0, (s, v) => s + v.onHand);
  int get totalReservado => variantes.fold(0, (s, v) => s + v.reserved);
  int get totalDisponible => variantes.fold(0, (s, v) => s + v.available);

  bool get esSimple => delServidor.esSimple;

  /// Con un toque aplicado sobre una variante.
  StockOptimista conAjuste(String variantId, int onHand) =>
      StockOptimista(delServidor: delServidor, ajustes: {...ajustes, variantId: onHand});

  /// Sin el ajuste de una variante: volvió a mandar el servidor.
  ///
  /// Se usa al fallar una petición y al llegar datos nuevos. No se limpian
  /// TODOS los ajustes: otra variante puede tener toques en vuelo, y borrarlos
  /// haría saltar su número hacia atrás por un error que no era suyo.
  StockOptimista sinAjuste(String variantId) {
    final resto = {...ajustes}..remove(variantId);
    return StockOptimista(delServidor: delServidor, ajustes: resto);
  }

  /// Llegaron datos nuevos del servidor.
  ///
  /// ⚠️ Se conservan los ajustes de las variantes que TODAVÍA tienen trabajo
  /// pendiente. Sin eso, la respuesta de una petición anterior pisaría los
  /// toques que la persona dio mientras esa petición viajaba, y el número
  /// saltaría hacia atrás bajo el dedo.
  StockOptimista conDatosDelServidor(
    StockProducto nuevo,
    bool Function(String variantId) sigueEnCurso,
  ) {
    final conservados = {
      for (final e in ajustes.entries)
        if (sigueEnCurso(e.key)) e.key: e.value,
    };
    return StockOptimista(delServidor: nuevo, ajustes: conservados);
  }
}
