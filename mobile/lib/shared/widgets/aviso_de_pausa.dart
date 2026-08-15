import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/design/tokens.dart';
import '../../features/auth/data/auth_config.dart';
import '../../features/auth/data/banderas.dart';

/// El cartel que explica por qué algo está apagado.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// AVISAR ANTES, NO DESPUÉS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend rechaza igual con un 503, así que esto no es la regla. Existe
/// para no dejar que alguien elija la variante, cargue la dirección, elija el
/// envío y recién en el último toque se entere de que las compras están
/// pausadas.
///
/// Se renderiza a nada cuando la bandera está encendida, que es siempre salvo
/// en una emergencia. No ocupa espacio ni agrega una petición: la config ya se
/// pide al arrancar para el login.
class AvisoDePausa extends ConsumerWidget {
  const AvisoDePausa({super.key, required this.mostrarSi, required this.texto});

  /// Qué bandera mirar. `(b) => !b.checkout`, por ejemplo.
  final bool Function(Banderas) mostrarSi;
  final String texto;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // `valueOrNull` y no `when`: si la config todavía no llegó, no se muestra
    // nada. Un cartel de "pausado" que aparece por un instante mientras carga
    // asusta más de lo que informa.
    final config = ref.watch(authConfigProvider).valueOrNull;
    if (config == null || !mostrarSi(config.banderas)) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(bottom: Gap.md),
      padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.sm),
      decoration: BoxDecoration(
        color: AppColor.superficieAlta,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          const Icon(Icons.pause_circle_outline_rounded, size: 20, color: AppColor.alerta),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              texto,
              style: const TextStyle(fontSize: 13, height: 1.35, color: AppColor.textoSuave),
            ),
          ),
        ],
      ),
    );
  }
}

/// ¿Está pausado esto?
///
/// Sirve para desactivar el botón además de mostrar el cartel. Las dos cosas
/// juntas: el cartel solo deja un botón activo que va a fallar, y el botón gris
/// solo no dice por qué.
bool pausado(WidgetRef ref, bool Function(Banderas) cual) {
  final config = ref.watch(authConfigProvider).valueOrNull;
  if (config == null) return false;
  return cual(config.banderas);
}
