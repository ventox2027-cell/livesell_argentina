import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../orders/domain/order_models.dart';
import '../../orders/presentation/checkout_sheet.dart';
import '../data/inventory_repository.dart';
import '../domain/inventory_models.dart';

/// Hoja de reserva: elegir cantidad, apartar, y ver el tiempo que queda.
///
/// ─── Por qué esto no es todavía una compra ───
///
/// Reservar aparta unidades. No cobra, no congela precio y no crea una orden.
/// Existe porque en un vivo la última unidad se la lleva quien llega primero,
/// y sin apartarla la persona termina de pagar para enterarse de que ya no
/// está — que es la peor experiencia posible en una app de compras.
///
/// El pago llega con el módulo de Órdenes y va a consumir esta reserva.
class ReserveSheet extends ConsumerStatefulWidget {
  const ReserveSheet({
    super.key,
    required this.productVariantId,
    required this.nombreProducto,
    required this.precio,
    this.variante,
    this.retiraEnPersona = false,
    this.liveSessionId,
  });

  final String productVariantId;
  final String nombreProducto;
  final String precio;
  final String? variante;

  /// Si eligió retirar en persona en la hoja anterior, donde vio el precio de
  /// cada opción de entrega.
  final bool retiraEnPersona;

  /// Desde qué vivo se está comprando, o `null` si vino del feed.
  ///
  /// Sólo se transporta hasta el pedido: acá no se usa para nada más. El
  /// descuento lo resuelve el backend con este id, y por eso lo que viaja es el
  /// id y no un precio.
  final String? liveSessionId;

  /// Devuelve el **pedido** si la compra se completó, o `null` si se cerró
  /// antes de pagar.
  ///
  /// ─── Por qué el pedido y no la reserva ───
  ///
  /// Esta hoja llega hasta el final: aparta y encadena con el checkout. Cuando
  /// termina bien, la reserva ya fue consumida por el pedido — devolverla sería
  /// entregar un objeto que en la base ya no significa nada. El pedido, en
  /// cambio, es lo único que quien abrió la hoja puede seguir usando: mostrar
  /// la referencia, llevar a "mis pedidos", confirmar la compra en el vivo.
  static Future<Pedido?> mostrar(
    BuildContext context, {
    required String productVariantId,
    required String nombreProducto,
    required String precio,
    String? variante,
    bool retiraEnPersona = false,
    String? liveSessionId,
  }) {
    return showModalBottomSheet<Pedido>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (_) => ReserveSheet(
        productVariantId: productVariantId,
        nombreProducto: nombreProducto,
        precio: precio,
        variante: variante,
        retiraEnPersona: retiraEnPersona,
        liveSessionId: liveSessionId,
      ),
    );
  }

  @override
  ConsumerState<ReserveSheet> createState() => _ReserveSheetState();
}

class _ReserveSheetState extends ConsumerState<ReserveSheet> with WidgetsBindingObserver {
  int _cantidad = 1;
  bool _reservando = false;
  Reserva? _reserva;
  int _restantes = 0;
  Timer? _tictac;

  /// La clave de idempotencia de ESTE intento.
  ///
  /// ─── Por qué nace acá y no en cada llamada ───
  ///
  /// El caso real, no uno teórico: la persona toca "Apartar" con una barra de
  /// señal. La petición llega, el backend aparta la unidad, y la respuesta se
  /// pierde en el camino de vuelta. La app cree que falló y la persona toca
  /// otra vez.
  ///
  /// Con una clave nueva por toque, el segundo apartaría una SEGUNDA unidad.
  /// Con esta —la misma mientras no se sepa el resultado— el backend reconoce
  /// el reintento y devuelve la reserva que ya había hecho.
  ///
  /// Sólo se renueva cuando el intento se cierra de verdad: si la reserva se
  /// cancela o vence y la persona quiere reservar otra vez, eso sí es un
  /// intento nuevo.
  late String _clave = _nuevaClave();

  static String _nuevaClave() {
    final azar = Random();
    final sufijo = List.generate(16, (_) => azar.nextInt(16).toRadixString(16)).join();
    return 'rsv-${DateTime.now().microsecondsSinceEpoch}-$sufijo';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    _tictac?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState estado) {
    /**
     * Al volver del segundo plano se RECALCULA contra `expiresAt`.
     *
     * El temporizador de Flutter no corre —o corre a otro ritmo— con la app
     * atrás. Si al volver siguiera restando desde donde quedó, mostraría 03:40
     * cuando en el servidor ya venció. Y la verdad es siempre el servidor: si
     * la pantalla dice 00:02 y el backend la marcó vencida, está vencida.
     */
    if (estado == AppLifecycleState.resumed) _sincronizar();
  }

  void _sincronizar() {
    final r = _reserva;
    if (r == null) return;

    final faltan = r.segundosRestantes();
    setState(() => _restantes = faltan);
    if (faltan <= 0) _tictac?.cancel();
  }

  void _arrancarCuenta(Reserva r) {
    _tictac?.cancel();
    setState(() {
      _reserva = r;
      _restantes = r.segundosRestantes();
    });

    _tictac = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) {
        t.cancel();
        return;
      }
      // Se recalcula contra la fecha en cada tic en vez de restar uno. Así un
      // segundo que el sistema se saltee no desfasa el contador para siempre.
      final faltan = _reserva!.segundosRestantes();
      setState(() => _restantes = faltan);
      if (faltan <= 0) t.cancel();
    });
  }

  Future<void> _reservar() async {
    setState(() => _reservando = true);
    try {
      final r = await ref.read(inventoryRepositoryProvider).reservar(
            productVariantId: widget.productVariantId,
            quantity: _cantidad,
            idempotencyKey: _clave,
          );
      if (!mounted) return;

      unawaited(HapticFeedback.mediumImpact());
      _arrancarCuenta(r);

      // El backend devolvió una que ya existía: se avisa, porque si no la
      // persona no entiende por qué la cantidad no es la que acababa de elegir.
      if (r.reused && r.quantity != _cantidad) {
        AppSnack.info(
          context,
          'Ya tenías ${r.quantity} ${r.quantity == 1 ? "unidad apartada" : "unidades apartadas"}. '
          'Cancelá esta reserva si querés cambiar la cantidad.',
        );
      }
      // Se refresca la disponibilidad: lo que acaba de apartarse ya no está
      // libre para nadie más, y el feed tiene que reflejarlo.
      ref.invalidate(disponibilidadProvider(widget.productVariantId));
    } on InventarioException catch (e) {
      if (!mounted) return;
      AppSnack.error(
        context,
        e.sinStock ? 'Se agotó justo. Alguien lo compró recién.' : e.mensaje,
      );
      if (e.sinStock) {
        ref.invalidate(disponibilidadProvider(widget.productVariantId));
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _reservando = false);
    }
  }

  /// De la reserva al checkout.
  ///
  /// Se cierra esta hoja y se abre la del pago con la misma reserva: el
  /// backend la va a convertir en pedido. Si la compra sale, la reserva queda
  /// consumida y esta pantalla ya no tiene nada que mostrar.
  Future<void> _irAPagar() async {
    final r = _reserva;
    if (r == null) return;

    final pedido = await CheckoutSheet.mostrar(
      context,
      reservationId: r.reservationId,
      nombreProducto: widget.nombreProducto,
      precio: widget.precio,
      retiraEnPersona: widget.retiraEnPersona,
      liveSessionId: widget.liveSessionId,
    );

    if (!mounted) return;
    ref.invalidate(disponibilidadProvider(widget.productVariantId));

    // Con el pedido resuelto, la hoja de reserva ya cumplió su función.
    if (pedido != null) Navigator.of(context).pop(pedido);
  }

  Future<void> _cancelar() async {
    final r = _reserva;
    if (r == null) return;

    setState(() => _reservando = true);
    try {
      await ref.read(inventoryRepositoryProvider).cancelar(r.reservationId);
      _tictac?.cancel();
      ref.invalidate(disponibilidadProvider(widget.productVariantId));
      if (!mounted) return;
      setState(() {
        _reserva = null;
        // Soltar y volver a reservar es un intento NUEVO: clave nueva.
        _clave = _nuevaClave();
      });
      AppSnack.info(context, 'Soltaste la reserva');
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _reservando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reservada = _reserva != null && _restantes > 0;
    final vencida = _reserva != null && _restantes <= 0;

    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.md,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Agarradera(),
          const SizedBox(height: Gap.lg),
          Text(
            widget.nombreProducto,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleLarge,
          ),
          if (widget.variante != null) ...[
            const SizedBox(height: 2),
            Text(
              widget.variante!,
              style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave),
            ),
          ],
          const SizedBox(height: Gap.sm),
          Text(
            widget.precio,
            style: const TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.8,
            ),
          ),
          const SizedBox(height: Gap.xl),
          if (vencida)
            _Vencida(
              onReintentar: () {
                setState(() {
                  _reserva = null;
                  _clave = _nuevaClave();
                });
              },
            )
          else if (reservada)
            _Reservada(
              restantes: _restantes,
              cantidad: _reserva!.quantity,
              onPagar: _irAPagar,
              onCancelar: _reservando ? null : _cancelar,
            )
          else ...[
            _SelectorCantidad(
              valor: _cantidad,
              onCambio: _reservando ? null : (v) => setState(() => _cantidad = v),
            ),
            const SizedBox(height: Gap.lg),
            FilledButton(
              onPressed: _reservando ? null : _reservar,
              style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
              child: _reservando
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Text(
                      'Apartar',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
            ),
            const SizedBox(height: Gap.sm),
            const Text(
              'Te lo guardamos unos minutos mientras terminás la compra.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
            ),
          ],
        ],
      ),
    );
  }
}

class _SelectorCantidad extends StatelessWidget {
  const _SelectorCantidad({required this.valor, this.onCambio});

  final int valor;
  final ValueChanged<int>? onCambio;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        const Text('Cantidad', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
        Row(
          children: [
            _Paso(
              icono: Icons.remove_rounded,
              onTap: onCambio == null || valor <= 1 ? null : () => onCambio!(valor - 1),
            ),
            SizedBox(
              width: 52,
              child: Text(
                '$valor',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
            ),
            _Paso(
              // El tope lo pone el backend; acá se corta antes para no mandar
              // una petición que se sabe que va a fallar.
              icono: Icons.add_rounded,
              onTap: onCambio == null || valor >= 10 ? null : () => onCambio!(valor + 1),
            ),
          ],
        ),
      ],
    );
  }
}

class _Paso extends StatelessWidget {
  const _Paso({required this.icono, this.onTap});
  final IconData icono;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.sm),
      child: Container(
        width: 42,
        height: 42,
        decoration: BoxDecoration(
          color: AppColor.superficieAlta,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Icon(
          icono,
          size: 20,
          color: onTap == null ? AppColor.textoDebil : AppColor.texto,
        ),
      ),
    );
  }
}

/// Reserva viva, con la cuenta regresiva.
class _Reservada extends StatelessWidget {
  const _Reservada({
    required this.restantes,
    required this.cantidad,
    required this.onPagar,
    this.onCancelar,
  });

  final int restantes;
  final int cantidad;
  final VoidCallback onPagar;
  final VoidCallback? onCancelar;

  @override
  Widget build(BuildContext context) {
    // Bajo el minuto se pone en alerta. Es el momento en que la persona tiene
    // que decidir, y el color lo dice mejor que un texto.
    final apurado = restantes <= 60;
    final color = apurado ? AppColor.alerta : AppColor.exito;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: Gap.lg, horizontal: Gap.lg),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(Redondeo.lg),
            border: Border.all(color: color.withValues(alpha: 0.35)),
          ),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.lock_clock_rounded, size: 18, color: color),
                  const SizedBox(width: Gap.sm),
                  Text(
                    cantidad == 1 ? 'Reservado para vos' : '$cantidad reservados para vos',
                    style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: color),
                  ),
                ],
              ),
              const SizedBox(height: Gap.sm),
              Text(
                Reserva.formatearCuenta(restantes),
                style: TextStyle(
                  fontSize: 40,
                  fontWeight: FontWeight.w800,
                  color: color,
                  letterSpacing: -1.5,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: Gap.lg),
        FilledButton(
          onPressed: onPagar,
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: const Text(
            'Ir a pagar',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ),
        const SizedBox(height: Gap.sm),
        TextButton(
          onPressed: onCancelar,
          style: TextButton.styleFrom(foregroundColor: AppColor.textoSuave),
          child: const Text('Soltar la reserva'),
        ),
      ],
    );
  }
}

class _Vencida extends StatelessWidget {
  const _Vencida({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(Gap.lg),
          decoration: BoxDecoration(
            color: AppColor.superficieAlta,
            borderRadius: BorderRadius.circular(Redondeo.lg),
          ),
          child: const Column(
            children: [
              Icon(Icons.timer_off_outlined, size: 28, color: AppColor.textoSuave),
              SizedBox(height: Gap.sm),
              Text(
                'Se venció la reserva',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
              SizedBox(height: 4),
              Text(
                'Las unidades volvieron a estar disponibles. Podés intentar de nuevo.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
              ),
            ],
          ),
        ),
        const SizedBox(height: Gap.lg),
        FilledButton(
          onPressed: onReintentar,
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: const Text('Intentar de nuevo'),
        ),
      ],
    );
  }
}

class _Agarradera extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 36,
        height: 4,
        decoration: BoxDecoration(
          color: AppColor.borde,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}
