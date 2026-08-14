import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';
import '../../../social/presentation/boton_me_gusta.dart';

/// La columna de acciones del costado.
///
/// ─── "Tienda" no es "producto destacado" ───
///
/// Son dos cosas distintas y la distinción importa:
///
///   **Producto destacado** — lo que el vendedor muestra AHORA. Está abajo, en
///   su tarjeta, y cambia cuando él lo cambia.
///
///   **Tienda** — el catálogo completo. Se abre desde acá, y permite comprar
///   cualquier cosa, no sólo lo que está en cámara.
///
/// Alguien puede entrar a un vivo de velas, ver una que no le gusta, y comprar
/// otra del catálogo sin esperar a que el vendedor la muestre. Sin este botón,
/// esa venta no ocurre.
class RailDeAcciones extends StatelessWidget {
  const RailDeAcciones({
    super.key,
    required this.onTienda,
    required this.onComentar,
    required this.onPerfil,
    required this.liveSessionId,
    this.onCompartir,
  });

  final VoidCallback onTienda;
  final VoidCallback onComentar;
  final VoidCallback onPerfil;

  /// Para el corazón. El estado lo maneja el propio botón.
  final String liveSessionId;

  final VoidCallback? onCompartir;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // El corazón tiene su propio estado: se pinta apenas se toca y se
        // corrige si el servidor dice otra cosa. Ver `BotonMeGusta`.
        Padding(
          padding: const EdgeInsets.only(bottom: Gap.lg),
          child: BotonMeGusta(tipo: 'live', id: liveSessionId),
        ),
        _Accion(
          icono: Icons.chat_bubble_outline_rounded,
          etiqueta: 'Comentar',
          onTap: onComentar,
        ),
        _Accion(
          icono: Icons.send_outlined,
          etiqueta: 'Enviar',
          // El enlace lo arma el backend. ⚠️ La página web que lo atiende
          // todavía no existe: quien lo abra sin la app instalada cae en un
          // 404 hasta que esté. Los enlaces que se compartan mientras tanto
          // van a funcionar cuando la página exista — el formato no cambia.
          onTap: onCompartir,
        ),
        _Accion(
          icono: Icons.storefront_rounded,
          etiqueta: 'Tienda',
          onTap: onTienda,
          destacado: true,
        ),
        _Accion(
          icono: Icons.person_outline_rounded,
          etiqueta: 'Perfil',
          onTap: onPerfil,
        ),
      ],
    );
  }
}

class _Accion extends StatelessWidget {
  const _Accion({
    required this.icono,
    required this.etiqueta,
    required this.onTap,
    this.destacado = false,
  });

  final IconData icono;
  final String etiqueta;
  final VoidCallback? onTap;
  final bool destacado;

  @override
  Widget build(BuildContext context) {
    final habilitado = onTap != null;

    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.lg),
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Column(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: destacado ? AppColor.acento : Colors.black26,
                shape: BoxShape.circle,
                border: destacado ? null : Border.all(color: Colors.white24),
              ),
              child: Icon(
                icono,
                size: 22,
                color: habilitado ? Colors.white : Colors.white38,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              etiqueta,
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w600,
                color: habilitado ? Colors.white : Colors.white38,
                shadows: const [Shadow(color: Colors.black87, blurRadius: 6)],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
