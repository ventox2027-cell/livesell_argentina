import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tokens.dart';

/// Tema de la aplicación.
///
/// Se define UNA vez y los widgets no vuelven a nombrar colores ni tamaños.
/// Cuando cada pantalla elige sus propios valores, cambiar el acento del
/// producto se convierte en una búsqueda por todo el proyecto y siempre queda
/// alguno viejo.
ThemeData buildAppTheme() {
  /**
   * `secondary` es cyan, no una copia del violeta.
   *
   * Material lo usa para lo que está seleccionado o resaltado sin ser la
   * acción principal: la pestaña activa, el chip elegido, el cursor de un
   * campo. Ese es exactamente el trabajo del cyan en la paleta VendoX —
   * información y selección— y el del violeta es otro: la acción que genera
   * plata.
   *
   * Cuando los dos eran el mismo color, un chip seleccionado se veía igual que
   * un botón de comprar, y la única forma de saber cuál hacía qué era tocarlo.
   */
  const esquema = ColorScheme.dark(
    primary: AppColor.acento,
    onPrimary: Colors.white,
    secondary: AppColor.info,
    onSecondary: AppColor.sobreCyan,
    tertiary: AppColor.exito,
    onTertiary: AppColor.sobreLima,
    surface: AppColor.superficie,
    onSurface: AppColor.texto,
    error: AppColor.error,
    outline: AppColor.borde,
  );

  /**
   * Inter: alta legibilidad en tamaños chicos, que es donde vive la mayoría de
   * la interfaz sobre video —precios, nombres, contadores—.
   *
   * ⚠️ Va EMPAQUETADA, no se descarga. Antes la traía `google_fonts`, que la
   * baja de fonts.gstatic.com en el primer arranque: eso mandaba la IP de cada
   * persona a Google sólo para dibujar texto, y dejaba la app con la
   * tipografía del sistema hasta que hubiera red. Ver `pubspec.yaml`.
   *
   * Con `fontFamily` en el tema alcanza: Flutter la aplica a todo el árbol y
   * elige el peso del archivo que corresponda entre los seis declarados.
   */
  const familia = 'Inter';
  final base = ThemeData.dark().textTheme.apply(fontFamily: familia);

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    // También a nivel de tema: un `TextStyle` suelto sin familia la hereda de
    // acá, igual que antes la heredaba del tema que armaba `google_fonts`.
    fontFamily: familia,
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
            const TextStyle(fontFamily: familia, fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: -0.2),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColor.texto,
        minimumSize: const Size.fromHeight(52),
        side: const BorderSide(color: AppColor.borde),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.md)),
        textStyle: const TextStyle(fontFamily: familia, fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColor.textoSuave,
        textStyle: const TextStyle(fontFamily: familia, fontSize: 14, fontWeight: FontWeight.w500),
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LOS CONTROLES CHICOS TAMBIÉN SON LA MARCA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un switch celeste de Material adentro de una app violeta y magenta se
     * nota más que un botón mal pintado, porque aparece en pantallas de
     * ajustes donde no hay nada más que mirar.
     *
     * Todo lo de acá abajo existía con los valores por defecto de Material 3.
     */

    /// Prendido = violeta: es una acción, cambia algo.
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((estados) {
        if (estados.contains(WidgetState.disabled)) return AppColor.inactivo;
        if (estados.contains(WidgetState.selected)) return Colors.white;
        return AppColor.textoDebil;
      }),
      trackColor: WidgetStateProperty.resolveWith((estados) {
        if (estados.contains(WidgetState.disabled)) return AppColor.superficieAlta;
        if (estados.contains(WidgetState.selected)) return AppColor.acento;
        return AppColor.superficieAlta;
      }),
      trackOutlineColor: WidgetStateProperty.resolveWith((estados) {
        if (estados.contains(WidgetState.selected)) return AppColor.acento;
        return AppColor.borde;
      }),
    ),

    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((estados) {
        if (estados.contains(WidgetState.selected)) return AppColor.acento;
        return Colors.transparent;
      }),
      checkColor: const WidgetStatePropertyAll(Colors.white),
      side: const BorderSide(color: AppColor.borde, width: 1.5),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(Redondeo.sm / 2)),
      ),
    ),

    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith((estados) {
        if (estados.contains(WidgetState.selected)) return AppColor.acento;
        return AppColor.textoDebil;
      }),
    ),

    /// Un chip elegido es información —«estás filtrando por esto»—, no una
    /// acción. Por eso cyan y no violeta.
    chipTheme: const ChipThemeData(
      backgroundColor: AppColor.superficieAlta,
      selectedColor: AppColor.infoSuave,
      disabledColor: AppColor.superficie,
      labelStyle: TextStyle(
        color: AppColor.textoSuave,
        fontSize: 13.5,
        fontWeight: FontWeight.w500,
      ),
      secondaryLabelStyle: TextStyle(
        color: AppColor.info,
        fontSize: 13.5,
        fontWeight: FontWeight.w600,
      ),
      side: BorderSide(color: AppColor.borde),
      shape: StadiumBorder(),
      padding: EdgeInsets.symmetric(horizontal: Gap.md, vertical: Gap.sm),
      showCheckmark: false,
    ),

    /// La pestaña activa, en cyan. Navegar es orientarse, no comprar.
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColor.superficie,
      indicatorColor: AppColor.infoSuave,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      labelTextStyle: WidgetStateProperty.resolveWith((estados) {
        final activo = estados.contains(WidgetState.selected);
        return TextStyle(
          fontSize: 11.5,
          fontWeight: activo ? FontWeight.w600 : FontWeight.w500,
          color: activo ? AppColor.info : AppColor.textoDebil,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((estados) {
        final activo = estados.contains(WidgetState.selected);
        return IconThemeData(
          size: 24,
          color: activo ? AppColor.info : AppColor.textoDebil,
        );
      }),
    ),

    tabBarTheme: const TabBarThemeData(
      labelColor: AppColor.info,
      unselectedLabelColor: AppColor.textoDebil,
      indicatorColor: AppColor.info,
      dividerColor: AppColor.borde,
    ),

    sliderTheme: const SliderThemeData(
      activeTrackColor: AppColor.acento,
      inactiveTrackColor: AppColor.superficieAlta,
      thumbColor: Colors.white,
      overlayColor: AppColor.acentoSuave,
    ),

    dialogTheme: DialogThemeData(
      backgroundColor: AppColor.superficie,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.lg)),
      titleTextStyle: base.titleLarge?.copyWith(
        color: AppColor.texto,
        fontWeight: FontWeight.w600,
      ),
      contentTextStyle: const TextStyle(color: AppColor.textoSuave, height: 1.45),
    ),

    /// El indeterminado es cyan, no violeta.
    ///
    /// Un spinner no es una acción: es información —«esperá»—. Con el violeta
    /// del CTA, media pantalla de carga parecía llena de botones.
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColor.info,
      linearTrackColor: AppColor.superficieAlta,
      circularTrackColor: Colors.transparent,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColor.superficieAlta,
      contentTextStyle: const TextStyle(color: AppColor.texto),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Redondeo.md)),
    ),
  );
}
