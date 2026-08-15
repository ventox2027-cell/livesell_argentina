import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../data/soporte_api.dart';

/// Abrir una consulta.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA CATEGORÍA ES OPCIONAL, Y ES A PROPÓSITO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Si no la elige, el backend la deduce del texto. Obligar a clasificar antes
/// de contar el problema es pedirle a alguien frustrado que ordene su queja
/// antes de poder hacerla — y ahí es donde abandona.
///
/// La app **no adivina la categoría localmente**. Dos criterios de
/// clasificación que discrepan mandan el ticket a la cola equivocada, y el que
/// gana tiene que ser uno solo: el del servidor.
///
/// ─── El asunto también es opcional ───
///
/// Cuando no viene, el backend lo arma con la primera línea del mensaje. Sirve
/// para la lista y nadie lo extraña.
class NuevoTicketSheet extends ConsumerStatefulWidget {
  const NuevoTicketSheet({super.key, this.orderId, this.categoriaSugerida});

  /// Si se abre desde un pedido, viaja su id. El equipo lo necesita para no
  /// tener que pedírselo.
  final String? orderId;

  /// Preseleccionada cuando el contexto la hace obvia —desde un pedido, la
  /// consulta casi siempre es de ese pedido—. Se puede cambiar igual.
  final CategoriaDeTicket? categoriaSugerida;

  static Future<Ticket?> mostrar(
    BuildContext context, {
    String? orderId,
    CategoriaDeTicket? categoriaSugerida,
  }) {
    return showModalBottomSheet<Ticket>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: NuevoTicketSheet(orderId: orderId, categoriaSugerida: categoriaSugerida),
      ),
    );
  }

  @override
  ConsumerState<NuevoTicketSheet> createState() => _NuevoTicketSheetState();
}

class _NuevoTicketSheetState extends ConsumerState<NuevoTicketSheet> {
  final _asunto = TextEditingController();
  final _mensaje = TextEditingController();

  CategoriaDeTicket? _categoria;
  bool _enviando = false;
  String? _error;

  /// Si el error fue por el límite de peticiones.
  ///
  /// Cambia el botón: reintentar contra un límite sólo consume el próximo
  /// intento y hace que la persona crea que la app está rota.
  bool _esperar = false;

  @override
  void initState() {
    super.initState();
    _categoria = widget.categoriaSugerida;
  }

  @override
  void dispose() {
    _asunto.dispose();
    _mensaje.dispose();
    super.dispose();
  }

  Future<void> _enviar() async {
    final mensaje = _mensaje.text.trim();

    // El mismo mínimo que el backend. No es validación duplicada: es evitar un
    // viaje que ya sabemos que falla, y el que decide sigue siendo el servidor.
    if (mensaje.length < 5) {
      setState(() => _error = 'Contanos un poco más de qué se trata');
      return;
    }

    setState(() {
      _enviando = true;
      _error = null;
      _esperar = false;
    });

    try {
      final ticket = await ref.read(soporteApiProvider).abrir(
            mensaje: mensaje,
            asunto: _asunto.text,
            categoria: _categoria,
            orderId: widget.orderId,
          );
      if (mounted) Navigator.of(context).pop(ticket);
    } on SoporteException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.mensaje;
        _esperar = e.demasiadosIntentos;
        _enviando = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'No pudimos enviar tu consulta. Revisá tu conexión.';
        _enviando = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xl),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Contanos qué pasó',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              const Text(
                'Te contestamos acá mismo. Si hace falta, lo pasamos a alguien '
                'del equipo.',
                style: TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
              ),
              const SizedBox(height: Gap.xl),

              TextField(
                controller: _asunto,
                enabled: !_enviando,
                maxLength: 80,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: 'Asunto (opcional)',
                  hintText: 'No me llegó el pedido',
                  counterText: '',
                ),
              ),
              const SizedBox(height: Gap.lg),

              TextField(
                controller: _mensaje,
                enabled: !_enviando,
                maxLines: 6,
                minLines: 4,
                maxLength: 4000,
                decoration: InputDecoration(
                  labelText: 'Tu consulta',
                  alignLabelWithHint: true,
                  errorText: _error,
                  counterText: '',
                ),
              ),
              const SizedBox(height: Gap.lg),

              const Text(
                'Tema (opcional)',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: Gap.sm),
              Wrap(
                spacing: Gap.sm,
                runSpacing: Gap.sm,
                children: CategoriaDeTicket.values
                    .map(
                      (c) => ChoiceChip(
                        label: Text(c.texto),
                        selected: _categoria == c,
                        onSelected: _enviando
                            // Se puede deseleccionar: volver a «que lo decida el
                            // servidor» tiene que ser posible después de tocar.
                            ? null
                            : (sel) => setState(() => _categoria = sel ? c : null),
                      ),
                    )
                    .toList(),
              ),

              if (widget.orderId != null) ...[
                const SizedBox(height: Gap.lg),
                Container(
                  padding: const EdgeInsets.all(Gap.md),
                  decoration: BoxDecoration(
                    color: AppColor.superficieAlta,
                    borderRadius: BorderRadius.circular(Redondeo.md),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.receipt_long_outlined, size: 17, color: AppColor.textoSuave),
                      SizedBox(width: Gap.sm),
                      Expanded(
                        child: Text(
                          'Vamos a ver los datos de este pedido junto a tu consulta.',
                          style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: Gap.xl),
              FilledButton(
                // Contra un límite de peticiones el botón se apaga: reintentar
                // sólo consume el próximo intento.
                onPressed: _enviando || _esperar ? null : _enviar,
                style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                child: _enviando
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(_esperar ? 'Probá en un rato' : 'Enviar consulta'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
