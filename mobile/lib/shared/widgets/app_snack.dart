import 'package:flutter/material.dart';

import '../../core/design/tokens.dart';

/// Avisos breves.
///
/// Existe para que los mensajes se vean iguales en toda la app. Cuando cada
/// pantalla arma su propio SnackBar, terminan con colores, duraciones e iconos
/// distintos, y la interfaz se siente hecha por cinco personas que no se
/// hablaron.
abstract final class AppSnack {
  static void error(BuildContext context, String mensaje) =>
      _mostrar(context, mensaje, AppColor.error, Icons.error_outline_rounded);

  static void exito(BuildContext context, String mensaje) =>
      _mostrar(context, mensaje, AppColor.exito, Icons.check_circle_outline_rounded);

  static void info(BuildContext context, String mensaje) =>
      _mostrar(context, mensaje, AppColor.textoSuave, Icons.info_outline_rounded);

  static void _mostrar(BuildContext context, String mensaje, Color color, IconData icono) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;

    // Se descarta el anterior: apilar avisos hace que la persona lea el último
    // sin haber visto el primero, y que la pantalla quede tapada.
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Row(
            children: [
              Icon(icono, color: color, size: 20),
              const SizedBox(width: Gap.md),
              Expanded(child: Text(mensaje, style: const TextStyle(fontSize: 14))),
            ],
          ),
          // Los errores duran más: suelen pedir una acción, y cuatro segundos
          // no alcanzan para leer y decidir.
          duration: color == AppColor.error
              ? const Duration(seconds: 6)
              : const Duration(seconds: 4),
          margin: const EdgeInsets.all(Gap.lg),
        ),
      );
  }
}
