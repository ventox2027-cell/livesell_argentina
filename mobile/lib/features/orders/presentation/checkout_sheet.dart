import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../../core/config/runtime_config.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/presentation/widgets/fecha_de_nacimiento_sheet.dart';
import '../data/orders_repository.dart';
import '../domain/order_models.dart';
import 'address_sheet.dart';
import 'widgets/desglose_de_precio.dart';

/// El checkout.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL NÚMERO DE TARJETA NO PASA POR ACÁ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El formulario corre en un WebView contra el CardForm de Mercado Pago, con
/// `iframe: true`. Los campos del número y del código de seguridad son iframes
/// servidos por ellos: el PAN no toca este archivo, ni Dart, ni nuestro
/// backend.
///
/// Eso mantiene el alcance PCI en **SAQ-A**. Con campos propios el sistema
/// entraría en SAQ-D —auditoría anual, escaneos trimestrales, segmentación de
/// red— que para un equipo de esta escala no es caro: es inviable.
///
/// **Nunca crear inputs de tarjeta en Flutter.** Es la regla que sostiene todo
/// lo anterior.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LOS TRES DESENLACES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Aprobado, rechazado y **no sabemos**. El tercero no es un fallo: el cobro
/// pudo haberse procesado y la respuesta perderse. Ahí la app dice "estamos
/// verificando tu pago" y NO ofrece pagar de nuevo — hacerlo cobraría dos
/// veces.
class CheckoutSheet extends ConsumerStatefulWidget {
  const CheckoutSheet({
    super.key,
    required this.reservationId,
    required this.nombreProducto,
    required this.precio,
    this.retiraEnPersona = false,
  });

  final String reservationId;
  final String nombreProducto;
  final String precio;

  /// Lo eligió en la hoja de variantes, donde vio el precio de cada opción.
  final bool retiraEnPersona;

  static Future<Pedido?> mostrar(
    BuildContext context, {
    required String reservationId,
    required String nombreProducto,
    required String precio,
    bool retiraEnPersona = false,
  }) {
    return showModalBottomSheet<Pedido>(
      context: context,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: AppColor.superficie,
      builder: (_) => CheckoutSheet(
        reservationId: reservationId,
        nombreProducto: nombreProducto,
        precio: precio,
        retiraEnPersona: retiraEnPersona,
      ),
    );
  }

  @override
  ConsumerState<CheckoutSheet> createState() => _CheckoutSheetState();
}

enum _Paso { creando, direccion, resumen, tarjeta, procesando, resultado }

class _CheckoutSheetState extends ConsumerState<CheckoutSheet> {
  _Paso _paso = _Paso.creando;
  Pedido? _pedido;
  Direccion? _direccion;
  String? _error;

  /// La clave de idempotencia de ESTE intento de crear el pedido.
  ///
  /// Nace una sola vez. Si la red se corta y hay que reintentar, se reusa: con
  /// una clave nueva el backend lo leería como un pedido distinto.
  late final String _claveDePedido = nuevaClaveDeIdempotencia('ord');

  @override
  void initState() {
    super.initState();
    unawaited(_crearPedido());
  }

  Future<void> _crearPedido() async {
    setState(() {
      _paso = _Paso.creando;
      _error = null;
    });

    try {
      final pedido = await ref.read(ordersRepositoryProvider).crearPedido(
            reservationId: widget.reservationId,
            idempotencyKey: _claveDePedido,
            addressId: _direccion?.id,
            retiraEnPersona: widget.retiraEnPersona,
          );
      if (!mounted) return;
      setState(() {
        _pedido = pedido;
        _paso = _Paso.resumen;
      });
    } on PedidoException catch (e) {
      if (!mounted) return;

      // Falta la dirección: se pide AHORA, con la compra ya decidida.
      if (e.faltaDireccion) {
        setState(() => _paso = _Paso.direccion);
        return;
      }

      /**
       * VendoX es 18+ y todavía no declaró su fecha.
       *
       * Se pide acá y no al registrarse a propósito: meter un formulario de
       * edad antes del primer video pierde a quien todavía no sabe si la app le
       * sirve. Y una vez declarada, se reintenta sola: obligar a volver a tocar
       * "comprar" después de completar un formulario que la app misma pidió es
       * hacerle repetir el trabajo.
       */
      if (e.faltaFechaDeNacimiento) {
        final declarada = await FechaDeNacimientoSheet.mostrar(context, AccionConEdad.comprar);
        if (!mounted) return;
        if (declarada) {
          unawaited(_crearPedido());
          return;
        }
        Navigator.of(context).pop();
        return;
      }
      if (e.reservaVencida) {
        AppSnack.error(context, 'Se te venció el tiempo. Probá de nuevo.');
        Navigator.of(context).pop();
        return;
      }
      setState(() {
        _error = e.mensaje;
        _paso = _Paso.resultado;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _paso = _Paso.resultado;
      });
    }
  }

  Future<void> _pedirDireccion() async {
    final direccion = await AddressSheet.mostrar(context);
    if (direccion == null || !mounted) return;
    setState(() => _direccion = direccion);
    await _crearPedido();
  }

  /// Llega el token del CardForm. Recién acá se cobra.
  Future<void> _cobrar(String cardToken, String paymentMethodId) async {
    final pedido = _pedido;
    if (pedido == null) return;

    setState(() => _paso = _Paso.procesando);

    try {
      await ref.read(ordersRepositoryProvider).cobrar(
            orderId: pedido.id,
            cardToken: cardToken,
            paymentMethodId: paymentMethodId,
          );

      if (!mounted) return;
      unawaited(HapticFeedback.mediumImpact());

      // El estado real se relee del backend: la respuesta del cobro dice si
      // se aprobó, pero la orden puede haber seguido avanzando (confirmada,
      // o pendiente de devolución si el stock se agotó).
      final actualizado = await ref.read(ordersRepositoryProvider).pedido(pedido.id);
      if (!mounted) return;

      ref.invalidate(misPedidosProvider);

      setState(() {
        _pedido = actualizado;
        _paso = _Paso.resultado;
      });
    } on PedidoException catch (e) {
      if (!mounted) return;
      // Un rechazo SÍ deja reintentar con otra tarjeta.
      final pedidoActual = await ref.read(ordersRepositoryProvider).pedido(pedido.id);
      if (!mounted) return;
      setState(() {
        _pedido = pedidoActual;
        _error = e.mensaje;
        _paso = _Paso.resultado;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _paso = _Paso.resultado;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: AnimatedSize(
        duration: Duraciones.rapida,
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.md, Gap.xl, Gap.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Encabezado(
                titulo: switch (_paso) {
                  _Paso.creando => 'Preparando tu compra',
                  _Paso.direccion => 'Falta un dato',
                  _Paso.resumen => 'Confirmá tu compra',
                  _Paso.tarjeta => 'Datos de la tarjeta',
                  _Paso.procesando => 'Procesando…',
                  _Paso.resultado => '',
                },
                // Durante el cobro no se puede cerrar: irse a mitad de una
                // operación con plata en juego deja a la persona sin saber qué
                // pasó.
                onCerrar:
                    _paso == _Paso.procesando ? null : () => Navigator.of(context).pop(_pedido),
              ),
              const SizedBox(height: Gap.lg),
              switch (_paso) {
                _Paso.creando => const _Cargando('Reservando tu unidad…'),
                _Paso.direccion => _PedirDireccion(onCargar: _pedirDireccion),
                _Paso.resumen => _Resumen(
                    pedido: _pedido!,
                    onPagar: () => setState(() => _paso = _Paso.tarjeta),
                  ),
                _Paso.tarjeta => _FormularioDeTarjeta(pedido: _pedido!, onToken: _cobrar),
                _Paso.procesando => const _Cargando('No cierres la app'),
                _Paso.resultado => _Resultado(
                    pedido: _pedido,
                    error: _error,
                    onReintentar: () => setState(() {
                      _error = null;
                      _paso = _Paso.tarjeta;
                    }),
                    onListo: () => Navigator.of(context).pop(_pedido),
                  ),
              },
            ],
          ),
        ),
      ),
    );
  }
}

// ─── Pasos ──────────────────────────────────────────────────────────────────

class _Encabezado extends StatelessWidget {
  const _Encabezado({required this.titulo, this.onCerrar});
  final String titulo;
  final VoidCallback? onCerrar;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            titulo,
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
        if (onCerrar != null)
          IconButton(
            onPressed: onCerrar,
            icon: const Icon(Icons.close_rounded),
            color: AppColor.textoSuave,
          ),
      ],
    );
  }
}

class _Cargando extends StatelessWidget {
  const _Cargando(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Gap.xxl),
      child: Column(
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: Gap.lg),
          Text(texto, style: const TextStyle(color: AppColor.textoSuave, fontSize: 14)),
        ],
      ),
    );
  }
}

class _PedirDireccion extends StatelessWidget {
  const _PedirDireccion({required this.onCargar});
  final VoidCallback onCargar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Necesitamos saber a dónde mandarte el pedido. Se guarda para la '
          'próxima vez.',
          style: TextStyle(color: AppColor.textoSuave, fontSize: 14.5, height: 1.45),
        ),
        const SizedBox(height: Gap.xl),
        FilledButton(
          onPressed: onCargar,
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: const Text('Cargar mi dirección'),
        ),
      ],
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.pedido, required this.onPagar});
  final Pedido pedido;
  final VoidCallback onPagar;

  @override
  Widget build(BuildContext context) {
    final linea = pedido.lineas.firstOrNull;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (linea != null) ...[
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      linea.nombre,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
                    ),
                    if (linea.varianteRelevante)
                      Text(
                        linea.variante,
                        style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
                      ),
                    if (linea.cantidad > 1)
                      Text(
                        '${linea.cantidad} unidades',
                        style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: Gap.lg),
        ],

        if (pedido.direccion != null) ...[
          Container(
            padding: const EdgeInsets.all(Gap.md),
            decoration: BoxDecoration(
              color: AppColor.superficieAlta,
              borderRadius: BorderRadius.circular(Redondeo.md),
            ),
            child: Row(
              children: [
                const Icon(Icons.local_shipping_outlined, size: 18, color: AppColor.textoSuave),
                const SizedBox(width: Gap.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        pedido.direccion!.destinatario,
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                      ),
                      Text(
                        pedido.direccion!.resumen,
                        style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: Gap.lg),
        ],

        // Una línea por concepto. Ver el comentario de `DesgloseDePrecio`.
        DesgloseDePrecio(pedido: pedido),
        const SizedBox(height: Gap.lg),

        FilledButton(
          onPressed: onPagar,
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: const Text('Pagar', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: Gap.sm),
        const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline_rounded, size: 13, color: AppColor.textoDebil),
            SizedBox(width: 5),
            Text(
              'Pago protegido por Mercado Pago',
              style: TextStyle(fontSize: 12, color: AppColor.textoDebil),
            ),
          ],
        ),
      ],
    );
  }
}

/// El WebView con el CardForm de Mercado Pago.
///
/// Los campos sensibles son iframes de ellos. Lo único que vuelve por el
/// puente es un token de un solo uso.
class _FormularioDeTarjeta extends StatefulWidget {
  const _FormularioDeTarjeta({required this.pedido, required this.onToken});

  final Pedido pedido;
  final void Function(String cardToken, String paymentMethodId) onToken;

  @override
  State<_FormularioDeTarjeta> createState() => _FormularioDeTarjetaState();
}

class _FormularioDeTarjetaState extends State<_FormularioDeTarjeta> {
  late final WebViewController _controlador;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();

    final base = RuntimeConfig.instance.apiBaseUrl;
    // Lleva el prefijo `/api` como el resto —a diferencia de los webhooks, que
    // están excluidos porque su URL la configura Mercado Pago a mano—. Ésta la
    // arma la app en cada compra, así que puede cambiar con la app.
    final url = Uri.parse('$base/api/checkout/card').replace(queryParameters: {
      'orderId': widget.pedido.id,
      // Sólo para MOSTRAR. El monto que se cobra sale de la orden en el
      // backend: si esta URL dijera $1, se cobraría el total igual.
      'amount': '${widget.pedido.grossAmount}',
      'desc': widget.pedido.lineas.firstOrNull?.nombre ?? 'Compra en VendoX',
    });

    _controlador = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppColor.superficie)
      ..addJavaScriptChannel(
        // El puente por el que vuelve el token. Nada más cruza por acá.
        'MpBridge',
        onMessageReceived: (mensaje) {
          try {
            final datos = jsonDecode(mensaje.message) as Map<String, dynamic>;
            final token = datos['token'] as String?;
            final metodo = datos['paymentMethodId'] as String?;
            if (token != null && metodo != null) widget.onToken(token, metodo);
          } catch (_) {
            // Un mensaje mal formado no puede tumbar el checkout.
          }
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(onPageFinished: (_) => setState(() => _cargando = false)),
      )
      ..loadRequest(url);
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.62,
      child: Stack(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(Redondeo.md),
            child: WebViewWidget(controller: _controlador),
          ),
          if (_cargando)
            const ColoredBox(
              color: AppColor.superficie,
              child: Center(child: CircularProgressIndicator()),
            ),
        ],
      ),
    );
  }
}

class _Resultado extends StatelessWidget {
  const _Resultado({
    required this.pedido,
    required this.error,
    required this.onReintentar,
    required this.onListo,
  });

  final Pedido? pedido;
  final String? error;
  final VoidCallback onReintentar;
  final VoidCallback onListo;

  @override
  Widget build(BuildContext context) {
    final estado = pedido?.estado;

    final (icono, color) = switch (estado?.tono) {
      TonoDeEstado.exito => (Icons.check_circle_rounded, AppColor.exito),
      TonoDeEstado.error => (Icons.error_outline_rounded, AppColor.error),
      TonoDeEstado.alerta => (Icons.info_outline_rounded, AppColor.alerta),
      TonoDeEstado.enCurso => (Icons.schedule_rounded, AppColor.alerta),
      _ => (Icons.info_outline_rounded, AppColor.textoSuave),
    };

    // Sólo se ofrece reintentar cuando SABEMOS que el cobro se rechazó. Si el
    // resultado es incierto, ofrecer pagar de nuevo cobraría dos veces.
    final puedeReintentar = pedido?.sePuedePagar ?? false;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(icono, size: 48, color: color),
        const SizedBox(height: Gap.lg),
        Text(
          estado?.titulo ?? 'Algo salió mal',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: Gap.sm),
        Text(
          error ?? estado?.detalle ?? '',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
        ),
        if (pedido != null) ...[
          const SizedBox(height: Gap.lg),
          Text(
            'Pedido ${pedido!.referencia}',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12.5, color: AppColor.textoDebil),
          ),
        ],
        const SizedBox(height: Gap.xl),
        if (puedeReintentar) ...[
          FilledButton(
            onPressed: onReintentar,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
            child: const Text('Probar con otra tarjeta'),
          ),
          const SizedBox(height: Gap.sm),
          TextButton(onPressed: onListo, child: const Text('Después')),
        ] else
          FilledButton(
            onPressed: onListo,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
            child: const Text('Listo'),
          ),
      ],
    );
  }
}
