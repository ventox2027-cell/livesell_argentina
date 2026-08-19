import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/network/reintentar_al_volver_la_red.dart';
import '../data/soporte_api.dart';
import 'nuevo_ticket_sheet.dart';
import 'ticket_screen.dart';

/// «Ayuda»: las conversaciones con soporte.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BACKEND YA ESTABA. ESTO ES LA PUERTA QUE FALTABA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Los tickets, la clasificación, el asistente y la escalada a una persona
/// funcionan desde hace rato. No había ninguna pantalla desde donde abrirlos:
/// alguien con un problema no tenía a dónde ir.
///
/// Este archivo no agrega reglas. Muestra lo que el servidor devuelve.
class SoporteScreen extends ConsumerWidget {
  const SoporteScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tickets = ref.watch(misTicketsProvider);

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Ayuda')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => unawaited(_abrirNuevo(context, ref)),
        backgroundColor: AppColor.acento,
        icon: const Icon(Icons.chat_bubble_outline_rounded),
        label: const Text('Nueva consulta', style: TextStyle(fontWeight: FontWeight.w700)),
      ),
      body: tickets.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, __) => ReintentarAlVolverLaRed(
          error: e,
          onReintentar: () => ref.invalidate(misTicketsProvider),
          child: _NoCargo(onReintentar: () => ref.invalidate(misTicketsProvider)),
        ),
        data: (lista) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(misTicketsProvider),
          child: lista.isEmpty
              ? const _Vacio()
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, 96),
                  itemCount: lista.length,
                  separatorBuilder: (_, __) => const SizedBox(height: Gap.sm),
                  itemBuilder: (_, i) => _FilaDeTicket(ticket: lista[i]),
                ),
        ),
      ),
    );
  }

  Future<void> _abrirNuevo(BuildContext context, WidgetRef ref) async {
    final creado = await NuevoTicketSheet.mostrar(context);
    if (creado == null || !context.mounted) return;

    ref.invalidate(misTicketsProvider);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => TicketScreen(ticketId: creado.id)),
    );
    ref.invalidate(misTicketsProvider);
  }
}

class _FilaDeTicket extends ConsumerWidget {
  const _FilaDeTicket({required this.ticket});
  final Ticket ticket;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Material(
      color: AppColor.superficie,
      borderRadius: BorderRadius.circular(Redondeo.md),
      child: InkWell(
        borderRadius: BorderRadius.circular(Redondeo.md),
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => TicketScreen(ticketId: ticket.id)),
          );
          ref.invalidate(misTicketsProvider);
        },
        child: Container(
          padding: const EdgeInsets.all(Gap.lg),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(color: AppColor.borde),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      ticket.asunto,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                    ),
                  ),
                  const SizedBox(width: Gap.sm),
                  EtiquetaDeEstado(estado: ticket.estado),
                ],
              ),
              const SizedBox(height: Gap.sm),
              Text(
                '${ticket.categoria.texto} · ${_cuandoFue(ticket.ultimoMensajeEl)}',
                style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// El estado, en el idioma de quien escribió.
///
/// ⚠️ Escalado es el único que se pinta distinto, y no es decoración: es el
/// único que cambia lo que la persona puede esperar. Deja de contestar el
/// asistente y pasa a contestar alguien del equipo, lo cual tarda más y
/// resuelve más.
class EtiquetaDeEstado extends StatelessWidget {
  const EtiquetaDeEstado({super.key, required this.estado});
  final EstadoDelTicket estado;

  @override
  Widget build(BuildContext context) {
    final (fondo, texto) = switch (estado) {
      EstadoDelTicket.escalado => (AppColor.info, AppColor.sobreCyan),
      EstadoDelTicket.resuelto => (AppColor.exito, AppColor.sobreLima),
      EstadoDelTicket.cerrado => (AppColor.inactivo, AppColor.textoSuave),
      _ => (AppColor.superficieAlta, AppColor.textoSuave),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Gap.sm, vertical: 3),
      decoration: BoxDecoration(
        color: fondo,
        borderRadius: BorderRadius.circular(Redondeo.pill),
      ),
      child: Text(
        estado.texto,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: texto),
      ),
    );
  }
}

class _Vacio extends StatelessWidget {
  const _Vacio();

  @override
  Widget build(BuildContext context) {
    // Va dentro de un ListView para que el "deslizar para actualizar" funcione
    // también cuando no hay nada: sin eso, la pantalla vacía se siente rota.
    return ListView(
      padding: const EdgeInsets.fromLTRB(Gap.xxl, 96, Gap.xxl, Gap.xxl),
      children: const [
        Icon(Icons.support_agent_rounded, size: 44, color: AppColor.textoDebil),
        SizedBox(height: Gap.lg),
        Text(
          'No tenés consultas abiertas',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        SizedBox(height: Gap.sm),
        Text(
          'Si algo salió mal con una compra, o no entendés cómo funciona algo, '
          'escribinos. Te contestamos acá mismo.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.45),
        ),
      ],
    );
  }
}

class _NoCargo extends StatelessWidget {
  const _NoCargo({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Gap.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'No pudimos cargar tus consultas.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14.5),
            ),
            const SizedBox(height: Gap.md),
            FilledButton(onPressed: onReintentar, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}

/// «hace 5 min», «ayer», «12 de agosto».
///
/// Sin librería de fechas: son cuatro casos y traer una dependencia entera para
/// esto agrega peso al binario por nada.
String _cuandoFue(DateTime fecha) {
  final minutos = DateTime.now().difference(fecha).inMinutes;

  if (minutos < 1) return 'recién';
  if (minutos < 60) return 'hace $minutos min';
  if (minutos < 60 * 24) {
    final horas = minutos ~/ 60;
    return 'hace $horas ${horas == 1 ? "hora" : "horas"}';
  }
  if (minutos < 60 * 48) return 'ayer';

  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  return '${fecha.day} de ${meses[fecha.month - 1]}';
}
