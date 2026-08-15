import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

import 'tokens.dart';

/// Tema de la aplicación.
///
/// Se define UNA vez y los widgets no vuelven a nombrar colores ni tamaños.
/// Cuando cada pantalla elige sus propios valores, cambiar el acento del
/// producto se convierte en una búsqueda por todo el proyecto y siempre queda
/// alguno viejo.
ThemeData buildAppTheme() {
  const esquema = ColorScheme.dark(
    primary: AppColor.acento,
    onPrimary: Colors.white,
    secondary: AppColor.acento,
    surface: AppColor.superficie,
    onSurface: AppColor.texto,
    error: AppColor.error,
    outline: AppColor.borde,
  );

  // Inter: alta legibilidad en tamaños chicos, que es donde vive la mayoría de
  // la interfaz sobre video —precios, nombres, contadores—.
  final base = GoogleFonts.interTextTheme(ThemeData.dark().textTheme);

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: esquema,
    scaffoldBackgroundColor: AppColor.fondo,
    splashFactory: InkSparkle.splashFactory,
    textTheme: base.apply(bodyColor: AppColor.texto, displayColor: AppColor.texto).copyWith(
          // Los precios y los números grandes van más apretados: a tamaños
          // grandes el espaciado por defecto se ve suelto y poco intencional.
          displayLarge:
              base.displayLarge?.copyWith(letterSpacing: -1.5, fontWeight: FontWeight.w700),
          headlineMedium:
              base.headlineMedium?.copyWith(letterSpacing: -0.8, fontWeight: FontWeight.w700),
          titleLarge: base.titleLarge?.copyWith(letterSpacing: -0.4, fontWeight: FontWeight.w600),
          bodyMedium: base.bodyMedium?.copyWith(height: 1.45, color: AppColor.texto),
          bodySmall: base.bodySmall?.copyWith(color: AppColor.textoSuave, height: 1.4),
        ),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: base.titleLarge?.copyWith(
        color: AppColor.texto,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.4,
      ),
      iconTheme: const IconThemeData(color: AppColor.texto),
      // Iconos claros en la barra de estado: el fondo siempre es oscuro.
      systemOverlayStyle: SystemUiOverlayStyle.light,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColor.acento,
        foregroundColor: Colors.white,
        disabledBackgroundColor: AppColor.superficieAlta,
        disabledForegroundColor: AppColor.textoDebil,
        // 52 de alto: por debajo de 48 el pulgar falla, y esta app se usa con
        // una sola mano mientras se mira un video.
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.md)),
        textStyle:
            GoogleFonts.inter(fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: -0.2),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColor.texto,
        minimumSize: const Size.fromHeight(52),
        side: const BorderSide(color: AppColor.borde),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.md)),
        textStyle: GoogleFonts.inter(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColor.textoSuave,
        textStyle: GoogleFonts.inter(fontSize: 14, fontWeight: FontWeight.w500),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColor.superficie,
      contentPadding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.lg),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Redondeo.md),
        borderSide: const BorderSide(color: AppColor.borde),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Redondeo.md),
        borderSide: const BorderSide(color: AppColor.borde),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Redondeo.md),
        borderSide: const BorderSide(color: AppColor.acento, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Redondeo.md),
        borderSide: const BorderSide(color: AppColor.error),
      ),
      labelStyle: const TextStyle(color: AppColor.textoSuave),
      hintStyle: const TextStyle(color: AppColor.textoDebil),
    ),
    cardTheme: CardThemeData(
      color: AppColor.superficie,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.lg)),
      margin: EdgeInsets.zero,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColor.superficie,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.xl)),
      ),
      showDragHandle: true,
      dragHandleColor: AppColor.borde,
    ),
    dividerTheme: const DividerThemeData(color: AppColor.borde, thickness: 1, space: 1),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColor.superficieAlta,
      contentTextStyle: const TextStyle(color: AppColor.texto),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.md)),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: AppColor.acento),
  );
}
