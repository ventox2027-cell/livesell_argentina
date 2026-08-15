import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../mercadopago_screen.dart';

/// Lo que aparece cuando alguien intenta vender sin Mercado Pago conectado.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL BLOQUEO DE VERDAD ESTÁ EN EL BACKEND
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Esto es la explicación, no el candado. El backend rechaza publicar y
/// transmitir con `MP_ACCOUNT_REQUIRED` mire lo que mire la app.
///
/// La distinción no es teórica: un bloqueo sólo en el cliente lo saltea
/// cualquiera con la API a mano, y lo que está en juego es que una venta entre
/// en la cuenta equivocada.
///
/// Lo que sí resuelve esta hoja es el otro problema: que la persona entienda
/// **qué** le falta y pueda resolverlo desde acá, en vez de leer un error y
/// tener que buscar dónde se arregla.
class ConectarMpSheet extends StatelessWidget {
  const ConectarMpSheet({super.key, required this.accion});

  /// Qué estaba intentando hacer. Cambia el título, no el resto.
  final AccionBloqueada accion;

  /// Devuelve `true` si conectó la cuenta mientras la hoja estaba abierta.
  ///
  /// Quien la muestra puede reintentar la acción sin obligar a la persona a
  /// volver a buscarla — que es lo que hace la diferencia entre un flujo que se
  /// siente resuelto y uno que se siente interrumpido.
  static Future<bool> mostrar(BuildContext context, AccionBloqueada accion) async {
    final resultado = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (_) => ConectarMpSheet(accion: accion),
    );
    return resultado ?? false;
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColor.borde,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: Gap.xl),

            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: AppColor.alerta.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: const Icon(
                Icons.account_balance_wallet_outlined,
                color: AppColor.alerta,
                size: 24,
              ),
            ),
            const SizedBox(height: Gap.lg),

            Text(
              accion.titulo,
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800, height: 1.25),
            ),
            const SizedBox(height: Gap.sm),
            const Text(
              // Se explica POR QUÉ. "Es obligatorio" suena a trámite nuestro;
              // "es donde entra tu plata" es una razón que se entiende sola.
              'Es la cuenta donde va a entrar el dinero de tus ventas. '
              'Lo conectás una sola vez y queda listo.',
              style: TextStyle(fontSize: 14.5, color: AppColor.textoSuave, height: 1.45),
            ),
            const SizedBox(height: Gap.lg),

            const _Punto('Tu contraseña la ponés en el sitio de Mercado Pago, no acá.'),
            const _Punto('El dinero entra directo a tu cuenta. VendoX no lo toca.'),
            const _Punto('Podés desconectarla cuando quieras.'),

            const SizedBox(height: Gap.xl),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () async {
                  await Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(builder: (_) => const MercadoPagoScreen()),
                  );
                  // Se cierra devolviendo `true` para que quien la abrió pueda
                  // reintentar. Si no conectó, el backend va a frenar de nuevo
                  // y la hoja vuelve a aparecer — que es el comportamiento
                  // correcto, y no hace falta saberlo desde acá.
                  if (context.mounted) Navigator.of(context).pop(true);
                },
                style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                icon: const Icon(Icons.link_rounded, size: 19),
                label: const Text(
                  'Conectar Mercado Pago',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ),
            ),
            const SizedBox(height: Gap.sm),
            SizedBox(
              width: double.infinity,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                // "Ahora no" y no "Cancelar": cancelar sugiere que se deshace
                // algo. Acá simplemente se pospone.
                child: const Text('Ahora no'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Qué se estaba intentando hacer.
enum AccionBloqueada {
  publicar,
  transmitir;

  String get titulo => switch (this) {
        AccionBloqueada.publicar => 'Para publicar necesitás conectar Mercado Pago',
        AccionBloqueada.transmitir => 'Para hacer un vivo necesitás conectar Mercado Pago',
      };
}

class _Punto extends StatelessWidget {
  const _Punto(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.check_rounded, size: 16, color: AppColor.exito),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              texto,
              style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}
