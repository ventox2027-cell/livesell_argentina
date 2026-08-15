import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../../shared/widgets/app_snack.dart';
import '../../../moderation/data/chat_moderacion_api.dart';
import '../../../moderation/presentation/reportar_sheet.dart';
import '../../data/live_realtime.dart';

/// Qué se puede hacer con un mensaje del chat.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE VE CADA UNO ES DISTINTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// · **Quien mira** puede reportar el mensaje y bloquear a quien lo escribió.
///   Nada más: no puede borrar el mensaje de otro ni callarlo, porque eso sería
///   darle poder de moderación sobre una sala ajena;
/// · **El vendedor**, en su vivo, además puede borrarlo y silenciar a esa
///   persona un rato. Es su espacio.
///
/// Ninguna de las dos cosas suspende a nadie ni es permanente. Suspender una
/// cuenta lo decide VendoX.
class AccionesDeMensaje extends ConsumerWidget {
  const AccionesDeMensaje({
    super.key,
    required this.mensaje,
    required this.liveSessionId,
    required this.soyElVendedor,
  });

  final MensajeDeChat mensaje;
  final String liveSessionId;
  final bool soyElVendedor;

  /// Devuelve `true` si el mensaje se borró y hay que sacarlo de la lista.
  static Future<bool> mostrar(
    BuildContext context, {
    required MensajeDeChat mensaje,
    required String liveSessionId,
    required bool soyElVendedor,
  }) async {
    final r = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: AppColor.superficie,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (_) => AccionesDeMensaje(
        mensaje: mensaje,
        liveSessionId: liveSessionId,
        soyElVendedor: soyElVendedor,
      ),
    );
    return r ?? false;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.sm),
            child: Text(
              // El mensaje, recortado, para que se sepa sobre cuál se está
              // actuando. En un chat rápido es fácil tocar el equivocado.
              '"${mensaje.texto}"',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13.5,
                color: AppColor.textoSuave,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
          const Divider(height: 1, color: AppColor.borde),

          ListTile(
            leading: const Icon(Icons.flag_outlined, color: AppColor.alerta),
            title: const Text('Reportar mensaje'),
            subtitle: const Text(
              'Lo revisa una persona de VendoX.',
              style: TextStyle(fontSize: 12.5),
            ),
            onTap: () async {
              Navigator.pop(context, false);
              await ReportarSheet.mostrar(
                context,
                targetType: 'CHAT_MESSAGE',
                targetId: mensaje.id,
              );
            },
          ),

          if (soyElVendedor) ...[
            ListTile(
              leading: const Icon(Icons.delete_outline_rounded, color: AppColor.error),
              title: const Text('Borrar del chat'),
              subtitle: const Text(
                'Deja de verse para todos.',
                style: TextStyle(fontSize: 12.5),
              ),
              onTap: () async {
                try {
                  await ref.read(chatModeracionApiProvider).borrarMensaje(
                        liveSessionId: liveSessionId,
                        mensajeId: mensaje.id,
                      );
                  if (context.mounted) Navigator.pop(context, true);
                } catch (_) {
                  if (context.mounted) {
                    Navigator.pop(context, false);
                    AppSnack.error(context, 'No pudimos borrarlo. Probá de nuevo.');
                  }
                }
              },
            ),
            ListTile(
              leading: const Icon(Icons.volume_off_rounded, color: AppColor.error),
              title: Text('Silenciar a ${mensaje.nombre}'),
              subtitle: const Text(
                'No va a poder escribir en este vivo por un rato.',
                style: TextStyle(fontSize: 12.5),
              ),
              onTap: () async {
                Navigator.pop(context, false);
                await _pedirMotivoYSilenciar(context, ref);
              },
            ),
          ],
        ],
      ),
    );
  }

  /// El motivo es obligatorio, y por eso se pide.
  ///
  /// Un silencio sin motivo no se puede revisar ni defender —ni ante quien
  /// reclama, ni ante el propio vendedor dentro de una semana—. El backend lo
  /// exige; pedirlo acá evita un error que la persona no entendería.
  Future<void> _pedirMotivoYSilenciar(BuildContext context, WidgetRef ref) async {
    final control = TextEditingController();

    final motivo = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: Text('Silenciar a ${mensaje.nombre}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'No va a poder escribir en este vivo durante 30 minutos. '
              'No se entera de quién lo silenció.',
              style: TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
            ),
            const SizedBox(height: Gap.lg),
            TextField(
              controller: control,
              autofocus: true,
              maxLength: 300,
              decoration: const InputDecoration(
                labelText: '¿Por qué?',
                hintText: 'Insultaba a otros compradores',
                counterText: '',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancelar')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, control.text.trim()),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Silenciar'),
          ),
        ],
      ),
    );

    if (motivo == null || motivo.length < 3 || !context.mounted) return;

    try {
      await ref.read(chatModeracionApiProvider).silenciar(
            liveSessionId: liveSessionId,
            userId: mensaje.userId,
            motivo: motivo,
          );
      if (context.mounted) AppSnack.info(context, 'Silenciado por 30 minutos.');
    } catch (_) {
      if (context.mounted) AppSnack.error(context, 'No pudimos silenciarlo.');
    }
  }
}
