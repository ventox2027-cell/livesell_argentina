import 'package:flutter/material.dart';

/// Sistema de diseño de Live Shopping Argentina.
///
/// ─── Por qué oscuro, y no como opción ───
///
/// La app es video a pantalla completa. Un fondo claro alrededor de un video
/// obliga al ojo a saltar entre dos niveles de brillo muy distintos, cansa en
/// sesiones largas —y una transmisión de venta dura media hora— y le roba
/// contraste a lo único que importa: la imagen del producto.
///
/// No hay modo claro. No es una limitación pendiente: es la decisión.
///
/// ─── Los colores ───
///
/// Un solo acento fuerte, usado con avaricia. Si todo resalta, nada resalta:
/// el botón de comprar tiene que ser lo más brillante de la pantalla siempre,
/// y eso sólo funciona si nada más compite.

abstract final class AppColor {
  // ── Fondos ──
  /// Negro real, no gris oscuro. El video se recorta contra esto.
  static const fondo = Color(0xFF000000);

  /// Superficies elevadas: hojas, tarjetas, campos.
  static const superficie = Color(0xFF141417);
  static const superficieAlta = Color(0xFF1F1F24);
  static const borde = Color(0xFF2A2A31);

  // ── Texto ──
  static const texto = Color(0xFFF5F5F7);
  static const textoSuave = Color(0xFFA1A1AA);
  static const textoDebil = Color(0xFF6B6B76);

  // ── Acento ──
  /// El color de comprar. Se reserva para la acción que genera plata.
  static const acento = Color(0xFFFF3B5C);
  static const acentoOscuro = Color(0xFFD41F3F);

  // ── Estado ──
  /// Rojo de "EN VIVO". Distinto del acento a propósito: uno indica estado,
  /// el otro invita a tocar. Si fueran el mismo, el punto rojo del vivo
  /// parecería un botón.
  static const vivo = Color(0xFFFF1744);
  static const exito = Color(0xFF25C26E);
  static const alerta = Color(0xFFFFB020);
  static const error = Color(0xFFFF4D4F);

  /// Degradado sobre el video para que el texto blanco se lea sin importar
  /// qué haya filmado el vendedor. Sin esto, un producto claro deja los
  /// controles ilegibles.
  static const velo = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0x00000000), Color(0x66000000), Color(0xCC000000)],
    stops: [0.45, 0.72, 1.0],
  );

  static const veloSuperior = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0x99000000), Color(0x00000000)],
  );
}

/// Espaciado en múltiplos de 4.
///
/// Una escala fija evita la deriva: sin ella aparecen paddings de 13, 17 y 22
/// que nadie eligió, y la interfaz se ve descuidada sin que se pueda señalar
/// exactamente por qué.
abstract final class Gap {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const xxl = 32.0;
  static const xxxl = 48.0;
}

abstract final class Redondeo {
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const pill = 999.0;
}

/// Duraciones de animación.
///
/// Nada por encima de 300 ms en interacciones directas: más que eso se percibe
/// como que la app tarda, aunque la respuesta ya esté lista.
abstract final class Duraciones {
  static const instantanea = Duration(milliseconds: 120);
  static const rapida = Duration(milliseconds: 200);
  static const normal = Duration(milliseconds: 300);
}
