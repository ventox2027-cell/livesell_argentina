import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/runtime_config.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../domain/session.dart';
import '../state/auth_providers.dart';

/// Pantalla de bienvenida.
///
/// ─── El objetivo es que dure tres segundos ───
///
/// Nadie descarga esta app para registrarse: la descarga para ver a alguien
/// vendiendo algo. Cada campo que se pida acá es gente que se va antes de ver
/// el primer video.
///
/// Por eso no hay formulario. Un toque, y adentro. El teléfono se pide recién
/// cuando quiere comprar, que es el momento en que tiene un motivo para darlo.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  bool _ocupado = false;

  Future<void> _correr(Future<void> Function() accion) async {
    if (_ocupado) return;
    setState(() => _ocupado = true);
    try {
      await accion();
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final motivo = switch (ref.watch(sesionProvider)) {
      SinSesion(motivo: final m) => m,
      _ => null,
    };

    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: [
          const _FondoAnimado(),
          // El velo garantiza contraste del texto sobre el fondo animado.
          const DecoratedBox(decoration: BoxDecoration(gradient: AppColor.velo)),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.xl, Gap.xl, Gap.xxl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Spacer(flex: 3),
                  const _Marca(),
                  const SizedBox(height: Gap.lg),
                  Text(
                    'Comprá mientras\nlo estás viendo.',
                    style: Theme.of(context).textTheme.displaySmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          height: 1.05,
                          letterSpacing: -1.6,
                        ),
                  ),
                  const SizedBox(height: Gap.md),
                  const Text(
                    'Vendedores de todo el país, en vivo.\nSin carrito, sin vueltas.',
                    style: TextStyle(color: AppColor.textoSuave, fontSize: 16, height: 1.45),
                  ),
                  const Spacer(flex: 2),

                  if (motivo != null) ...[
                    _Aviso(motivo),
                    const SizedBox(height: Gap.lg),
                  ],

                  _BotonProveedor(
                    etiqueta: 'Continuar con Google',
                    icono: Icons.g_mobiledata_rounded,
                    tamanoIcono: 30,
                    fondo: Colors.white,
                    texto: Colors.black87,
                    onTap: _ocupado ? null : _google,
                  ),
                  const SizedBox(height: Gap.md),
                  _BotonProveedor(
                    etiqueta: 'Continuar con Apple',
                    icono: Icons.apple,
                    fondo: AppColor.superficieAlta,
                    texto: AppColor.texto,
                    onTap: _ocupado ? null : _apple,
                  ),

                  const SizedBox(height: Gap.xl),
                  const Text(
                    'Al continuar aceptás los Términos y la Política de privacidad.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColor.textoDebil, fontSize: 12, height: 1.4),
                  ),

                  // Acceso de desarrollo. Se muestra sólo si el backend lo
                  // habilita, que en producción está prohibido por configuración.
                  const SizedBox(height: Gap.sm),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      TextButton(
                        onPressed: _ocupado ? null : _accesoDePrueba,
                        child: const Text('Entrar en modo prueba'),
                      ),
                      const Text('·', style: TextStyle(color: AppColor.textoDebil)),
                      /// Configurar el backend TIENE que estar disponible antes
                      /// de entrar. Escondido detrás del login, una instalación
                      /// nueva apuntando a una URL vieja no tiene salida: no se
                      /// puede iniciar sesión ni cambiar a dónde apunta.
                      TextButton(
                        onPressed: _ocupado ? null : _configurarBackend,
                        child: const Text('Configurar servidor'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          if (_ocupado)
            const ColoredBox(
              color: Color(0x99000000),
              child: Center(child: CircularProgressIndicator()),
            ),
        ],
      ),
    );
  }

  Future<void> _google() async {
    /// Google Sign-In todavía no está conectado: requiere los client IDs del
    /// proyecto de Firebase, que se configuran junto con las notificaciones.
    ///
    /// El backend YA verifica estos tokens (`identity.service.ts`), así que lo
    /// único que falta es obtenerlos. Mientras tanto se dice claramente en vez
    /// de mostrar un botón que no hace nada.
    AppSnack.info(
      context,
      'Falta configurar Google en el proyecto de Firebase. Usá "modo prueba" por ahora.',
    );
  }

  Future<void> _apple() async {
    AppSnack.info(
      context,
      'Apple se habilita junto con la cuenta de desarrollador. Usá "modo prueba" por ahora.',
    );
  }

  /// Cambia a qué backend apunta la app, sin recompilar.
  ///
  /// En pruebas de campo la URL del túnel cambia cada vez que se reinicia, y
  /// recompilar e instalar en dos teléfonos por eso cuesta veinte minutos.
  Future<void> _configurarBackend() async {
    final ctrl = TextEditingController(text: RuntimeConfig.instance.apiBaseUrl);
    final nueva = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: Gap.xl,
          right: Gap.xl,
          top: Gap.sm,
          bottom: MediaQuery.viewInsetsOf(ctx).bottom + Gap.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Servidor', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: Gap.sm),
            const Text(
              'A qué backend se conecta la app. Con el túnel de Cloudflare, la '
              'URL cambia cada vez que se reinicia.',
              style: TextStyle(color: AppColor.textoSuave, fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: Gap.lg),
            TextField(
              controller: ctrl,
              autofocus: true,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'URL del backend',
                hintText: 'https://algo.trycloudflare.com',
              ),
            ),
            const SizedBox(height: Gap.lg),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
              child: const Text('Guardar y probar'),
            ),
          ],
        ),
      ),
    );
    ctrl.dispose();

    if (nueva == null || nueva.isEmpty || !mounted) return;

    await _correr(() async {
      await RuntimeConfig.instance.setApiBaseUrl(nueva);
      // El cliente HTTP guarda la URL base al construirse: hay que reapuntarlo
      // o seguiría hablando con el servidor anterior.
      ref.read(apiClientProvider).applyConfig();

      // Se comprueba de inmediato. Guardar una URL que no responde y
      // enterarse recién al intentar entrar es hacer perder tiempo.
      final res = await ref.read(apiClientProvider).get<Map<String, dynamic>>(
            '/auth/me',
            sinAuth: true,
          );
      if (!mounted) return;
      // 401 es la respuesta esperada sin sesión: significa que el backend está
      // vivo y respondiendo.
      if (res.statusCode == 401 || res.statusCode == 200) {
        AppSnack.exito(context, 'Servidor OK');
      } else {
        AppSnack.error(context, 'El servidor respondió ${res.statusCode}');
      }
    });
  }

  /// Acceso de prueba: pide sólo un email y entra.
  Future<void> _accesoDePrueba() async {
    final email = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _HojaAccesoPrueba(),
    );
    if (email == null || !mounted) return;

    await _correr(() => ref.read(sesionProvider.notifier).deDesarrollo(email: email));
  }
}

/// Fondo con gradiente en movimiento lento.
///
/// Sin video ni imágenes: una bienvenida que descarga assets tarda, y es la
/// primera impresión de la app. Esto pesa cero y arranca al instante.
class _FondoAnimado extends StatefulWidget {
  const _FondoAnimado();

  @override
  State<_FondoAnimado> createState() => _FondoAnimadoState();
}

class _FondoAnimadoState extends State<_FondoAnimado> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 14),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) {
        final t = Curves.easeInOut.transform(_c.value);
        return DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment(-1 + t * 0.6, -1),
              end: Alignment(1 - t * 0.4, 1),
              colors: const [
                Color(0xFF2A0A18),
                Color(0xFF12040B),
                AppColor.fondo,
              ],
              stops: const [0.0, 0.45, 1.0],
            ),
          ),
        );
      },
    );
  }
}

class _Marca extends StatelessWidget {
  const _Marca();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [AppColor.acento, AppColor.acentoOscuro]),
            borderRadius: BorderRadius.circular(Redondeo.md),
          ),
          child: const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 26),
        ),
        const SizedBox(width: Gap.md),
        const Text(
          'Live Shopping',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.3),
        ),
      ],
    );
  }
}

class _BotonProveedor extends StatelessWidget {
  const _BotonProveedor({
    required this.etiqueta,
    required this.icono,
    required this.fondo,
    required this.texto,
    required this.onTap,
    this.tamanoIcono = 22,
  });

  final String etiqueta;
  final IconData icono;
  final Color fondo;
  final Color texto;
  final VoidCallback? onTap;
  final double tamanoIcono;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: onTap,
      style: FilledButton.styleFrom(backgroundColor: fondo, foregroundColor: texto),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icono, size: tamanoIcono),
          const SizedBox(width: Gap.md),
          Text(etiqueta),
        ],
      ),
    );
  }
}

class _Aviso extends StatelessWidget {
  const _Aviso(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.alerta.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.alerta.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, color: AppColor.alerta, size: 18),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(texto, style: const TextStyle(color: AppColor.alerta, fontSize: 13)),
          ),
        ],
      ),
    );
  }
}

class _HojaAccesoPrueba extends StatefulWidget {
  const _HojaAccesoPrueba();

  @override
  State<_HojaAccesoPrueba> createState() => _HojaAccesoPruebaState();
}

class _HojaAccesoPruebaState extends State<_HojaAccesoPrueba> {
  final _ctrl = TextEditingController(text: 'prueba@livesell.ar');

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.sm,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Modo prueba', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: Gap.sm),
          const Text(
            'Entra sin proveedor externo. Sólo funciona contra un backend de '
            'desarrollo: en producción está deshabilitado.',
            style: TextStyle(color: AppColor.textoSuave, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Email'),
            onSubmitted: (v) => Navigator.of(context).pop(v.trim()),
          ),
          const SizedBox(height: Gap.md),
          Text(
            'Backend: ${RuntimeConfig.instance.apiBaseUrl}',
            style: const TextStyle(color: AppColor.textoDebil, fontSize: 11),
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(_ctrl.text.trim()),
            child: const Text('Entrar'),
          ),
        ],
      ),
    );
  }
}
