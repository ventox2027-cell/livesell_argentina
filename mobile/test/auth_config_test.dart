import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/auth/data/auth_config.dart';

/// La configuración de acceso, y por qué distingue dos fallas.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA APP DECÍA QUE GOOGLE NO ESTABA CONFIGURADO. LO ESTABA.
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Pasó probando en un teléfono real, contra un backend que devolvía su
/// `googleServerClientId` perfectamente. La pantalla de bienvenida contestaba:
///
///     "Google no está configurado en este servidor."
///
/// La causa: un fallo de red producía la MISMA `AuthConfig` vacía que produce
/// un servidor que de verdad tiene Google apagado. Dos problemas distintos, con
/// arreglos distintos, y el mensaje mandaba a revisar el lugar equivocado —
/// el servidor, cuando lo que fallaba era el teléfono llegando a él.
///
/// Peor todavía: `authConfigProvider` es un `FutureProvider`, así que la
/// respuesta vacía quedaba cacheada para toda la sesión. Aunque el backend
/// volviera un segundo después, la app seguía diciendo lo mismo hasta cerrarla
/// del todo, y nada en la pantalla lo sugería.
void main() {
  group('AuthConfig', () {
    test('sin conexión NO es lo mismo que Google apagado', () {
      const sinRed = AuthConfig.sinConexion();
      const googleApagado = AuthConfig(devLoginEnabled: true);

      // Los dos no tienen client ID...
      expect(sinRed.googleDisponible, isFalse);
      expect(googleApagado.googleDisponible, isFalse);

      // ...pero son situaciones distintas, y ahora se pueden distinguir.
      expect(sinRed.alcanzable, isFalse);
      expect(googleApagado.alcanzable, isTrue);
    });

    test('una respuesta buena queda alcanzable', () {
      const config = AuthConfig(
        googleServerClientId: '896546818245-abc.apps.googleusercontent.com',
        devLoginEnabled: true,
      );

      expect(config.alcanzable, isTrue);
      expect(config.googleDisponible, isTrue);
    });

    test('Apple sigue sin estar disponible, y eso es correcto', () {
      // Se habilita junto con la cuenta de desarrollador. Hasta entonces el
      // botón avisa en vez de fallar.
      const config = AuthConfig(googleServerClientId: 'x', devLoginEnabled: true);
      expect(config.appleDisponible, isFalse);
    });

    test('el modo prueba viene apagado por omisión', () {
      // Si el backend no lo dice, no se ofrece: un botón que va a fallar es
      // peor que un botón que no está.
      expect(const AuthConfig().devLoginEnabled, isFalse);
      expect(const AuthConfig.sinConexion().devLoginEnabled, isFalse);
    });
  });
}
