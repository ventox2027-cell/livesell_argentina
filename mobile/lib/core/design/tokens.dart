import 'package:flutter/material.dart';

/// Sistema de diseño de VendoX.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ OSCURO, Y NO COMO OPCIÓN
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La app es video a pantalla completa. Un fondo claro alrededor de un video
/// obliga al ojo a saltar entre dos niveles de brillo muy distintos, cansa en
/// sesiones largas —y una transmisión de venta dura media hora— y le roba
/// contraste a lo único que importa: la imagen del producto.
///
/// No hay modo claro. No es una limitación pendiente: es la decisión.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA PALETA VENDOX: CADA COLOR TIENE UN TRABAJO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Cinco colores de marca —cyan, violeta, magenta, lima, grafito— y **ninguno
/// se usa por decoración**. Cada uno significa una cosa y sólo esa:
///
/// | Color   | Significa                                          |
/// |---------|----------------------------------------------------|
/// | violeta | la acción principal: comprar, publicar, transmitir |
/// | magenta | EN VIVO y lo que pide atención ahora               |
/// | cyan    | información, selección, navegación                 |
/// | lima    | salió bien: pagado, conectado, entregado, ganado   |
/// | grafito | todo lo demás                                      |
///
/// Una paleta de cinco colores neón usada sin regla produce una app que parece
/// un arcoíris y donde nada resalta. La regla es lo que la vuelve identidad en
/// vez de ruido: cuando alguien ve lima en VendoX, ya sabe que algo salió bien
/// antes de leer el texto.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ⚠️ EL GRADIENTE DE TRES COLORES NUNCA VA DEBAJO DE TEXTO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la restricción menos obvia y la más importante de este archivo.
///
/// El cyan de marca es clarísimo (luminancia 0,53) y el violeta es oscuro
/// (0,15). Sobre el cyan, el texto blanco da 1,9:1 — ilegible. Sobre el
/// violeta, el texto negro da 3,6:1 — también insuficiente. **No existe un
/// color de texto que sea accesible a lo largo de todo el gradiente
/// cyan → violeta → magenta.**
///
/// Así que se parte en dos:
///
///   · [gradienteAccion] (violeta → magenta) es el que lleva texto. El blanco
///     da 5,2:1 en un extremo y 4,5:1 en el otro: pasa AA en todo el recorrido.
///   · [gradienteMarca] (cyan → violeta → magenta) es el de la marca, y va
///     donde NO hay texto encima: el isotipo, un borde, una barra de progreso,
///     un fondo de encabezado.
///
/// Un gradiente lindo con texto ilegible arriba no es un problema de gusto.
abstract final class AppColor {
  // ── Fondos ──────────────────────────────────────────────────────────────
  /// Negro real, no gris oscuro. El video se recorta contra esto.
  static const fondo = Color(0xFF000000);

  /// Superficies elevadas: hojas, tarjetas, campos. Grafito, no gris neutro:
  /// tiene una pizca de azul para que convivan con el cyan sin verse sucias.
  static const superficie = Color(0xFF121216);
  static const superficieAlta = Color(0xFF1C1C23);
  static const borde = Color(0xFF2A2A34);

  // ── Texto ───────────────────────────────────────────────────────────────
  static const texto = Color(0xFFF5F5F7);
  static const textoSuave = Color(0xFFA1A1AE);
  static const textoDebil = Color(0xFF6B6B7A);

  // ── La acción principal ─────────────────────────────────────────────────
  /// Violeta eléctrico. El color de comprar, publicar y salir en vivo.
  ///
  /// Es el ancla sólida de la marca: donde un gradiente no entra —un ícono, un
  /// borde, un chip seleccionado, un `FilledButton` chico— va esto.
  ///
  /// `#6D4AFF` y no un violeta más claro porque el texto blanco encima tiene
  /// que pasar AA: da 5,2:1. Con `#8B5CF6` daban 4,3:1 y no pasaba.
  static const acento = Color(0xFF6D4AFF);

  /// Presionado y bordes del acento.
  static const acentoOscuro = Color(0xFF5334D6);

  /// El violeta al 12 %, para fondos de chips y estados seleccionados.
  static const acentoSuave = Color(0x1F6D4AFF);

  // ── Estados ─────────────────────────────────────────────────────────────
  /// Magenta de EN VIVO. Distinto del acento a propósito: uno indica estado,
  /// el otro invita a tocar. Si fueran el mismo, el punto del vivo parecería
  /// un botón.
  ///
  /// `#E6007A` y no el magenta neón brillante porque el badge lleva texto
  /// blanco: así da 4,5:1. El neón vive en [magentaNeon], para glows y
  /// gradientes sin texto.
  static const vivo = Color(0xFFE6007A);
  static const vivoSuave = Color(0x1FE6007A);

  /// Verde lima. Salió bien: pagado, conectado, publicado, entregado, ganancia.
  ///
  /// Casi siempre es texto o ícono sobre fondo oscuro, donde da 13,9:1. Cuando
  /// se usa como relleno, el texto encima va en [sobreLima].
  static const exito = Color(0xFFA3E635);
  static const exitoSuave = Color(0x1FA3E635);

  /// Cyan. Información, selección, navegación, «esto es lo que estás mirando».
  ///
  /// Nunca es una acción: si algo es cyan, se lee, no se toca. Esa separación
  /// es lo que permite que el violeta signifique siempre lo mismo.
  static const info = Color(0xFF22D3EE);
  static const infoSuave = Color(0x1F22D3EE);

  static const alerta = Color(0xFFFFB020);
  static const alertaSuave = Color(0x1FFFB020);

  /// Rojo de error. Se mantiene lejos del magenta en tono: un error y un vivo
  /// no se pueden confundir de reojo.
  static const error = Color(0xFFFF4D4F);
  static const errorSuave = Color(0x1FFF4D4F);

  /// Inactivo. Gris neutro y sin marca: lo apagado no es de nadie.
  static const inactivo = Color(0xFF3A3A44);

  // ── Sobre colores de relleno ────────────────────────────────────────────
  /// El texto que va ARRIBA de un relleno lima o cyan.
  ///
  /// Los dos son clarísimos: el blanco encima es ilegible. Casi negro da
  /// 12:1 sobre lima y 10:1 sobre cyan.
  static const sobreLima = Color(0xFF0A0A0F);
  static const sobreCyan = Color(0xFF0A0A0F);

  // ── Neones, sólo para gradientes y glow ─────────────────────────────────
  /// Las versiones brillantes. **No llevan texto encima nunca.**
  static const cyanNeon = Color(0xFF22D3EE);
  static const magentaNeon = Color(0xFFFF2E9A);

  // ── Gradientes ──────────────────────────────────────────────────────────
  /// El de la marca. Los tres colores, en el orden del isotipo.
  ///
  /// ⚠️ Sin texto encima. Ver la nota grande arriba: no hay un color de letra
  /// que sea legible sobre el cyan Y sobre el violeta a la vez.
  ///
  /// Va en el isotipo, en bordes, en barras de progreso y en fondos de
  /// encabezado donde el texto se apoya en otra capa.
  static const gradienteMarca = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [cyanNeon, acento, magentaNeon],
  );

  /// El de los botones. Violeta → magenta, la mitad del gradiente de marca
  /// donde el texto blanco pasa AA de punta a punta (5,2:1 y 4,5:1).
  static const gradienteAccion = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [acento, Color(0xFFE6007A)],
  );

  /// Degradado sobre el video para que el texto blanco se lea sin importar qué
  /// haya filmado el vendedor. Sin esto, un producto claro deja los controles
  /// ilegibles.
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

/// El resplandor de los colores de marca.
///
/// ⚠️ Muy medido, y por dos motivos.
///
/// El primero es de gusto: un neón que brilla en todos lados deja de leerse
/// como energía y pasa a leerse como una app de 2014 con sombras por todas
/// partes.
///
/// El segundo es de rendimiento y pesa más. Cada `BoxShadow` con `blurRadius`
/// alto es una pasada de composición extra, y esta app dibuja video a 30 fps
/// con una lista scrolleando encima. Un glow por tarjeta en un feed es la
/// diferencia entre 60 y 45 fps en un teléfono de gama media, que es el
/// teléfono que tiene la gente.
///
/// Por eso hay exactamente dos: uno para el botón principal y uno para el
/// badge de EN VIVO. Nada más lleva glow.
abstract final class Glow {
  /// Debajo del CTA principal. Un solo halo, difuso y corto.
  static const accion = [
    BoxShadow(color: Color(0x4D6D4AFF), blurRadius: 20, offset: Offset(0, 6)),
  ];

  /// Alrededor del badge de EN VIVO. Más chico: acompaña, no compite con el
  /// video.
  static const vivo = [
    BoxShadow(color: Color(0x59E6007A), blurRadius: 14, offset: Offset(0, 2)),
  ];
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
///
/// `celebracion` es la excepción y tiene su propio nombre para que se note que
/// es otra cosa: se usa una vez, cuando algo salió bien de verdad —se confirmó
/// una compra, se entregó un pedido— y ahí medio segundo no es lentitud, es
/// el momento.
abstract final class Duraciones {
  static const instantanea = Duration(milliseconds: 120);
  static const rapida = Duration(milliseconds: 200);
  static const normal = Duration(milliseconds: 300);
  static const celebracion = Duration(milliseconds: 550);
}
