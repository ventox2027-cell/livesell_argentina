import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/google_signin_service.dart';
import '../../../core/config/entorno.dart';
import '../../../core/config/paginas_publicas.dart';
import '../../../core/config/runtime_config.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/auth_config.dart';
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

    // La configuración decide qué botones tienen sentido. Ofrecer "modo
    // prueba" contra un servidor que lo tiene apagado es prometer algo que va
    // a fallar.
    final config = ref.watch(authConfigProvider).valueOrNull ?? const AuthConfig();

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
                  // Era texto plano. Decir "aceptás la Política de privacidad"
                  // sin dar forma de leerla es pedir un consentimiento a ciegas,
                  // y Google Play lo pide enlazado.
                  DefaultTextStyle.merge(
                    style: const TextStyle(
                      color: AppColor.textoDebil,
                      fontSize: 12,
                      height: 1.4,
                    ),
                    child: const EnlacesLegales(
                      prefijo: 'Al continuar aceptás los Términos y la ',
                    ),
                  ),

                  const SizedBox(height: Gap.sm),
                  _AccesosDeServicio(accesos: _accesosDeServicio(config)),
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

  /// Los accesos de servicio que corresponden a esta compilación y a este
  /// servidor.
  ///
  /// ═════════════════════════════════════════════════════════════════════════
  /// TRES CANDADOS DISTINTOS
  /// ═════════════════════════════════════════════════════════════════════════
  ///
  /// Se agrupan acá porque cada uno depende de algo diferente y mezclarlos en
  /// el `build` hacía imposible ver cuál dependía de qué:
  ///
  ///   · **modo prueba** y **acceso de revisión** los habilita el SERVIDOR
  ///     (`/auth/config`). No están en la app: ofrecerlos contra un backend que
  ///     los tiene apagados es prometer algo que va a fallar, y `production`
  ///     tiene prohibido encender el primero por configuración.
  ///   · **configurar servidor** lo habilita la COMPILACIÓN. Es lo único que
  ///     el backend no puede decidir, porque justamente sirve para cambiar de
  ///     backend.
  List<({String etiqueta, VoidCallback accion})> _accesosDeServicio(AuthConfig config) => [
        /**
         * El acceso de desarrollo lleva DOS candados, no uno.
         *
         * El del servidor ya existía: `env.schema.ts` prohíbe encender
         * `AUTH_DEV_LOGIN_ENABLED` en producción. El de compilación se agregó
         * al migrar el paquete, cuando el escaneo de la APK encontró que la
         * hoja de este acceso —con su correo de ejemplo adentro— seguía
         * viajando en el binario de release.
         *
         * No era alcanzable: el botón sólo aparece si el servidor lo habilita,
         * y una APK de release no puede cambiar de servidor. Pero código que
         * nunca se va a ejecutar en producción no tiene por qué estar ahí.
         *
         * ⚠️ El acceso de REVISIÓN de abajo es distinto y NO lleva este
         * candado: tiene que funcionar en la APK que revisa Google.
         */
        if (Entorno.herramientas && config.devLoginEnabled)
          (etiqueta: 'Entrar en modo prueba', accion: _accesoDePrueba),

        /**
         * El acceso de la cuenta de revisión de Google Play.
         *
         * Discreto y con nombre explícito, no escondido detrás de un gesto
         * secreto: quien revisa la app recibe instrucciones y tiene que poder
         * encontrarlo sin adivinar. Y una persona normal lee "revisión" y sigue
         * de largo.
         */
        if (config.demoLoginEnabled) (etiqueta: 'Acceso de revisión', accion: _accesoDeRevision),

        /**
         * Configurar el backend: sólo en las compilaciones de prueba.
         *
         * Tiene que estar ANTES de entrar —escondido detrás del login, una
         * instalación nueva apuntando a una URL vieja no tiene salida— y a la
         * vez no puede viajar en la APK pública: un botón que apunta la app al
         * servidor que uno quiera, en el teléfono de otra persona, es alguien
         * redirigiéndola a un servidor suyo y viendo pasar todo lo que la app
         * manda.
         *
         * Las APKs de prueba de campo se compilan con
         * `--dart-define=VENDOX_HERRAMIENTAS=true` y conservan el botón. Ver
         * `core/config/entorno.dart`.
         */
        if (Entorno.herramientas) (etiqueta: 'Configurar servidor', accion: _configurarBackend),
      ];

  Future<void> _google() async {
    var config = ref.read(authConfigProvider).valueOrNull;

    /**
     * Si no se pudo leer la configuración, se vuelve a pedir ANTES de opinar.
     *
     * El caso real: la app arrancó con el teléfono todavía sin WiFi, o con el
     * backend cayéndose. `authConfigProvider` cacheó una configuración vacía
     * para toda la sesión, y el botón contestaba "Google no está configurado en
     * este servidor" con el servidor andando perfectamente. La única salida era
     * cerrar la app, y nada lo sugería.
     */
    if (config == null || !config.alcanzable) {
      ref.invalidate(authConfigProvider);
      config = await ref.read(authConfigProvider.future);
    }

    if (!mounted) return;
    final leida = config ?? const AuthConfig.sinConexion();

    // Dos problemas distintos, dos mensajes distintos. Antes eran el mismo, y
    // el que se mostraba era el que mandaba a revisar el lugar equivocado.
    if (!leida.alcanzable) {
      AppSnack.error(
        context,
        'No pudimos conectarnos al servidor. Revisá la WiFi o cambiá la dirección abajo.',
      );
      return;
    }

    final serverClientId = leida.googleServerClientId;
    if (serverClientId == null || serverClientId.isEmpty) {
      AppSnack.info(
        context,
        'Google no está configurado en este servidor. Usá "modo prueba" por ahora.',
      );
      return;
    }

    await _correr(() async {
      await GoogleSignInService.instance.inicializar(serverClientId: serverClientId);
      final idToken = await GoogleSignInService.instance.obtenerIdToken();

      // `null` = la persona cerró el selector. No es un error y no se le
      // muestra nada: cancelar es una decisión válida.
      if (idToken == null) return;

      await ref.read(sesionProvider.notifier).conGoogle(idToken);
    });
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

  /// El acceso de la cuenta de revisión de Google Play.
  ///
  /// Del otro lado sólo autentica cuentas marcadas como demostración: una
  /// cuenta normal no entra por acá ni con la contraseña correcta.
  Future<void> _accesoDeRevision() async {
    final credenciales = await showModalBottomSheet<({String email, String password})>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _HojaAccesoRevision(),
    );
    if (credenciales == null || !mounted) return;

    await _correr(
      () => ref.read(sesionProvider.notifier).deRevision(
            email: credenciales.email,
            password: credenciales.password,
          ),
    );
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

/// La fila de accesos de servicio, con sus separadores.
///
/// ⚠️ Los separadores se intercalan, no se pegan a cada botón.
///
/// Antes cada acceso opcional agregaba su botón Y un `·` detrás. Con los tres
/// visibles se leía bien; con uno solo quedaba «Acceso de revisión ·», un punto
/// colgando al final que en la APK de Google Play iba a ser el caso normal —
/// justamente el que nadie mira mientras desarrolla, porque en debug están los
/// tres.
class _AccesosDeServicio extends StatelessWidget {
  const _AccesosDeServicio({required this.accesos});

  final List<({String etiqueta, VoidCallback accion})> accesos;

  @override
  Widget build(BuildContext context) {
    if (accesos.isEmpty) return const SizedBox.shrink();

    final hijos = <Widget>[];
    for (final a in accesos) {
      if (hijos.isNotEmpty) {
        hijos.add(const Text('·', style: TextStyle(color: AppColor.textoDebil)));
      }
      hijos.add(TextButton(onPressed: a.accion, child: Text(a.etiqueta)));
    }

    return Row(mainAxisAlignment: MainAxisAlignment.center, children: hijos);
  }
}

class _Marca extends StatelessWidget {
  const _Marca();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // El logo trae su propio fondo negro, que sobre esta pantalla oscura
        // desaparece y deja sólo el neón. Por eso no lleva contenedor de color
        // detrás: se lo comería.
        ClipRRect(
          borderRadius: BorderRadius.circular(Redondeo.md),
          child: Image.asset(
            'assets/logo/vendox.png',
            width: 44,
            height: 44,
            // Los assets no fallan en tiempo de ejecución salvo que alguien los
            // saque del pubspec. Si pasa, la bienvenida no puede romperse.
            errorBuilder: (_, __, ___) => Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [AppColor.acento, AppColor.acentoOscuro],
                ),
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 26),
            ),
          ),
        ),
        const SizedBox(width: Gap.md),
        const Text(
          'VendoX',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, letterSpacing: -0.4),
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
  final _ctrl = TextEditingController(text: 'prueba@vendox.com.ar');

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

/// La hoja del acceso de revisión.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES UN LOGIN DE USUARIOS
/// ═══════════════════════════════════════════════════════════════════════════
///
/// VendoX no tiene registro con contraseña. Esta pantalla existe para que quien
/// revisa la app en Google Play pueda entrar con credenciales que le entregamos
/// nosotros, sin depender de una cuenta de Google real —que puede pedirle una
/// verificación cuando entra desde otro país—.
///
/// El texto lo dice explícitamente: si alguien que no es revisor llega hasta
/// acá, tiene que entender de inmediato que no es para él.
class _HojaAccesoRevision extends StatefulWidget {
  const _HojaAccesoRevision();

  @override
  State<_HojaAccesoRevision> createState() => _HojaAccesoRevisionState();
}

class _HojaAccesoRevisionState extends State<_HojaAccesoRevision> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _verContrasena = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _entrar() {
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) return;
    Navigator.of(context).pop((email: email, password: password));
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
          Text('Acceso de revisión', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: Gap.sm),
          const Text(
            'Para quien revisa la app en Google Play. Si sos una persona '
            'usuaria, entrá con Google o con Apple.',
            style: TextStyle(color: AppColor.textoSuave, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _email,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            // Sin autocapitalización: un email con la primera en mayúscula es
            // el error más común de este formulario en Android.
            textCapitalization: TextCapitalization.none,
            decoration: const InputDecoration(labelText: 'Email'),
          ),
          const SizedBox(height: Gap.md),
          TextField(
            controller: _password,
            obscureText: !_verContrasena,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: 'Contraseña',
              // Poder verla importa: la contraseña de revisión es larga y se
              // tipea desde una hoja de instrucciones.
              suffixIcon: IconButton(
                icon: Icon(
                  _verContrasena ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                ),
                onPressed: () => setState(() => _verContrasena = !_verContrasena),
              ),
            ),
            onSubmitted: (_) => _entrar(),
          ),
          const SizedBox(height: Gap.lg),
          FilledButton(onPressed: _entrar, child: const Text('Entrar')),
        ],
      ),
    );
  }
}
