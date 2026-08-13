import 'package:flutter/material.dart';

import '../../core/design/tokens.dart';

/// Pantalla de módulo todavía no construido.
///
/// ─── Por qué no queda en blanco ───
///
/// Una pantalla vacía no dice nada: quien la abre no sabe si está rota, si
/// está cargando, o si falta. Ésta dice exactamente qué va a haber ahí y en
/// qué módulo del plan está — que es la información que uno quiere cuando
/// prueba la app a medio construir.
class Proximamente extends StatelessWidget {
  const Proximamente({
    super.key,
    required this.titulo,
    required this.icono,
    required this.descripcion,
    required this.modulo,
    this.puntos = const [],
  });

  final String titulo;
  final IconData icono;
  final String descripcion;

  /// Módulo del orden de trabajo que lo trae. Ubica al que está probando.
  final String modulo;

  /// Qué va a poder hacer acá.
  final List<String> puntos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(titulo)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.xl, Gap.xl, 100),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    color: AppColor.superficie,
                    borderRadius: BorderRadius.circular(Redondeo.lg),
                    border: Border.all(color: AppColor.borde),
                  ),
                  child: Icon(icono, size: 30, color: AppColor.textoSuave),
                ),
                const SizedBox(height: Gap.lg),
                Text(titulo, style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: Gap.sm),
                Text(
                  descripcion,
                  style: const TextStyle(color: AppColor.textoSuave, fontSize: 15, height: 1.5),
                ),
                if (puntos.isNotEmpty) ...[
                  const SizedBox(height: Gap.xl),
                  for (final p in puntos)
                    Padding(
                      padding: const EdgeInsets.only(bottom: Gap.md),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Padding(
                            padding: EdgeInsets.only(top: 6),
                            child: Icon(Icons.circle, size: 5, color: AppColor.textoDebil),
                          ),
                          const SizedBox(width: Gap.md),
                          Expanded(
                            child: Text(
                              p,
                              style: const TextStyle(
                                color: AppColor.textoSuave,
                                fontSize: 14,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
                const SizedBox(height: Gap.xl),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.sm),
                  decoration: BoxDecoration(
                    color: AppColor.superficie,
                    borderRadius: BorderRadius.circular(Redondeo.pill),
                    border: Border.all(color: AppColor.borde),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.schedule_rounded, size: 14, color: AppColor.textoDebil),
                      const SizedBox(width: Gap.sm),
                      Text(
                        'Llega con el módulo $modulo',
                        style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
