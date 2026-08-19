import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app_shell.dart';
import 'core/config/runtime_config.dart';
import 'core/config/traza_de_arranque.dart';
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
  TrazaDeArranque.instancia.empezar();

  await RuntimeConfig.load();
  TrazaDeArranque.instancia.paso('config local');

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LO QUE NO HACE FALTA PARA EL PRIMER FRAME, NO SE ESPERA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Antes acá había dos `await` más: encender Firebase y leer el enlace
   * inicial. Ninguno de los dos hace falta para dibujar la primera pantalla, y
   * los dos son lentos en un arranque en frío — Firebase especialmente.
   *
   * Mientras se esperaban, la persona miraba el logo del sistema. Medido en un
   * teléfono real: ~3 segundos hasta ver algo.
   *
   * Ahora arrancan DESPUÉS de `runApp`. La app dibuja, y esto se resuelve
   * mientras tanto.
   *
   * ⚠️ Diferir el enlace inicial es seguro: `NavegadorDeEnlaces` lo guarda
   * hasta que el árbol está montado —ver `listoParaNavegar()`—, justamente
   * porque un enlace tocado con la app cerrada llega antes de que exista
   * `Navigator`. O sea que ya estaba preparado para esto.
   *
   * Sólo se configura lo que es asignación pura, que no cuesta nada.
   */
  final enlaces = NavegadorDeEnlaces.instance;
  enlaces.pantallaDe = pantallaDeDestino;
  enlaces.abrirEnNavegador = abrirUrlEnNavegador;
  PushService.instance.alTocar = enlaces.manejar;

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

  TrazaDeArranque.instancia.paso('orientación');

  runApp(const ProviderScope(child: LiveSellApp()));

  /**
   * ⚠️ Acá NO se informa nada.
   *
   * Antes se imprimía el reporte justo después de `runApp`, y eso contaba
   * únicamente lo que pasa ANTES de dibujar: config local, orientación,
   * `runApp`. Cuarenta milisegundos, siempre. Un reporte que decía que el
   * arranque estaba perfecto mientras en el teléfono se sentían tres segundos.
   *
   * Lo que faltaba medir era todo lo de después: la sesión, `/auth/me`, la
   * primera pintura, el feed. Ahora el reporte sale cuando hay algo que mirar
   * —ver `FeedScreen`— y estas marcas quedan adentro.
   */
  TrazaDeArranque.instancia.paso('→ runApp');

  /**
   * Y ahora sí, lo lento — con la app ya dibujando.
   *
   * Los dos van juntos y no encadenados: son independientes, y hacer uno
   * después del otro sumaría sus esperas sin ninguna razón.
   *
   * Firebase sólo ENCIENDE el motor: no pide permiso ni pregunta el token. En
   * Android 13+ el diálogo del permiso se muestra una sola vez de verdad, y
   * gastarlo en el arranque —cuando la persona todavía no sabe qué es esto— lo
   * convierte en un «no» casi seguro. Se pide después de la primera compra.
   *
   * Si falta `google-services.json` no tira: registra y sigue. Un clon del
   * repositorio tiene que poder arrancar, y los avisos son una mejora, no un
   * requisito para vender.
   */
  await Future.wait([
    PushService.instance.inicializar().then((_) {
      TrazaDeArranque.instancia.paso('push (Firebase)');
    }),
    enlaces.inicializar().then((_) {
      TrazaDeArranque.instancia.paso('enlaces');
    }),
  ]);

  TrazaDeArranque.instancia.informar('lo que siguió en segundo plano');
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
