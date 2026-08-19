import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendox/features/auth/data/auth_repository.dart';
import 'package:vendox/features/auth/domain/session.dart';
import 'package:vendox/features/auth/state/auth_providers.dart';

/// Cerrar sesión.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// CINCO SEGUNDOS MIRANDO LA PANTALLA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Medido en un teléfono. Eran tres operaciones de red, una detrás de otra, y
/// todas esperadas antes de que la interfaz se moviera:
///
///   1. `PATCH /auth/push-token` — a Railway.
///   2. `FirebaseMessaging.deleteToken()` — a los servidores de Google.
///   3. `POST /auth/logout` — a Railway otra vez.
///   4. Borrar el llavero.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO SE PUEDE MOVER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Borrar el llavero tiene que pasar ANTES de que la pantalla cambie. Si la app
/// muere entre salir y borrar, el próximo arranque restaura la sesión que la
/// persona acaba de cerrar — que es peor que tardar cinco segundos.
///
/// La mitad de estos tests son sobre eso.
void main() {
  late _RepoDeCierre repo;

  Future<ProviderContainer> contenedor() async {
    repo = _RepoDeCierre();
    final c = ProviderContainer(
      overrides: [authRepositoryProvider.overrideWithValue(repo)],
    );
    addTearDown(c.dispose);

    // La sesión arranca abierta: el notifier la restaura del doble.
    repo.mirarEstado = () => c.read(sesionProvider);
    c.read(sesionProvider);

    // `restaurar()` corre en un microtask: sin esto la sesión todavía está en
    // `SesionDesconocida` y el test estaría midiendo otra cosa.
    await Future<void>.delayed(Duration.zero);
    return c;
  }

  group('El orden', () {
    /// ⛔ EL LLAVERO SE BORRA ANTES DE SALIR.
    ///
    /// Es la garantía que no se puede sacrificar por velocidad: mientras los
    /// tokens estén en el disco, matar la app deja la sesión viva.
    test('⛔ los tokens locales se borran antes de cambiar el estado', () async {
      final c = await contenedor();

      await c.read(sesionProvider.notifier).cerrarSesion();

      expect(repo.estadoAlLimpiar, isA<ConSesion>(),
          reason: 'se cambió el estado antes de borrar el llavero');
      expect(c.read(sesionProvider), isA<SinSesion>());
    });

    /// ⛔ Y se le avisa al servidor con la sesión TODAVÍA viva.
    ///
    /// El `PATCH` que desvincula el teléfono necesita el token. Si se borrara
    /// primero, quien use este teléfono después recibiría los avisos de la
    /// cuenta anterior.
    test('⛔ el aviso al servidor sale antes de borrar los tokens', () async {
      final c = await contenedor();

      await c.read(sesionProvider.notifier).cerrarSesion();

      expect(repo.orden, ['aviso', 'limpiar']);
    });
  });

  group('La espera', () {
    /// ⛔ Las dos peticiones salen JUNTAS, no una detrás de otra.
    ///
    /// Son independientes: desvincular el teléfono y avisar del cierre no se
    /// necesitan entre sí. Estaban en fila por costumbre.
    test('⛔ el aviso y la desvinculación no se esperan entre sí', () async {
      final c = await contenedor();
      repo.tarda = const Duration(milliseconds: 200);

      final reloj = Stopwatch()..start();
      await c.read(sesionProvider.notifier).cerrarSesion();
      reloj.stop();

      // En serie serían 400 ms. En paralelo, ~200.
      expect(reloj.elapsedMilliseconds, lessThan(380));
    });
  });

  group('Sin red', () {
    /// ⛔ La sesión se cierra igual.
    ///
    /// La persona pidió salir. Que el servidor no se entere es un problema del
    /// servidor —el token vence solo— y no una razón para dejarla adentro.
    test('⛔ si el aviso falla, la sesión se cierra lo mismo', () async {
      final c = await contenedor();
      repo.falla = true;

      await c.read(sesionProvider.notifier).cerrarSesion();

      expect(c.read(sesionProvider), isA<SinSesion>());
      expect(repo.limpio, isTrue);
    });
  });
}

Usuario _usuario() => Usuario.fromJson(const {
      'id': 'usr_prueba',
      'firstName': 'Ana',
      'lastName': 'Prueba',
      'email': 'ana@test.com',
      'role': 'buyer',
    });

class _RepoDeCierre extends Fake implements AuthRepository {
  final orden = <String>[];
  bool limpio = false;
  bool falla = false;
  Duration tarda = Duration.zero;

  /// Cómo estaba la sesión en el momento de borrar el llavero.
  ///
  /// Es la forma de comprobar el ORDEN sin depender de tiempos: si acá se ve
  /// `SinSesion`, la pantalla cambió antes de que los tokens se fueran.
  EstadoSesion? estadoAlLimpiar;

  /// Se inyecta desde el contenedor para poder mirar el estado.
  EstadoSesion Function()? mirarEstado;

  @override
  Future<EstadoSesion?> sesionGuardada() async => ConSesion(usuario: _usuario());

  @override
  Future<EstadoSesion> restaurar() async => ConSesion(usuario: _usuario());

  @override
  Future<void> avisarDelCierre() async {
    orden.add('aviso');
    if (tarda > Duration.zero) await Future<void>.delayed(tarda);
    if (falla) throw Exception('sin red');
  }

  @override
  Future<void> limpiarLocal() async {
    orden.add('limpiar');
    limpio = true;
    estadoAlLimpiar = mirarEstado?.call();
  }

  @override
  Future<void> actualizarPushToken(String? token) async {
    if (tarda > Duration.zero) await Future<void>.delayed(tarda);
  }
}
