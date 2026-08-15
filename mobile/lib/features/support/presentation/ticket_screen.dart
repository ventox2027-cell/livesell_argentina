import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/soporte_api.dart';
import 'soporte_screen.dart' show EtiquetaDeEstado;

/// La conversación de un ticket.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SIEMPRE SE SABE QUIÉN CONTESTÓ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cada mensaje dice si lo escribió el asistente o una persona del equipo.
/// Nunca «VendoX» a secas, y nunca un nombre inventado.
///
/// No es cosmético: alguien que está preguntando por plata tiene derecho a
/// saber si le está contestando un modelo. Y cuando el ticket se escala, el
/// cambio se muestra explícitamente — es el momento en que la respuesta pasa a
/// tener a alguien atrás.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL ASISTENTE NO RESUELVE PLATA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Orienta, clasifica y escala. No devuelve dinero, no cancela pedidos, no
/// suspende cuentas. Eso lo garantiza el backend: hay una comprobación que
/// escala el ticket si la respuesta promete algo que no puede cumplir (ver
/// `escalada.ts`). La app no tiene forma de saltearlo porque no existe ningún
/// endpoint que lo permita.
class TicketScreen extends ConsumerStatefulWidget {
  const TicketScreen({super.key, required this.ticketId});
  final String ticketId;

  @override
  ConsumerState<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends ConsumerState<TicketScreen> {
  final _respuesta = TextEditingController();
  final _scroll = ScrollController();
  bool _enviando = false;

  @override
  void dispose() {
    _respuesta.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _responder() async {
    final texto = _respuesta.text.trim();
    if (texto.isEmpty || _enviando) return;

    setState(() => _enviando = true);

    try {
      await ref.read(soporteApiProvider).responder(widget.ticketId, texto);
      _respuesta.clear();
      ref.invalidate(ticketProvider(widget.ticketId));
    } on SoporteException catch (e) {
      if (mounted) AppSnack.error(context, e.mensaje);
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos enviar tu mensaje.');
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Future<void> _marcarResuelto() async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('¿Se resolvió?'),
        content: const Text(
          'Podés volver a escribir en esta conversación si el problema vuelve.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('No')),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Sí, se resolvió'),
          ),
        ],
      ),
    );

    if (confirmado != true) return;

    try {
      await ref.read(soporteApiProvider).marcarResuelto(widget.ticketId);
      ref.invalidate(ticketProvider(widget.ticketId));
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos actualizar la consulta.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ticket = ref.watch(ticketProvider(widget.ticketId));

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(
        title: const Text('Consulta'),
        actions: [
          if (ticket.valueOrNull?.estado == EstadoDelTicket.abierto ||
              ticket.valueOrNull?.estado == EstadoDelTicket.esperandoRespuesta)
            TextButton(
              onPressed: () => unawaited(_marcarResuelto()),
              child: const Text('Se resolvió'),
            ),
        ],
      ),
      body: ticket.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => _NoCargo(
          onReintentar: () => ref.invalidate(ticketProvider(widget.ticketId)),
        ),
        data: (t) => Column(
          children: [
            _Cabecera(ticket: t),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async => ref.invalidate(ticketProvider(widget.ticketId)),
                child: ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xl),
                  itemCount: t.mensajes.length,
                  itemBuilder: (_, i) => _Burbuja(mensaje: t.mensajes[i]),
                ),
              ),
            ),
            if (t.estado.admiteRespuesta)
              _Composer(
                controlador: _respuesta,
                enviando: _enviando,
                onEnviar: () => unawaited(_responder()),
              )
            else
              const _Cerrado(),
          ],
        ),
      ),
    );
  }
}

class _Cabecera extends StatelessWidget {
  const _Cabecera({required this.ticket});
  final Ticket ticket;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.md, Gap.xl, Gap.lg),
      decoration: const BoxDecoration(
        color: AppColor.superficie,
        border: Border(bottom: BorderSide(color: AppColor.borde)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            ticket.asunto,
            style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, height: 1.3),
          ),
          const SizedBox(height: Gap.sm),
          Row(
            children: [
              EtiquetaDeEstado(estado: ticket.estado),
              const SizedBox(width: Gap.sm),
              Text(
                ticket.categoria.texto,
                style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
              ),
            ],
          ),
          if (ticket.estado == EstadoDelTicket.escalado) ...[
            const SizedBox(height: Gap.md),
            /**
             * Se dice explícitamente que pasó a una persona.
             *
             * Es el cambio que más le importa a quien está esperando: deja de
             * contestar el asistente. Sin decirlo, el silencio mientras alguien
             * lo revisa se lee como que nadie lo está mirando.
             */
            Container(
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.info.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: const Row(
                children: [
                  Icon(Icons.person_outline_rounded, size: 17, color: AppColor.info),
                  SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(
                      'Lo está revisando alguien del equipo. Puede tardar un poco '
                      'más, pero lo mira una persona.',
                      style: TextStyle(fontSize: 12.5, height: 1.35),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Burbuja extends StatelessWidget {
  const _Burbuja({required this.mensaje});
  final MensajeDeSoporte mensaje;

  @override
  Widget build(BuildContext context) {
    final mio = mensaje.autor == AutorDelMensaje.yo;

    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.lg),
      child: Column(
        crossAxisAlignment: mio ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!mio) ...[
                Icon(
                  mensaje.autor == AutorDelMensaje.equipo
                      ? Icons.person_rounded
                      : Icons.smart_toy_outlined,
                  size: 13,
                  color: AppColor.textoDebil,
                ),
                const SizedBox(width: 4),
              ],
              Text(
                mensaje.autor.nombre,
                style: const TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w700,
                  color: AppColor.textoDebil,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.82,
            ),
            padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.md),
            decoration: BoxDecoration(
              color: mio ? AppColor.acento : AppColor.superficie,
              borderRadius: BorderRadius.circular(Redondeo.lg),
              border: mio ? null : Border.all(color: AppColor.borde),
            ),
            child: Text(
              mensaje.texto,
              style: TextStyle(
                fontSize: 14,
                height: 1.45,
                color: mio ? Colors.white : AppColor.texto,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controlador,
    required this.enviando,
    required this.onEnviar,
  });

  final TextEditingController controlador;
  final bool enviando;
  final VoidCallback onEnviar;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.all(Gap.md),
        decoration: const BoxDecoration(
          color: AppColor.superficie,
          border: Border(top: BorderSide(color: AppColor.borde)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: controlador,
                enabled: !enviando,
                maxLines: 4,
                minLines: 1,
                maxLength: 4000,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  hintText: 'Escribí tu respuesta',
                  counterText: '',
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: Gap.sm),
            IconButton.filled(
              onPressed: enviando ? null : onEnviar,
              icon: enviando
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send_rounded, size: 19),
            ),
          ],
        ),
      ),
    );
  }
}

/// Un ticket cerrado no se reabre: se abre uno nuevo.
///
/// Es la regla del backend, y la app la respeta escondiendo el campo en vez de
/// dejar que la persona escriba un mensaje entero y recién ahí falle.
class _Cerrado extends StatelessWidget {
  const _Cerrado();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(Gap.lg),
        decoration: const BoxDecoration(
          color: AppColor.superficie,
          border: Border(top: BorderSide(color: AppColor.borde)),
        ),
        child: const Text(
          'Esta consulta está cerrada. Si necesitás algo más, abrí una nueva.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: AppColor.textoSuave),
        ),
      ),
    );
  }
}

class _NoCargo extends StatelessWidget {
  const _NoCargo({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('No pudimos cargar la conversación.'),
          const SizedBox(height: Gap.md),
          FilledButton(onPressed: onReintentar, child: const Text('Reintentar')),
        ],
      ),
    );
  }
}
