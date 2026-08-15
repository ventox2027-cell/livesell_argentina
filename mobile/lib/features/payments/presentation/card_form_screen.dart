import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../data/payments_api.dart';
import '../domain/payment_models.dart';

/// Formulario de tarjeta.
///
/// ─── Qué hace y qué NO hace ───
///
/// Esta pantalla es un contenedor de un WebView y nada más. No lee la tarjeta,
/// no la valida, no la toca. Los campos sensibles son iframes servidos por
/// Mercado Pago dentro de esa página; el número y el código de seguridad no
/// pasan por Dart, ni por nuestro backend, ni por nuestros logs.
///
/// Lo único que cruza de vuelta es un **token de un solo uso**, por un canal de
/// JavaScript. Con ese token la app llama al backend, que es el único que
/// puede cobrar.
///
/// Es la razón por la que el proyecto queda en alcance PCI **SAQ-A**. Si algún
/// día alguien reemplaza esto por `TextField`s nativos "para que se vea mejor",
/// el sistema entero pasa a SAQ-D: auditoría anual, escaneos trimestrales y
/// segmentación de red. Ver `backend/src/modules/payments/checkout-page.ts`.
class CardFormScreen extends StatefulWidget {
  const CardFormScreen({super.key, required this.order, required this.api});

  final Order order;
  final PaymentsApi api;

  @override
  State<CardFormScreen> createState() => _CardFormScreenState();
}

class _CardFormScreenState extends State<CardFormScreen> {
  late final WebViewController _webview;

  bool _cargando = true;
  String? _error;

  /// Impide que dos toques rápidos disparen dos cobros. La idempotencia del
  /// backend ya lo cubre, pero fallar acá primero evita el viaje de red y el
  /// parpadeo de la interfaz.
  bool _cobrando = false;

  @override
  void initState() {
    super.initState();

    _webview = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF5F5F7))
      // Único canal de entrada desde la página. El nombre coincide con el
      // `window.MpBridge` de checkout-page.ts.
      ..addJavaScriptChannel('MpBridge', onMessageReceived: _recibirDeLaPagina)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (_) {
            if (mounted) setState(() => _cargando = false);
          },
          onWebResourceError: (e) {
            // Los errores de subrecursos (un ícono que no carga) no deben
            // tumbar el checkout. Sólo importa que falle el documento.
            if (!e.isForMainFrame.isTrue) return;
            if (mounted) {
              setState(() {
                _cargando = false;
                _error = 'No se pudo cargar el formulario: ${e.description}';
              });
            }
          },
          onNavigationRequest: (req) {
            // La página no debería navegar a ningún lado. Los iframes de
            // Mercado Pago no pasan por acá; cualquier navegación del marco
            // principal a otro sitio sería una señal de que algo está mal.
            final url = Uri.tryParse(req.url);
            final esNuestro = url?.host == widget.api.checkoutUrl(widget.order).host;
            final esMp = url?.host.endsWith('mercadopago.com') ?? false;
            return (esNuestro || esMp) ? NavigationDecision.navigate : NavigationDecision.prevent;
          },
        ),
      )
      ..loadRequest(widget.api.checkoutUrl(widget.order));
  }

  void _recibirDeLaPagina(JavaScriptMessage mensaje) {
    Map<String, dynamic> datos;
    try {
      datos = jsonDecode(mensaje.message) as Map<String, dynamic>;
    } catch (_) {
      return; // mensaje malformado: se ignora, no se rompe el checkout
    }

    switch (datos['tipo']) {
      case 'listo':
        if (mounted) setState(() => _cargando = false);
      case 'token':
        _cobrar(CardToken.fromJson(datos));
      case 'error':
        if (mounted) {
          setState(() => _error = 'Mercado Pago no pudo iniciar: ${datos['motivo']}');
        }
    }
  }

  Future<void> _cobrar(CardToken card) async {
    if (_cobrando) return;
    setState(() {
      _cobrando = true;
      _error = null;
    });

    try {
      final resultado = await widget.api.pay(
        orderId: widget.order.id,
        card: card,
        saveCard: true,
      );
      if (mounted) Navigator.of(context).pop(resultado);
    } catch (e) {
      /// Un fallo de red acá NO significa que el cobro falló: significa que no
      /// sabemos. El backend ya dejó la orden en PROCESSING y el conciliador se
      /// va a encargar. Por eso se vuelve con `null` en vez de con un
      /// "rechazado" que sería mentira, y la pantalla anterior consulta el
      /// estado real.
      if (mounted) Navigator.of(context).pop(null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F5F7),
      appBar: AppBar(
        title: const Text('Pagar'),
        // Sin botón de volver mientras se cobra: irse en el medio deja a la
        // persona sin saber si pagó.
        automaticallyImplyLeading: !_cobrando,
      ),
      body: Stack(
        children: [
          if (_error == null) WebViewWidget(controller: _webview),
          if (_error != null) _PantallaError(mensaje: _error!),
          if (_cargando && _error == null)
            const ColoredBox(
              color: Color(0xFFF5F5F7),
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_cobrando) const _CobrandoOverlay(),
        ],
      ),
    );
  }
}

class _CobrandoOverlay extends StatelessWidget {
  const _CobrandoOverlay();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black.withValues(alpha: 0.55),
      child: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: Colors.white),
            SizedBox(height: 20),
            Text(
              'Procesando el pago',
              style: TextStyle(color: Colors.white, fontSize: 17),
            ),
            SizedBox(height: 6),
            Text(
              'No cierres la aplicación',
              style: TextStyle(color: Colors.white70, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}

class _PantallaError extends StatelessWidget {
  const _PantallaError({required this.mensaje});

  final String mensaje;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.credit_card_off, size: 52, color: Colors.black38),
            const SizedBox(height: 16),
            Text(
              mensaje,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15),
            ),
            const SizedBox(height: 10),
            const Text(
              'No se hizo ningún cobro.',
              style: TextStyle(fontSize: 13, color: Colors.black54),
            ),
          ],
        ),
      ),
    );
  }
}

extension on bool? {
  bool get isTrue => this ?? false;
}
