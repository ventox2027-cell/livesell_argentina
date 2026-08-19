import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'errores_de_red.dart';
import 'reconexion.dart';

/// Envuelve el estado de error de una pantalla y lo recarga cuando vuelve la red.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTO VIVE EN EL WIDGET DE ERROR Y NO EN UN SERVICIO CENTRAL
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «No disparar veinte peticiones simultáneas al reconectar» no se resuelve con
/// una cola ni con un límite de concurrencia. Se resuelve no pidiéndolas.
///
/// Este widget existe **sólo mientras la pantalla está mostrando el error**. Si
/// una pantalla cargó bien y quedó en caché, acá no hay nada montado y no se
/// pide nada. Si hay tres pantallas en la pila y sólo una falló, se recarga esa
/// una. La cuenta de peticiones al volver la red es, exactamente, la cantidad de
/// pantallas rotas que hay a la vista.
///
/// ─── Lo mismo vale para las mutaciones ───
///
/// Una mutación en vuelo —publicar un producto, ajustar stock— no pasa por acá y
/// no se reintenta sola. Es deliberado: reintentar un `POST` sin saber si el
/// servidor llegó a procesarlo es cómo se crean productos duplicados. Los
/// reintentos automáticos son sólo de lectura.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SÓLO SI EL ERROR ERA DE RED
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un 409 no se arregla porque vuelva el wifi. Si el error no es de red, este
/// widget se limita a mostrar el hijo y ni siquiera se suscribe.
class ReintentarAlVolverLaRed extends ConsumerStatefulWidget {
  const ReintentarAlVolverLaRed({
    required this.error,
    required this.onReintentar,
    required this.child,
    super.key,
  });

  /// El error que está mostrando la pantalla.
  ///
  /// Decide si se reintenta solo o no. Se pide el error entero y no un `bool`
  /// para que la decisión la tome [esFalloDeRed] en un solo lugar y no la
  /// reimplemente cada pantalla a su manera.
  final Object? error;

  /// Volver a cargar. Casi siempre un `ref.invalidate(...)`.
  final VoidCallback onReintentar;

  /// Lo que se ve: el estado de error propio de cada pantalla, con su botón.
  final Widget child;

  @override
  ConsumerState<ReintentarAlVolverLaRed> createState() => _ReintentarAlVolverLaRedState();
}

/// Cuánto se espera para dar por fallado un reintento automático.
///
/// Si pasado este rato el widget de error SIGUE montado, es que la recarga no
/// funcionó: la red decía estar y todavía no pasaba tráfico. Ahí se pide otro
/// aviso, que llegará más tarde que el anterior.
///
/// No hay callback de «falló» porque no hace falta inventarlo: que este widget
/// siga vivo ya es la señal.
const graciaDelReintento = Duration(seconds: 4);

class _ReintentarAlVolverLaRedState extends ConsumerState<ReintentarAlVolverLaRed> {
  Timer? _revision;

  @override
  void dispose() {
    _revision?.cancel();
    super.dispose();
  }

  void _reintentar() {
    widget.onReintentar();

    _revision?.cancel();
    _revision = Timer(graciaDelReintento, () {
      // Seguimos montados: la pantalla nunca salió del error.
      if (!mounted) return;
      ref.read(reconexionProvider.notifier).volveAAvisar();
    });
  }

  @override
  Widget build(BuildContext context) {
    if (esFalloDeRed(widget.error ?? '')) {
      // `listen` y no `watch`: lo que importa es el cambio, no el valor. Con
      // `watch` esto se reconstruiría y no reintentaría nada.
      ref.listen<int>(reconexionProvider, (_, __) => _reintentar());
    }
    return widget.child;
  }
}
