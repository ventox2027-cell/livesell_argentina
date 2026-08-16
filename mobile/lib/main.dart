import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app_shell.dart';
import 'core/config/runtime_config.dart';
import 'core/design/theme.dart';
import 'core/enlaces/navegador_de_enlaces.dart';
import 'core/enlaces/pantallas_de_destino.dart';
import 'core/push/push_service.dart';

/// Live Shopping Argentina.
///
/// El arranque hace lo mínimo indispensable y nada más: cada milisegundo acá
/// es tiempo de pantalla en blanco. La sesión se restaura en segundo plano,
/// desde `AppShell`, para que la primera imagen aparezca cuanto antes.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // La URL del backend se lee del almacenamiento local: permite reapuntar la
  // app sin recompilar, que en pruebas de campo con dos teléfonos es la
  // diferencia entre cinco segundos y veinte minutos.
  await RuntimeConfig.load();

  /**
   * Firebase, para los avisos push.
   *
   * ⚠️ Sólo enciende el motor: NO pide permiso ni pregunta el token. En
   * Android 13+ el diálogo del permiso se muestra una sola vez de verdad, y
   * gastarlo en el arranque —cuando la persona todavía no sabe qué es esto—
   * lo convierte en un «no» casi seguro. Se pide después de la primera
   * compra. Ver `core/push/push_service.dart`.
   *
   * Si falta `google-services.json` esto no tira: registra y sigue. Un clon
   * del repositorio tiene que poder arrancar, y los avisos son una mejora, no
   * un requisito para vender.
   */
  await PushService.instance.inicializar();

  /**
   * Los enlaces de vendox.com.ar y los avisos push llevan al MISMO lugar.
   *
   * Los dos pasan por `core/enlaces/destino.dart`. Con dos resolutores, el
   * mismo producto abriría una pantalla desde WhatsApp y otra desde una
   * notificación.
   */
  final enlaces = NavegadorDeEnlaces.instance;
  enlaces.pantallaDe = pantallaDeDestino;
  enlaces.abrirEnNavegador = abrirUrlEnNavegador;
  PushService.instance.alTocar = enlaces.manejar;
  await enlaces.inicializar();

  // Barra de estado transparente: el video llega hasta arriba de todo.
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF0A0A0C),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );

  // Sólo vertical. Un feed de video en horizontal no tiene sentido en este
  // producto, y soportarlo obligaría a diseñar dos veces cada pantalla.
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const ProviderScope(child: LiveSellApp()));
}

class LiveSellApp extends StatelessWidget {
  const LiveSellApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VendoX',
      // La usa `NavegadorDeEnlaces` para abrir una pantalla desde un enlace o
      // un aviso, sin tener un `BuildContext` a mano.
      navigatorKey: NavegadorDeEnlaces.instance.llave,
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      // Sin tema claro: la app es video a pantalla completa y un fondo claro
      // le roba contraste a lo único que importa. Ver core/design/tokens.dart.
      themeMode: ThemeMode.dark,
      home: const AppShell(),
      builder: (context, child) {
        // El tamaño de fuente del sistema se respeta hasta 1.3×. Más allá, los
        // precios y los botones de compra se rompen: es preferible acotarlo a
        // que alguien no pueda comprar porque el botón quedó fuera de pantalla.
        final escala = MediaQuery.textScalerOf(context).clamp(
          minScaleFactor: 0.85,
          maxScaleFactor: 1.3,
        );
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: escala),
          child: child!,
        );
      },
    );
  }
}
