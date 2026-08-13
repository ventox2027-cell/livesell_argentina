import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/config/runtime_config.dart';
import 'features/spike/presentation/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Tiene que cargar ANTES de runApp: SpikeApi lee la URL del backend al
  // construirse y RuntimeConfig.instance lanza si no estÃ¡ inicializado.
  await RuntimeConfig.load();

  // El producto es vertical. Bloquear la orientaciÃ³n evita que una rotaciÃ³n
  // accidental durante una mediciÃ³n cambie la resoluciÃ³n de captura y
  // contamine la muestra.
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const ProviderScope(child: SpikeApp()));
}

class SpikeApp extends StatelessWidget {
  const SpikeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LiveSell Â· Spike',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFFF2D55),
          brightness: Brightness.dark,
        ),
        // Botones grandes: se opera con una mano, en la calle, mirando la pantalla
        // de reojo mientras se sostiene otro telÃ©fono.
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(56),
            textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
          ),
        ),
      ),
      // Si falta la clave, la pantalla de inicio igual permite cargarla a mano:
      // ya no hace falta recompilar para configurar la app.
      home: const HomeScreen(),
    );
  }
}
