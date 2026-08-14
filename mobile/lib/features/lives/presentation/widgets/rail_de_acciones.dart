import 'package:flutter/material.dart';

import '../../../../core/design/tokens.dart';

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
  });

  final VoidCallback onTienda;
  final VoidCallback onComentar;
  final VoidCallback onPerfil;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const _Accion(
          icono: Icons.favorite_border_rounded,
          etiqueta: 'Me gusta',
          // Todavía no hay backend de "me gusta" sobre un vivo. Se deja
          // visible y sin acción en vez de simular un contador que no existe:
          // un corazón que se llena y no persiste es peor que uno que no hace
          // nada, porque la próxima vez que entre no va a estar.
          onTap: null,
        ),
        _Accion(
          icono: Icons.chat_bubble_outline_rounded,
          etiqueta: 'Comentar',
          onTap: onComentar,
        ),
        const _Accion(
          icono: Icons.send_outlined,
          etiqueta: 'Enviar',
          // Compartir un vivo necesita una URL pública que todavía no existe:
          // el dominio definitivo está pendiente. Un botón que copia un enlace
          // roto es peor que uno que no hace nada.
          onTap: null,
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
