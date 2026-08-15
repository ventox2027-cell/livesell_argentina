import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/domain/session.dart';
import '../../auth/state/auth_providers.dart';

/// Hoja para completar el perfil.
///
/// Se abre desde donde haga falta el dato, no desde un menú de configuración.
/// El momento correcto para pedir un teléfono es cuando la persona ya decidió
/// comprar: ahí tiene un motivo para darlo.
class CompleteProfileSheet extends ConsumerStatefulWidget {
  const CompleteProfileSheet({super.key});

  static Future<void> mostrar(BuildContext context, WidgetRef ref) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const CompleteProfileSheet(),
    );
  }

  @override
  ConsumerState<CompleteProfileSheet> createState() => _CompleteProfileSheetState();
}

class _CompleteProfileSheetState extends ConsumerState<CompleteProfileSheet> {
  late final TextEditingController _nombre;
  late final TextEditingController _apellido;
  late final TextEditingController _telefono;
  late bool _whatsapp;

  bool _guardando = false;

  @override
  void initState() {
    super.initState();
    final u = ref.read(usuarioProvider);
    _nombre = TextEditingController(text: u?.firstName == 'Sin nombre' ? '' : u?.firstName ?? '');
    _apellido = TextEditingController(text: u?.lastName ?? '');
    _telefono = TextEditingController(text: u?.phone ?? '');
    _whatsapp = u?.whatsappOptIn ?? true;
  }

  @override
  void dispose() {
    _nombre.dispose();
    _apellido.dispose();
    _telefono.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (_guardando) return;
    setState(() => _guardando = true);

    try {
      await ref.read(sesionProvider.notifier).completarPerfil(
            firstName: _nombre.text.trim().isEmpty ? null : _nombre.text.trim(),
            lastName: _apellido.text.trim().isEmpty ? null : _apellido.text.trim(),
            phone: _telefono.text.trim().isEmpty ? null : _telefono.text.trim(),
            whatsappOptIn: _whatsapp,
          );
      if (!mounted) return;
      Navigator.pop(context);
      AppSnack.exito(context, 'Listo, guardamos tus datos.');
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final falta = switch (ref.watch(sesionProvider)) {
      ConSesion(faltantes: final f) => f,
      _ => const <DatoFaltante>[],
    };

    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.sm,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Tus datos', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: Gap.sm),
            Text(
              falta.contains(DatoFaltante.telefono)
                  ? 'Necesitamos un teléfono para avisarte cuando salga tu pedido y '
                      'para que el vendedor pueda coordinar la entrega.'
                  : 'Estos datos los ve el vendedor cuando le comprás.',
              style: const TextStyle(color: AppColor.textoSuave, fontSize: 13.5, height: 1.45),
            ),
            const SizedBox(height: Gap.xl),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _nombre,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(labelText: 'Nombre'),
                  ),
                ),
                const SizedBox(width: Gap.md),
                Expanded(
                  child: TextField(
                    controller: _apellido,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(labelText: 'Apellido'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: Gap.md),
            TextField(
              controller: _telefono,
              keyboardType: TextInputType.phone,
              // Se aceptan espacios, guiones y paréntesis: la gente escribe el
              // teléfono como quiere, y el backend lo normaliza a E.164.
              // Rechazar el formato acá sería pelearse con quien quiere comprar.
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+\-\s()]'))],
              decoration: const InputDecoration(
                labelText: 'Teléfono',
                hintText: '11 5555 6666',
                helperText: 'Con característica, sin el 0 ni el 15',
              ),
            ),
            const SizedBox(height: Gap.md),
            SwitchListTile.adaptive(
              value: _whatsapp,
              onChanged: (v) => setState(() => _whatsapp = v),
              contentPadding: EdgeInsets.zero,
              activeThumbColor: AppColor.acento,
              title: const Text('Avisos por WhatsApp', style: TextStyle(fontSize: 14.5)),
              subtitle: const Text(
                'Estado del pedido y coordinación de entrega',
                style: TextStyle(fontSize: 12, color: AppColor.textoSuave),
              ),
            ),
            const SizedBox(height: Gap.lg),
            FilledButton(
              onPressed: _guardando ? null : _guardar,
              child: _guardando
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Text('Guardar'),
            ),
          ],
        ),
      ),
    );
  }
}
