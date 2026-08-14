import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/design/tokens.dart';
import '../features/auth/domain/session.dart';
import '../features/auth/presentation/welcome_screen.dart';
import '../features/auth/state/auth_providers.dart';
import '../features/feed/presentation/feed_screen.dart';
import '../features/lives/presentation/lives_screen.dart';
import '../features/orders/presentation/orders_screen.dart';
import '../features/profile/presentation/profile_screen.dart';
import '../features/search/presentation/search_screen.dart';

/// Raíz de la aplicación: decide qué se ve según el estado de sesión.
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sesion = ref.watch(sesionProvider);

    return switch (sesion) {
      // Mientras se lee el Keychain. Es el estado que evita que la pantalla de
      // login aparezca por un instante cuando SÍ hay sesión guardada.
      SesionDesconocida() => const _Arranque(),
      SinSesion() => const WelcomeScreen(),
      ConSesion() => const _NavegacionPrincipal(),
    };
  }
}

class _Arranque extends StatelessWidget {
  const _Arranque();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: SizedBox(
          width: 34,
          height: 34,
          child: CircularProgressIndicator(strokeWidth: 2.5),
        ),
      ),
    );
  }
}

/// Navegación principal.
///
/// ─── Por qué el feed va primero y a pantalla completa ───
///
/// La app abre en video reproduciéndose. No en un menú, no en un catálogo, no
/// en un saludo. La comparación mental de cualquier persona que la instale es
/// con TikTok, y ahí el contenido arranca antes de que uno decida nada.
///
/// ─── Por qué "En vivo" está en el centro y se ve distinto ───
///
/// Es la razón de ser del producto y lo que lo diferencia de una tienda. Un
/// botón más en una fila de cinco iguales lo escondería.
class _NavegacionPrincipal extends ConsumerStatefulWidget {
  const _NavegacionPrincipal();

  @override
  ConsumerState<_NavegacionPrincipal> createState() => _NavegacionPrincipalState();
}

class _NavegacionPrincipalState extends ConsumerState<_NavegacionPrincipal> {
  int _indice = 0;

  /// La posición de "En vivo" en la barra. Nombrada porque se usa dos veces y
  /// un `2` suelto no dice nada.
  static const _pestanaVivo = 2;

  static const _pantallas = [
    FeedScreen(),
    SearchScreen(),
    LivesScreen(),
    OrdersScreen(),
    ProfileScreen(),
  ];

  void _cambiarA(int i) {
    /**
     * Entrar a "En vivo" recarga la lista.
     *
     * El `IndexedStack` mantiene las cinco pantallas montadas para no perder su
     * estado —posición del feed, texto escrito en el buscador—, pero eso hace
     * que `initState` de la grilla corra una sola vez en toda la sesión. Sin
     * este disparo, la pestaña mostraría los vivos de cuando se abrió la app.
     *
     * Va acá y no en la pantalla porque el shell es el único que sabe cuándo
     * una pestaña pasa a estar visible.
     */
    if (i == _pestanaVivo) ref.invalidate(livesActivosProvider);
    setState(() => _indice = i);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // extendBody: la barra flota sobre el video en vez de recortarlo. Sin
      // esto, el feed pierde 80 px de alto que son justo donde suele estar el
      // producto.
      extendBody: true,
      body: IndexedStack(index: _indice, children: _pantallas),
      bottomNavigationBar: _BarraInferior(indice: _indice, onCambio: _cambiarA),
    );
  }
}

class _BarraInferior extends StatelessWidget {
  const _BarraInferior({required this.indice, required this.onCambio});

  final int indice;
  final ValueChanged<int> onCambio;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xF20A0A0C),
        border: Border(top: BorderSide(color: AppColor.borde)),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 62,
          child: Row(
            children: [
              _Item(
                icono: Icons.home_outlined,
                iconoActivo: Icons.home_rounded,
                etiqueta: 'Inicio',
                activo: indice == 0,
                onTap: () => onCambio(0),
              ),
              _Item(
                icono: Icons.search_rounded,
                iconoActivo: Icons.search_rounded,
                etiqueta: 'Buscar',
                activo: indice == 1,
                onTap: () => onCambio(1),
              ),
              _ItemVivo(activo: indice == 2, onTap: () => onCambio(2)),
              _Item(
                icono: Icons.receipt_long_outlined,
                iconoActivo: Icons.receipt_long_rounded,
                etiqueta: 'Pedidos',
                activo: indice == 3,
                onTap: () => onCambio(3),
              ),
              _Item(
                icono: Icons.person_outline_rounded,
                iconoActivo: Icons.person_rounded,
                etiqueta: 'Perfil',
                activo: indice == 4,
                onTap: () => onCambio(4),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Item extends StatelessWidget {
  const _Item({
    required this.icono,
    required this.iconoActivo,
    required this.etiqueta,
    required this.activo,
    required this.onTap,
  });

  final IconData icono;
  final IconData iconoActivo;
  final String etiqueta;
  final bool activo;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = activo ? AppColor.texto : AppColor.textoDebil;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        // Sin ondas ni resaltado: sobre video se ven sucias.
        splashColor: Colors.transparent,
        highlightColor: Colors.transparent,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedScale(
              scale: activo ? 1.0 : 0.92,
              duration: Duraciones.instantanea,
              child: Icon(activo ? iconoActivo : icono, color: color, size: 24),
            ),
            const SizedBox(height: 3),
            Text(
              etiqueta,
              style: TextStyle(
                color: color,
                fontSize: 10.5,
                fontWeight: activo ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// El botón de "En vivo": deliberadamente distinto de los otros cuatro.
class _ItemVivo extends StatelessWidget {
  const _ItemVivo({required this.activo, required this.onTap});

  final bool activo;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        splashColor: Colors.transparent,
        highlightColor: Colors.transparent,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [AppColor.vivo, AppColor.acentoOscuro]),
                borderRadius: BorderRadius.circular(Redondeo.sm),
                boxShadow: activo
                    ? [BoxShadow(color: AppColor.vivo.withValues(alpha: 0.45), blurRadius: 14)]
                    : null,
              ),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.sensors_rounded, color: Colors.white, size: 16),
                  SizedBox(width: 4),
                  Text(
                    'VIVO',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 3),
            Text(
              'En vivo',
              style: TextStyle(
                color: activo ? AppColor.texto : AppColor.textoDebil,
                fontSize: 10.5,
                fontWeight: activo ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
