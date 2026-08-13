import 'package:flutter/material.dart';

import '../../../core/config/runtime_config.dart';
import '../data/payments_api.dart';
import '../domain/payment_models.dart';
import 'card_form_screen.dart';

/// Pantalla del spike de pagos: un producto, un botón, un resultado.
///
/// Deliberadamente mínima. La pregunta que este spike tiene que responder no es
/// "¿cómo se ve un checkout?" sino **"¿podemos cobrar con tarjeta desde Flutter
/// sin arrastrar el alcance PCI completo, y sobrevive el flujo a que se corte
/// la red en el peor momento?"**. Todo lo que no ayude a responder eso sobra.
class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key});

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _api = PaymentsApi();
  final _emailCtrl = TextEditingController(text: 'comprador@test.com');

  static const _descripcion = 'Remera oversize · talle M';
  static const _montoCentavos = 1_549_900; // $15.499,00

  Order? _orden;
  bool _trabajando = false;
  String? _mensaje;
  bool _mensajeEsError = false;

  @override
  void dispose() {
    _emailCtrl.dispose();
    super.dispose();
  }

  void _avisar(String texto, {bool error = false}) {
    if (!mounted) return;
    setState(() {
      _mensaje = texto;
      _mensajeEsError = error;
    });
  }

  /// Clave de idempotencia del intento.
  ///
  /// Se calcula una sola vez por compra y se REUSA en los reintentos. Si en vez
  /// de esto se generara una nueva en cada toque, dos toques crearían dos
  /// órdenes y la protección del backend no serviría de nada.
  String _claveIdempotencia() =>
      'app-${DateTime.now().millisecondsSinceEpoch}-${_emailCtrl.text.hashCode}';

  Future<void> _comprar() async {
    if (_trabajando) return;
    setState(() {
      _trabajando = true;
      _mensaje = null;
    });

    try {
      final orden = _orden ??
          await _api.createOrder(
            idempotencyKey: _claveIdempotencia(),
            buyerEmail: _emailCtrl.text.trim(),
            description: _descripcion,
            amountCents: _montoCentavos,
          );
      if (!mounted) return;
      setState(() => _orden = orden);

      final resultado = await Navigator.of(context).push<PayResult?>(
        MaterialPageRoute(
          builder: (_) => CardFormScreen(order: orden, api: _api),
        ),
      );

      if (!mounted) return;

      if (resultado == null) {
        // El WebView volvió sin resultado: o se canceló, o el cobro se fue por
        // el camino "no sabemos". Se consulta el estado real en vez de
        // adivinar.
        await _refrescar();
        return;
      }

      setState(() => _orden = resultado.order);

      /// El texto viene traducido del backend. La app NO arma mensajes de
      /// error de pago por su cuenta: si lo hiciera, habría dos lugares donde
      /// mantener las mismas explicaciones y uno de los dos quedaría viejo.
      final texto = resultado.message;
      switch (resultado.outcome) {
        case PayOutcome.resuelto:
          final pagado = resultado.order.status == OrderStatus.paid;
          _avisar(
            pagado ? '✅ Pago acreditado' : (texto ?? resultado.order.status.etiqueta),
            error: !pagado,
          );
        case PayOutcome.rechazado:
          _avisar(texto ?? 'No se pudo completar el pago.', error: true);
        case PayOutcome.desconocido:
          // Ojo: acá NO se dice "rechazado". No sabemos si se cobró, y decir
          // que falló haría que la persona pague de nuevo.
          _avisar(texto ?? 'Estamos confirmando el pago.', error: false);
      }
    } catch (e) {
      _avisar('No se pudo iniciar la compra: $e', error: true);
    } finally {
      if (mounted) setState(() => _trabajando = false);
    }
  }

  Future<void> _refrescar() async {
    final orden = _orden;
    if (orden == null) return;
    try {
      final actual = await _api.getOrder(orden.id);
      if (!mounted) return;
      setState(() => _orden = actual);
      _avisar('Estado actual: ${actual.status.etiqueta}');
    } catch (e) {
      _avisar('No se pudo consultar: $e', error: true);
    }
  }

  /// Fuerza la conciliación.
  ///
  /// Es el botón que demuestra el criterio más importante de robustez del
  /// sprint: una orden cuyo webhook nunca llegó se resuelve igual, porque el
  /// backend le pregunta a Mercado Pago en vez de esperar que le avisen.
  Future<void> _conciliar() async {
    setState(() => _trabajando = true);
    try {
      final r = await _api.reconcile();
      final cambiadas = (r['changed'] as List<dynamic>?)?.length ?? 0;
      await _refrescar();
      _avisar('Conciliación: $cambiadas ${cambiadas == 1 ? "orden resuelta" : "órdenes resueltas"}');
    } catch (e) {
      _avisar('Falló la conciliación: $e', error: true);
    } finally {
      if (mounted) setState(() => _trabajando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final orden = _orden;

    return Scaffold(
      appBar: AppBar(title: const Text('Sprint 0B · Pago')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const _TarjetaProducto(
            descripcion: _descripcion,
            montoCentavos: _montoCentavos,
          ),
          const SizedBox(height: 20),

          TextField(
            controller: _emailCtrl,
            enabled: orden == null && !_trabajando,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(
              labelText: 'Email del comprador',
              helperText: 'Con este email se guarda el medio de pago',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 20),

          FilledButton(
            onPressed: _trabajando ? null : _comprar,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: Text(
              orden == null ? 'Comprar' : 'Reintentar el pago',
              style: const TextStyle(fontSize: 17),
            ),
          ),

          if (_mensaje != null) ...[
            const SizedBox(height: 18),
            _Aviso(texto: _mensaje!, esError: _mensajeEsError),
          ],

          if (orden != null) ...[
            const SizedBox(height: 24),
            _EstadoOrden(orden: orden),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _trabajando ? null : _refrescar,
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('Consultar'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _trabajando ? null : _conciliar,
                    icon: const Icon(Icons.sync_problem, size: 18),
                    label: const Text('Conciliar'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
              'Conciliar simula lo que hace el trabajo periódico: le pregunta a '
              'Mercado Pago por las órdenes en curso, sin depender de que llegue '
              'el aviso.',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 14),
            TextButton(
              onPressed: _trabajando ? null : () => setState(() {
                _orden = null;
                _mensaje = null;
              }),
              child: const Text('Empezar otra compra'),
            ),
          ],

          const SizedBox(height: 28),
          Text(
            'Backend: ${RuntimeConfig.instance.apiBaseUrl}',
            style: const TextStyle(fontSize: 11, color: Colors.black38),
          ),
        ],
      ),
    );
  }
}

class _TarjetaProducto extends StatelessWidget {
  const _TarjetaProducto({required this.descripcion, required this.montoCentavos});

  final String descripcion;
  final int montoCentavos;

  @override
  Widget build(BuildContext context) {
    final pesos = (montoCentavos / 100).toStringAsFixed(2).replaceAll('.', ',');
    return Card(
      elevation: 0,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(descripcion, style: const TextStyle(fontSize: 15)),
            const SizedBox(height: 6),
            Text(
              '\$ $pesos',
              style: const TextStyle(fontSize: 30, fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }
}

class _EstadoOrden extends StatelessWidget {
  const _EstadoOrden({required this.orden});

  final Order orden;

  Color get _color => switch (orden.status) {
        OrderStatus.paid => const Color(0xFF1B7F3B),
        OrderStatus.failed || OrderStatus.cancelled => const Color(0xFFC22929),
        OrderStatus.processing => const Color(0xFFB06E00),
        _ => Colors.black54,
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        border: Border.all(color: _color.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.circle, size: 10, color: _color),
              const SizedBox(width: 8),
              Text(
                orden.status.etiqueta,
                style: TextStyle(fontWeight: FontWeight.w600, color: _color),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SelectableText(
            orden.id,
            style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: Colors.black45),
          ),
        ],
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso({required this.texto, required this.esError});

  final String texto;
  final bool esError;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: esError ? const Color(0xFFFDECEC) : const Color(0xFFE9F6EC),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        texto,
        style: TextStyle(
          fontSize: 14,
          color: esError ? const Color(0xFF8E1F1F) : const Color(0xFF14602C),
        ),
      ),
    );
  }
}
