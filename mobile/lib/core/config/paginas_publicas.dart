import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Las páginas públicas de vendox.com.ar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ ESTÁN FIJAS Y NO VIENEN DEL BACKEND
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Google Play verifica que la URL declarada en la ficha de la app sea la misma
/// a la que la app lleva. Si esto viniera de la configuración del servidor, un
/// backend mal apuntado —el de desarrollo, por ejemplo— mandaría al revisor a
/// otro lado y la revisión se rechaza.
///
/// Son dos strings que casi nunca cambian. Que sean constantes también los hace
/// visibles en la búsqueda del repositorio el día que el dominio cambie.
class PaginasPublicas {
  const PaginasPublicas._();

  static const privacidad = 'https://vendox.com.ar/privacidad';
  static const eliminarCuenta = 'https://vendox.com.ar/eliminar-cuenta';
}

/// Abre una de esas páginas en el navegador del teléfono.
///
/// En el navegador y no en un WebView: una política de privacidad tiene que
/// poder verse con su URL a la vista. Metida en un WebView sin barra de
/// direcciones, no hay forma de comprobar que es la página real y no una
/// pantalla que dice lo que se le antoje.
///
/// Devuelve `false` si el teléfono no pudo abrirla, para que quien llama
/// muestre el aviso que corresponda en su contexto.
Future<bool> abrirPaginaPublica(String url) async {
  try {
    return await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } on Exception {
    // Un teléfono sin navegador es raro pero posible, y no puede tumbar la
    // pantalla desde la que se tocó el enlace.
    return false;
  }
}

/// El texto legal con los dos enlaces adentro, listo para poner en cualquier
/// pantalla.
///
/// Existe como widget y no como copia pegada en dos lugares porque el enlace a
/// la política es un requisito de la tienda: si mañana hay una tercera pantalla
/// que lo necesita, tiene que salir de acá y no de un copiar y pegar que se
/// desactualiza solo.
class EnlacesLegales extends StatefulWidget {
  const EnlacesLegales({super.key, required this.prefijo, this.alineacion = TextAlign.center});

  /// Lo que va antes del enlace. Por ejemplo: `'Al continuar aceptás los
  /// Términos y la '`.
  final String prefijo;
  final TextAlign alineacion;

  @override
  State<EnlacesLegales> createState() => _EnlacesLegalesState();
}

/// Con estado sólo por el reconocedor de toques.
///
/// `TapGestureRecognizer` hay que liberarlo a mano: un `TextSpan` construido en
/// un `build` sin estado crea uno nuevo en cada reconstrucción y ninguno se
/// libera. Es la fuga de memoria clásica de `Text.rich` con enlaces.
class _EnlacesLegalesState extends State<EnlacesLegales> {
  late final TapGestureRecognizer _toque;

  @override
  void initState() {
    super.initState();
    _toque = TapGestureRecognizer()..onTap = () => abrirPaginaPublica(PaginasPublicas.privacidad);
  }

  @override
  void dispose() {
    _toque.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // El estilo sale del `DefaultTextStyle` de quien lo pone, no del tema: cada
    // pantalla que muestra esta línea la tiene con un tamaño y un color
    // distintos, y el enlace tiene que verse como el texto que lo rodea.
    final base = DefaultTextStyle.of(context).style;
    final enlace = base.copyWith(
      decoration: TextDecoration.underline,
      decorationColor: base.color,
      fontWeight: FontWeight.w600,
    );

    return Text.rich(
      TextSpan(
        style: base,
        children: [
          TextSpan(text: widget.prefijo),
          TextSpan(text: 'Política de privacidad', style: enlace, recognizer: _toque),
          const TextSpan(text: '.'),
        ],
      ),
      textAlign: widget.alineacion,
    );
  }
}
