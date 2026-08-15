import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../auth/state/auth_providers.dart';
import '../mercadopago_screen.dart';

/// El estado de Mercado Pago, en la primera pantalla de "Mi tienda".
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ARRIBA Y NO EN AJUSTES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Sin la cuenta conectada, el vendedor **no puede publicar ni transmitir**. Eso
/// no es una preferencia escondida en un submenú: es el paso que le falta para
/// empezar a trabajar.
///
/// Estaba en Ajustes → Cobros, a dos toques y sin ninguna señal de que hiciera
/// falta. Alguien podía cargar veinte productos, tocar "publicar" y recibir un
/// error sobre algo que nunca vio.
///
/// ─── Cuando ya está conectada, casi no se ve ───
///
/// Una línea verde y nada más. Un cartel grande permanente sobre algo que ya
/// está resuelto es ruido, y el ruido enseña a ignorar la pantalla entera.
class EstadoDeCobros extends ConsumerStatefulWidget {
  const EstadoDeCobros({super.key});

  @override
  ConsumerState<EstadoDeCobros> createState() => _EstadoDeCobrosState();
}

/// El estado de cobros, cacheado mientras dura la pantalla.
///
/// `autoDispose` porque al salir de "Mi tienda" el dato deja de importar, y
/// mantenerlo vivo haría que al volver se muestre el de hace una hora.
final estadoDeCobrosProvider = FutureProvider.autoDispose<EstadoDeCobrosDatos>((ref) async {
  final r = await ref
      .read(apiClientProvider)
      .get<Map<String, dynamic>>('/sellers/me/payment-account');
  return EstadoDeCobrosDatos.fromJson(r.data);
});

class EstadoDeCobrosDatos {
  const EstadoDeCobrosDatos({
    required this.conectada,
    required this.disponible,
    required this.obligatoria,
    required this.puedeVender,
    this.cuenta,
  });

  /// Lectura defensiva: si el cuerpo viene raro se asume lo que menos frena.
  ///
  /// Un fallo de red no puede hacer que la app le diga a un vendedor que no
  /// puede vender: el backend lo va a frenar igual si corresponde, con un
  /// mensaje que explica por qué.
  ///
  /// ─── Por qué `puedeVender` no se deriva acá ───
  ///
  /// Sería fácil calcularlo: `!obligatoria || conectada`. Pero entonces la
  /// regla viviría en dos lugares, y el día que el servidor agregue una
  /// condición —una cuenta suspendida, por ejemplo— la app seguiría diciendo
  /// que sí. La respuesta del servidor es la única fuente.
  factory EstadoDeCobrosDatos.fromJson(Map<String, dynamic>? j) {
    final conectada = j?['conectada'] as bool? ?? false;
    final obligatoria = j?['mercadoPagoObligatorio'] as bool? ?? false;
    return EstadoDeCobrosDatos(
      conectada: conectada,
      disponible: j?['disponible'] as bool? ?? false,
      obligatoria: obligatoria,
      // El `??` cubre a un servidor viejo que no manda el campo: ahí se cae a
      // la derivación, que es peor pero no rompe la pantalla.
      puedeVender: j?['puedeVender'] as bool? ?? (!obligatoria || conectada),
      cuenta: j?['cuentaDeMercadoPago'] as String?,
    );
  }

  final bool conectada;

  /// Si este servidor tiene la conexión habilitada.
  final bool disponible;

  /// La REGLA: si este servidor exige Mercado Pago para vender.
  ///
  /// Es del servidor, no de este vendedor. Sirve para el texto —"sin esto no
  /// podés publicar"— y para el borde ámbar.
  final bool obligatoria;

  /// Si ESTE vendedor puede publicar y transmitir ahora mismo.
  final bool puedeVender;

  /// El id de la cuenta en Mercado Pago. No es un secreto.
  final String? cuenta;
}

class _EstadoDeCobrosState extends ConsumerState<EstadoDeCobros> {
  Future<void> _abrir() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(builder: (_) => const MercadoPagoScreen()),
    );
    // Al volver puede haber conectado. Sin esto la tarjeta sigue diciendo que
    // no, y el vendedor cree que no funcionó.
    ref.invalidate(estadoDeCobrosProvider);
  }

  @override
  Widget build(BuildContext context) {
    final estado = ref.watch(estadoDeCobrosProvider);

    return estado.when(
      // Sin esqueleto ni spinner: es un dato secundario y un bloque que aparece
      // y desaparece mueve todo lo de abajo.
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (d) {
        if (!d.disponible) return const SizedBox.shrink();
        return d.conectada ? _Conectada(cuenta: d.cuenta, onTap: _abrir) : _Falta(
          obligatoria: d.obligatoria,
          onTap: _abrir,
        );
      },
    );
  }
}

/// Lo que ve alguien que todavía no conectó.
class _Falta extends StatelessWidget {
  const _Falta({required this.obligatoria, required this.onTap});

  final bool obligatoria;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: Gap.lg),
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        // Borde ámbar y no rojo: no hizo nada mal, le falta un paso.
        border: Border.all(color: obligatoria ? AppColor.alerta : AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.account_balance_wallet_outlined,
                size: 20,
                color: obligatoria ? AppColor.alerta : AppColor.textoSuave,
              ),
              const SizedBox(width: Gap.sm),
              const Expanded(
                child: Text(
                  'Conectá Mercado Pago',
                  style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColor.superficieAlta,
                  borderRadius: BorderRadius.circular(Redondeo.sm),
                ),
                child: const Text(
                  'No conectado',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: AppColor.textoSuave,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: Gap.sm),
          Text(
            obligatoria
                // Se dice QUÉ no puede hacer, no "es obligatorio". Lo segundo
                // suena a trámite nuestro; lo primero es información que le
                // sirve.
                ? 'Sin esto no podés publicar productos ni hacer vivos. '
                    'El dinero de tus ventas entra directo a tu cuenta.'
                : 'El dinero de tus ventas entra directo a tu cuenta de Mercado Pago.',
            style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
          ),
          const SizedBox(height: Gap.md),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: onTap,
              style: FilledButton.styleFrom(minimumSize: const Size(0, 46)),
              icon: const Icon(Icons.link_rounded, size: 18),
              label: const Text(
                'Conectar Mercado Pago',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Lo que ve alguien que ya conectó: una línea y nada más.
class _Conectada extends StatelessWidget {
  const _Conectada({required this.cuenta, required this.onTap});

  final String? cuenta;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Gap.sm, vertical: 6),
          child: Row(
            children: [
              const Icon(Icons.check_circle_rounded, size: 17, color: AppColor.exito),
              const SizedBox(width: Gap.sm),
              const Expanded(
                child: Text(
                  'Mercado Pago conectado',
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
              if (cuenta != null)
                Text(
                  // El id de la cuenta no es un secreto y le sirve para
                  // confirmar que conectó la que quería.
                  'Cuenta $cuenta',
                  style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                ),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right_rounded, size: 18, color: AppColor.textoDebil),
            ],
          ),
        ),
      ),
    );
  }
}
