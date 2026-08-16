import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../design/tokens.dart';
import 'push_service.dart';

/// Cuándo se pide el permiso de notificaciones.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA PRIMERA VEZ ES LA ÚNICA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// En Android 13+ el diálogo del sistema se muestra una sola vez de verdad. Si
/// la persona dice que no, no vuelve a aparecer nunca más: hay que mandarla a
/// los ajustes del teléfono a buscarlo, y casi nadie lo hace.
///
/// O sea que ese diálogo es un recurso que se gasta una vez. Mostrarlo en el
/// arranque —cuando todavía no sabe qué es esta app— lo convierte en un «no»
/// casi seguro, y de paso apaga los avisos de pedidos, que son los que
/// importan.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE PIDE DESPUÉS DE LA PRIMERA COMPRA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es el único momento en que un aviso significa algo concreto y esperado:
/// acaba de pagar y quiere saber cuándo sale su pedido. La pregunta se explica
/// sola.
///
/// Y antes del diálogo del sistema va uno nuestro, que se puede rechazar sin
/// consecuencias. Es la diferencia entre gastar el permiso y conservarlo: si
/// dice «ahora no» en el nuestro, el del sistema no se muestra y se puede
/// volver a preguntar la próxima vez.

const _kYaSePregunto = 'push.yaSePregunto';

/// Si ya se mostró el cartel propio alguna vez.
Future<bool> yaSePreguntoPorAvisos() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getBool(_kYaSePregunto) ?? false;
}

/// Pregunta por los avisos, si corresponde.
///
/// No hace nada si ya se preguntó antes o si Firebase no está disponible en
/// este binario. Devuelve si quedaron activados.
///
/// Se llama después de una compra confirmada. Ver `checkout_sheet.dart`.
Future<bool> ofrecerAvisosTrasComprar(BuildContext context) async {
  if (!PushService.instance.disponible) return false;
  if (await yaSePreguntoPorAvisos()) return false;
  if (!context.mounted) return false;

  final quiere = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: AppColor.superficie,
    builder: (_) => const _CartelDeAvisos(),
  );

  /**
   * Se marca como preguntado en los dos casos.
   *
   * También cuando dice que no: volver a ofrecerlo en cada compra es
   * exactamente lo que hace que alguien desinstale. Si después los quiere, los
   * activa desde su perfil.
   */
  final prefs = await SharedPreferences.getInstance();
  await prefs.setBool(_kYaSePregunto, true);

  if (quiere != true) return false;

  return PushService.instance.pedirPermisoYRegistrar();
}

class _CartelDeAvisos extends StatelessWidget {
  const _CartelDeAvisos();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.notifications_active_outlined, size: 34, color: AppColor.acento),
            const SizedBox(height: Gap.lg),
            const Text(
              '¿Te avisamos cuando salga tu pedido?',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, height: 1.25),
            ),
            const SizedBox(height: Gap.sm),
            /**
             * Se dice EXACTAMENTE para qué, y nada más.
             *
             * Nada de «enterate de las novedades». Alguien que acepta esperando
             * avisos de su pedido y recibe promociones apaga todo, y ahí se
             * pierden también los que importan.
             */
            const Text(
              'Sólo para lo tuyo: cuando el vendedor lo prepare, cuando lo '
              'despache y cuando se acredite el pago. Nada de promociones.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.45),
            ),
            const SizedBox(height: Gap.xl),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              style: FilledButton.styleFrom(minimumSize: const Size(0, 50)),
              child: const Text('Sí, avisame'),
            ),
            const SizedBox(height: Gap.xs),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Ahora no'),
            ),
          ],
        ),
      ),
    );
  }
}
