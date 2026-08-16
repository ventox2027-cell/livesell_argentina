import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/state/auth_providers.dart';
import '../domain/seller_models.dart';

/// Conectar la cuenta de Mercado Pago del vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA APP NO VE NUNCA UN TOKEN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Lo único que pide es una URL, la abre, y después pregunta cómo quedó. El
/// código de autorización y el token viajan entre Mercado Pago y nuestro
/// backend, servidor a servidor.
///
/// No es una decisión de estilo. El intercambio del código por el token
/// necesita el `client_secret` de la aplicación: si lo hiciera la app, ese
/// secreto estaría dentro del APK, y un APK se descompila en dos minutos. Con
/// ese secreto, cualquiera puede hacerse pasar por VendoX ante Mercado Pago.
///
/// ─── Y se abre en el navegador del sistema, no en un WebView ───
///
/// Mercado Pago pide la contraseña ahí adentro. En un WebView de nuestra app,
/// esa contraseña pasa por una vista que nosotros controlamos — y aunque no la
/// leamos, el vendedor no tiene forma de saber que no la leemos. El navegador
/// del sistema muestra la barra de direcciones con el dominio real y el
/// candado.
class MercadoPagoScreen extends ConsumerStatefulWidget {
  const MercadoPagoScreen({super.key});

  @override
  ConsumerState<MercadoPagoScreen> createState() => _MercadoPagoScreenState();
}

class _MercadoPagoScreenState extends ConsumerState<MercadoPagoScreen> with WidgetsBindingObserver {
  Map<String, dynamic>? _estado;
  bool _cargando = true;
  bool _abriendo = false;
  String? _error;

  /// Si salimos a autorizar. Al volver hay que releer el estado.
  bool _fuimosAAutorizar = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_cargar());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    /**
     * Al volver del navegador se relee el estado.
     *
     * No hay deep link de vuelta: Mercado Pago redirige a nuestro backend, que
     * muestra una página de "listo" y ahí termina. La persona vuelve a la app
     * con el botón del sistema.
     *
     * Un deep link sería más prolijo, pero agrega una superficie —un esquema
     * que cualquier app puede reclamar— para ahorrar una consulta. Preguntar al
     * volver es más simple y no depende de que el sistema resuelva bien quién
     * es el dueño del esquema.
     */
    if (state == AppLifecycleState.resumed && _fuimosAAutorizar) {
      _fuimosAAutorizar = false;
      unawaited(_cargar());
    }
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });

    try {
      final r = await ref
          .read(apiClientProvider)
          .get<Map<String, dynamic>>('/sellers/me/payment-account');
      if (!mounted) return;
      setState(() {
        _estado = r.data;
        _cargando = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _cargando = false;
        _error = 'No pudimos consultar el estado de tu cuenta.';
      });
    }
  }

  Future<void> _conectar() async {
    if (_abriendo) return;
    setState(() => _abriendo = true);

    try {
      final r = await ref
          .read(apiClientProvider)
          .post<Map<String, dynamic>>('/sellers/me/payment-account/connect');

      final url = r.data?['url'] as String?;
      if (url == null) throw StateError('sin url');

      _fuimosAAutorizar = true;
      final abrio = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);

      if (!abrio && mounted) {
        _fuimosAAutorizar = false;
        AppSnack.error(context, 'No pudimos abrir Mercado Pago.');
      }
    } catch (_) {
      _fuimosAAutorizar = false;
      if (mounted) AppSnack.error(context, 'No pudimos empezar la conexión.');
    } finally {
      if (mounted) setState(() => _abriendo = false);
    }
  }

  Future<void> _desconectar() async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('¿Desconectar Mercado Pago?'),
        content: const Text(
          'Los cobros de tus ventas nuevas dejan de ir a tu cuenta hasta que '
          'la vuelvas a conectar.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Desconectar', style: TextStyle(color: AppColor.error)),
          ),
        ],
      ),
    );
    if (confirmado != true) return;

    try {
      await ref.read(apiClientProvider).delete<Map<String, dynamic>>('/sellers/me/payment-account');
      if (!mounted) return;
      AppSnack.info(context, 'Cuenta desconectada.');
      await _cargar();
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos desconectarla.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Cobros')),
      body: RefreshIndicator(onRefresh: _cargar, child: _cuerpo()),
    );
  }

  Widget _cuerpo() {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    if (_error != null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: Gap.xl, vertical: 100),
        children: [
          const Icon(Icons.wifi_off_rounded, size: 44, color: AppColor.textoDebil),
          const SizedBox(height: Gap.lg),
          Text(_error!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 15)),
          const SizedBox(height: Gap.lg),
          Center(child: TextButton(onPressed: _cargar, child: const Text('Reintentar'))),
        ],
      );
    }

    final disponible = _estado?['disponible'] as bool? ?? false;
    final conectada = _estado?['conectada'] as bool? ?? false;
    final comisionBps = (_estado?['comisionBps'] as num?)?.toInt() ?? 600;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, Gap.xxl),
      children: [
        _Estado(conectada: conectada, disponible: disponible, datos: _estado),
        const SizedBox(height: Gap.xl),
        _ComoFunciona(comisionBps: comisionBps),
        const SizedBox(height: Gap.xl),
        if (!disponible)
          const _Aviso(
            /**
             * Sin credenciales cargadas en el servidor. No es un error del
             * vendedor y el texto no puede hacerle creer que hizo algo mal.
             *
             * ⚠️ Antes decía "mientras tanto podés vender igual". Se sacó: dejó
             * de ser cierto cuando conectar Mercado Pago pasó a ser requisito
             * para publicar, y prometerle a alguien que puede vender cuando no
             * puede es peor que no decirle nada.
             */
            texto: 'Estamos terminando de habilitar los cobros con Mercado Pago. '
                'Te avisamos apenas puedas conectar tu cuenta.',
          )
        else if (conectada)
          OutlinedButton(
            onPressed: _desconectar,
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColor.error,
              minimumSize: const Size(0, 50),
            ),
            child: const Text('Desconectar'),
          )
        else
          FilledButton.icon(
            onPressed: _abriendo ? null : _conectar,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
            icon: _abriendo
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.link_rounded),
            label: const Text(
              'Conectar Mercado Pago',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ),
      ],
    );
  }
}

/// `1559520220` → `····0220`.
///
/// Los últimos cuatro alcanzan para lo único que hace falta: que el vendedor
/// confirme que conectó la cuenta que quería. El número entero identifica una
/// cuenta de Mercado Pago real y no gana nada estando a la vista en una captura
/// de pantalla que después se manda por WhatsApp.
String _enmascarar(String cuenta) {
  if (cuenta.length <= 4) return cuenta;
  return '····${cuenta.substring(cuenta.length - 4)}';
}

class _Estado extends StatelessWidget {
  const _Estado({required this.conectada, required this.disponible, this.datos});

  final bool conectada;
  final bool disponible;
  final Map<String, dynamic>? datos;

  @override
  Widget build(BuildContext context) {
    final cuenta = datos?['cuentaDeMercadoPago'] as String?;
    // ⚠️ `tokenTerminaEn` viene en la respuesta y NO se muestra. Es para
    // soporte, que necesita hablar del token sin verlo. Ver abajo.

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: conectada ? AppColor.exito : AppColor.borde),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            conectada ? Icons.check_circle_rounded : Icons.account_balance_wallet_outlined,
            size: 22,
            color: conectada ? AppColor.exito : AppColor.textoSuave,
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  conectada ? 'Cuenta conectada' : 'Sin conectar',
                  style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 3),
                Text(
                  conectada
                      ? 'El dinero de tus ventas entra directo a tu cuenta.'
                      : disponible
                          ? 'Conectala para que el dinero de tus ventas entre directo a tu cuenta.'
                          : 'Todavía no está habilitado en este servidor.',
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColor.textoSuave,
                    height: 1.4,
                  ),
                ),
                if (conectada && cuenta != null) ...[
                  const SizedBox(height: Gap.sm),
                  Text(
                    /**
                     * Sólo la cuenta, enmascarada. Y NO la pista del token.
                     *
                     * La pista existe para que soporte pueda decir "el token
                     * que termina en ····a3f9" sin verlo entero. Eso es útil en
                     * un ticket, no en la pantalla del vendedor: ahí no le
                     * sirve para nada y lo único que hace es poner en pantalla
                     * un pedacito de una credencial.
                     *
                     * De la cuenta alcanzan los últimos cuatro dígitos para lo
                     * que hace falta: confirmar que conectó la que quería.
                     */
                    'Cuenta ${_enmascarar(cuenta)}',
                    style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
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

class _ComoFunciona extends StatelessWidget {
  const _ComoFunciona({required this.comisionBps});

  final int comisionBps;

  @override
  Widget build(BuildContext context) {
    // 600 bps = 6 %. Se muestra el número que manda el servidor, no uno escrito
    // acá: el día que cambie, la pantalla no puede seguir prometiendo el viejo.
    final porcentaje = porcentajeLegible(comisionBps);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'CÓMO FUNCIONA',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.8,
            color: AppColor.textoDebil,
          ),
        ),
        const SizedBox(height: Gap.md),
        const _Punto(
          icono: Icons.account_balance_wallet_outlined,
          /**
           * "VendoX no lo toca en ningún momento" era demasiado absoluto.
           *
           * Técnicamente la plata entra a la cuenta del vendedor y Mercado Pago
           * separa la comisión en el mismo movimiento — pero decirlo como una
           * promesa categórica invita a que alguien la use como argumento el
           * día que haya un reembolso o una contracara. Describir el mecanismo
           * es más honesto y dice lo mismo.
           */
          texto: 'Mercado Pago procesa el cobro en tu cuenta y separa '
              'automáticamente la comisión de VendoX.',
        ),
        _Punto(
          icono: Icons.percent_rounded,
          /**
           * ⚠️ La comisión de VendoX y el costo de Mercado Pago son DOS cosas
           * distintas, y el texto anterior las mezclaba: decía que "Mercado
           * Pago nos descuenta 6 %", como si el 6 % fuera de ellos.
           *
           * No lo es. VendoX cobra 6 % sobre el producto; Mercado Pago cobra lo
           * suyo aparte, según la cuenta y el medio de pago. Confundirlos hace
           * que el vendedor calcule mal su ganancia y después reclame.
           */
          texto: 'VendoX cobra $porcentaje % únicamente sobre el precio del producto.',
        ),
        const _Punto(
          icono: Icons.local_shipping_outlined,
          // Es la duda número uno del vendedor y contestarla acá evita el
          // reclamo.
          texto: 'No cobramos comisión de VendoX sobre el envío ni sobre el costo '
              'del procesador: esa plata es tuya para gastarla.',
        ),
        const _Punto(
          icono: Icons.credit_card_outlined,
          /**
           * Sin porcentaje. La tasa real depende del plazo de acreditación, del
           * medio de pago y del rubro, y la informa Mercado Pago DESPUÉS de
           * cobrar. Escribir un número acá sería prometer algo que no
           * controlamos.
           */
          texto: 'Los costos de Mercado Pago se aplican por separado, según las '
              'condiciones de tu cuenta.',
        ),
        const _Punto(
          icono: Icons.lock_outline_rounded,
          texto: 'Tu contraseña de Mercado Pago la ponés en su sitio, no acá. '
              'Nosotros nunca la vemos.',
        ),
      ],
    );
  }
}

class _Punto extends StatelessWidget {
  const _Punto({required this.icono, required this.texto});

  final IconData icono;
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icono, size: 16, color: AppColor.textoSuave),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Text(
              texto,
              style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso({required this.texto});

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficieAlta,
        borderRadius: BorderRadius.circular(Redondeo.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline_rounded, size: 17, color: AppColor.textoSuave),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              texto,
              style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}
