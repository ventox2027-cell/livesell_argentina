import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/schedule_api.dart';
import '../domain/schedule_models.dart';

/// Cuándo está abierta la tienda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// CERRAR NO ES DESAPARECER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Una tienda cerrada **sigue siendo visitable**: el catálogo se ve, los precios
/// se ven, y quien quiera puede dejar su interés en un producto. Lo único que no
/// se puede es reservar y pagar.
///
/// Esa diferencia es el negocio. Si cerrar escondiera la tienda, todo el tráfico
/// de la madrugada —que en una app de video es mucho— se perdería sin dejar
/// rastro. Así queda una lista de gente esperando a que abras.
///
/// ─── Se edita local y se guarda entero ───
///
/// Los cambios se acumulan en memoria y se mandan de una vez. Guardar en cada
/// toque haría una petición por cada minuto que se corre un horario, y dejaría
/// la tienda abierta a horas intermedias que nadie eligió.
class ScheduleScreen extends ConsumerStatefulWidget {
  const ScheduleScreen({super.key});

  @override
  ConsumerState<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends ConsumerState<ScheduleScreen> {
  HorarioDeTienda? _borrador;
  bool _guardando = false;

  /// Rellena el borrador la primera vez. Después manda lo que se editó.
  void _sembrar(HorarioDeTienda h) {
    _borrador ??= h;
  }

  Future<void> _guardar() async {
    final borrador = _borrador;
    if (borrador == null || _guardando) return;

    // El backend rechaza una franja de duración cero; se corta acá para que el
    // error se vea donde se cometió y no como un 400 genérico.
    final invalida = borrador.franjas.any((f) => f.abreMinutos == f.cierraMinutos);
    if (invalida) {
      AppSnack.error(context, 'Hay una franja que abre y cierra en el mismo minuto.');
      return;
    }

    setState(() => _guardando = true);
    try {
      final guardado = await ref.read(scheduleApiProvider).guardar(borrador);
      if (!mounted) return;

      setState(() => _borrador = guardado);
      // El perfil público muestra el estado de apertura: si no se invalida,
      // seguiría diciendo "abierta" después de haberla cerrado.
      ref.invalidate(miHorarioProvider);
      AppSnack.exito(context, 'Horario guardado');
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos guardar el horario');
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  void _agregarFranja(int dia) {
    final b = _borrador;
    if (b == null) return;
    setState(() {
      _borrador = b.copiaCon(
        franjas: [
          ...b.franjas,
          // 9 a 18: el horario comercial por defecto en Argentina. Se puede
          // cambiar en dos toques, y es mejor que arrancar en 00:00–00:00, que
          // además es una franja que el backend rechaza.
          FranjaHoraria(dia: dia, abreMinutos: 540, cierraMinutos: 1080),
        ],
      );
    });
  }

  void _quitarFranja(FranjaHoraria f) {
    final b = _borrador;
    if (b == null) return;
    setState(() {
      _borrador = b.copiaCon(
        franjas: b.franjas.where((x) => !identical(x, f)).toList(),
      );
    });
  }

  Future<void> _editarHora(FranjaHoraria f, {required bool esApertura}) async {
    final b = _borrador;
    if (b == null) return;

    final actual = esApertura ? f.abreMinutos : f.cierraMinutos;
    final elegida = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: actual ~/ 60, minute: actual % 60),
      // 24 horas: en Argentina nadie escribe "6 PM", y el selector de 12 horas
      // agrega un paso —elegir AM/PM— que se equivoca seguido.
      builder: (ctx, hijo) => MediaQuery(
        data: MediaQuery.of(ctx).copyWith(alwaysUse24HourFormat: true),
        child: hijo!,
      ),
    );
    if (elegida == null || !mounted) return;

    final minutos = elegida.hour * 60 + elegida.minute;
    setState(() {
      _borrador = b.copiaCon(
        franjas: [
          for (final x in b.franjas)
            identical(x, f)
                ? (esApertura
                    ? x.copiaCon(abreMinutos: minutos)
                    : x.copiaCon(cierraMinutos: minutos))
                : x,
        ],
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final horario = ref.watch(miHorarioProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Horarios')),
      body: horario.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => Center(
          child: Padding(
            padding: const EdgeInsets.all(Gap.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('No pudimos cargar el horario'),
                const SizedBox(height: Gap.lg),
                FilledButton(
                  onPressed: () => ref.invalidate(miHorarioProvider),
                  child: const Text('Reintentar'),
                ),
              ],
            ),
          ),
        ),
        data: (h) {
          _sembrar(h);
          final b = _borrador!;

          return ListView(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxxl),
            children: [
              if (b.abiertaAhora != null) _EstadoActual(horario: b),
              const SizedBox(height: Gap.xl),

              const Text(
                '¿Cuándo se puede comprar?',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: Gap.md),

              _OpcionDeModo(
                modo: ModoDeApertura.alwaysOpen,
                elegido: b.modo,
                titulo: 'Siempre abierta',
                detalle: 'Se puede comprar a cualquier hora, todos los días.',
                onElegir: (m) => setState(() => _borrador = b.copiaCon(modo: m)),
              ),
              _OpcionDeModo(
                modo: ModoDeApertura.scheduled,
                elegido: b.modo,
                titulo: 'Por horarios',
                detalle: 'Sólo en las franjas que cargues abajo.',
                onElegir: (m) => setState(() => _borrador = b.copiaCon(modo: m)),
              ),
              _OpcionDeModo(
                modo: ModoDeApertura.liveOnly,
                elegido: b.modo,
                titulo: 'Sólo durante mis vivos',
                detalle: 'Se abre al salir al aire y se cierra al terminar.',
                onElegir: (m) => setState(() => _borrador = b.copiaCon(modo: m)),
              ),

              if (b.modo == ModoDeApertura.scheduled) ...[
                const SizedBox(height: Gap.xl),
                const Text(
                  'Franjas',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: Gap.xs),
                Text(
                  'Hora de ${b.zona.split('/').last.replaceAll('_', ' ')}. '
                  'Si el cierre es anterior a la apertura, la franja cruza la medianoche.',
                  style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
                ),
                const SizedBox(height: Gap.md),

                for (var dia = 0; dia < 7; dia++)
                  _Dia(
                    dia: dia,
                    franjas: b.franjas.where((f) => f.dia == dia).toList(),
                    onAgregar: () => _agregarFranja(dia),
                    onQuitar: _quitarFranja,
                    onEditar: _editarHora,
                  ),
              ],

              const SizedBox(height: Gap.xl),
              FilledButton(
                onPressed: _guardando ? null : () => unawaited(_guardar()),
                style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                child: _guardando
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Guardar horario'),
              ),

              const SizedBox(height: Gap.md),
              const Text(
                'Con la tienda cerrada, el catálogo se sigue viendo y la gente '
                'puede dejar su interés. No se pierde la visita.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _EstadoActual extends StatelessWidget {
  const _EstadoActual({required this.horario});
  final HorarioDeTienda horario;

  @override
  Widget build(BuildContext context) {
    final abierta = horario.abiertaAhora ?? true;
    final color = abierta ? AppColor.exito : AppColor.textoSuave;

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(
            abierta ? Icons.storefront_rounded : Icons.nightlight_round,
            size: 20,
            color: color,
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  abierta ? 'Ahora estás abierta' : 'Ahora estás cerrada',
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: color),
                ),
                if (horario.motivo.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(
                    horario.motivo,
                    style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _OpcionDeModo extends StatelessWidget {
  const _OpcionDeModo({
    required this.modo,
    required this.elegido,
    required this.titulo,
    required this.detalle,
    required this.onElegir,
  });

  final ModoDeApertura modo;
  final ModoDeApertura elegido;
  final String titulo;
  final String detalle;
  final ValueChanged<ModoDeApertura> onElegir;

  @override
  Widget build(BuildContext context) {
    final activo = modo == elegido;

    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm),
      child: InkWell(
        onTap: () => onElegir(modo),
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.all(Gap.md),
          decoration: BoxDecoration(
            color: activo ? AppColor.acento.withValues(alpha: 0.1) : AppColor.superficie,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(color: activo ? AppColor.acento : AppColor.borde),
          ),
          child: Row(
            children: [
              Icon(
                activo ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                size: 20,
                color: activo ? AppColor.acento : AppColor.textoDebil,
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      titulo,
                      style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      detalle,
                      style: const TextStyle(
                        fontSize: 12.5,
                        color: AppColor.textoSuave,
                        height: 1.35,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Dia extends StatelessWidget {
  const _Dia({
    required this.dia,
    required this.franjas,
    required this.onAgregar,
    required this.onQuitar,
    required this.onEditar,
  });

  final int dia;
  final List<FranjaHoraria> franjas;
  final VoidCallback onAgregar;
  final void Function(FranjaHoraria) onQuitar;
  final Future<void> Function(FranjaHoraria, {required bool esApertura}) onEditar;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm),
      child: Container(
        padding: const EdgeInsets.all(Gap.md),
        decoration: BoxDecoration(
          color: AppColor.superficie,
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
                    nombresDeDia[dia],
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                  ),
                ),
                if (franjas.isEmpty)
                  const Text(
                    'Cerrado',
                    style: TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
                  ),
                IconButton(
                  onPressed: onAgregar,
                  icon: const Icon(Icons.add_rounded, size: 20),
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Agregar franja',
                ),
              ],
            ),
            for (final f in franjas)
              Padding(
                padding: const EdgeInsets.only(top: Gap.xs),
                child: Row(
                  children: [
                    _Hora(
                      texto: comoHora(f.abreMinutos),
                      onTap: () => unawaited(onEditar(f, esApertura: true)),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: Gap.sm),
                      child: Text('a', style: TextStyle(color: AppColor.textoSuave)),
                    ),
                    _Hora(
                      texto: comoHora(f.cierraMinutos),
                      onTap: () => unawaited(onEditar(f, esApertura: false)),
                    ),
                    if (f.cruzaMedianoche)
                      const Padding(
                        padding: EdgeInsets.only(left: Gap.sm),
                        child: Text(
                          'del día siguiente',
                          style: TextStyle(fontSize: 11.5, color: AppColor.alerta),
                        ),
                      ),
                    const Spacer(),
                    IconButton(
                      onPressed: () => onQuitar(f),
                      icon: const Icon(Icons.delete_outline_rounded, size: 19),
                      color: AppColor.textoSuave,
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Quitar',
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Hora extends StatelessWidget {
  const _Hora({required this.texto, required this.onTap});

  final String texto;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.sm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: 6),
        decoration: BoxDecoration(
          color: AppColor.superficieAlta,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Text(
          texto,
          style: const TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            fontFeatures: [FontFeature.tabularFigures()],
          ),
        ),
      ),
    );
  }
}
