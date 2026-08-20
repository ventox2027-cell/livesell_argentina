import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../lives/data/live_api.dart';
import '../../lives/domain/live_models.dart';
import 'seguimientos.dart';

/// El vendedor tal como lo ve esta persona, con su estado de seguimiento.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// UNA SOLA VERDAD POR VENDEDOR, NO UNA POR TARJETA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes cada superficie tenía su propio `bool? _siguiendo` adentro del `State`
/// del widget: una copia en cada tarjeta del feed, otra en el vivo, otra en el
/// perfil. Con tres productos del mismo vendedor en pantalla, seguirlo desde
/// uno dejaba el primero en «Siguiendo» y los otros dos en «Seguir» — tres
/// respuestas distintas a la misma pregunta, todas sobre el mismo `sellerId`.
///
/// Y no era sólo lo que se ve: cada una de esas copias pedía el perfil por su
/// cuenta. Un feed con treinta productos de cuatro vendedores hacía treinta
/// peticiones para responder cuatro preguntas.
///
/// Ahora el estado vive acá, con clave `sellerId`. Todas las pantallas observan
/// el mismo provider: seguir desde cualquiera se ve en todas, en el mismo
/// frame, y la carga se hace una sola vez por vendedor.
///
/// ⚠️ NO es autoDispose. Es lo que hace que volver al feed después de seguir a
/// alguien en su perfil muestre «Siguiendo» sin pedir nada: el dato sigue ahí.
class VistaDeVendedor {
  const VistaDeVendedor({required this.perfil, this.alternando = false});

  final PerfilDeVendedor perfil;

  /// Hay un seguir/dejar de seguir viajando ahora mismo.
  ///
  /// Vive en el estado —y no en un campo privado del notifier— porque el botón
  /// tiene que poder deshabilitarse mientras tanto, y para eso necesita
  /// reconstruirse cuando cambia.
  final bool alternando;

  /// Si esta persona lo sigue. `null` cuando no hay sesión: sin saber quién
  /// pregunta, el backend no puede responderlo y el botón no se dibuja.
  bool? get loSigo => perfil.loSigo;

  VistaDeVendedor con({PerfilDeVendedor? perfil, bool? alternando}) => VistaDeVendedor(
        perfil: perfil ?? this.perfil,
        alternando: alternando ?? this.alternando,
      );
}

class PerfilDeVendedorNotifier extends FamilyAsyncNotifier<VistaDeVendedor, String> {
  @override
  Future<VistaDeVendedor> build(String sellerId) async {
    final perfil = await ref.read(liveApiProvider).perfil(sellerId);
    return VistaDeVendedor(perfil: perfil);
  }

  /// Seguir o dejar de seguir, según cómo esté.
  ///
  /// ═══════════════════════════════════════════════════════════════════════════
  /// SE ESPERA AL BACKEND ANTES DE CAMBIAR LO QUE SE VE
  /// ═══════════════════════════════════════════════════════════════════════════
  ///
  /// A diferencia de publicar o pausar un producto, acá no hay optimismo. Y es
  /// deliberado: lo que se muestra no es sólo un estado propio, es **el número
  /// de seguidores de otra persona**, que es una señal de confianza. Un
  /// contador que sube y baja solo porque un toque falló es peor que un botón
  /// que tarda 200 ms.
  ///
  /// Los dos valores —`siguiendo` y `seguidores`— se toman juntos de la misma
  /// respuesta. Separarlos, marcando «Siguiendo» acá y sumando uno al contador
  /// allá, es cómo se llega a un perfil que dice «Siguiendo» con 0 seguidores.
  ///
  /// ⚠️ Un segundo toque mientras el primero viaja no hace nada. Sin eso, dos
  /// toques rápidos mandan un `follow` y un `unfollow` y el estado final lo
  /// decide el orden en que contesten, que no es el orden en que se tocó.
  ///
  /// Si falla, el estado queda **como estaba** y el error se relanza: quien
  /// llamó lo muestra. Tragárselo dejaría un botón que no hace nada y no
  /// explica por qué.
  Future<void> alternar() async {
    final actual = state.valueOrNull;
    if (actual == null || actual.alternando) return;

    // Sin sesión no hay a quién atribuirle el follow, y el botón ni se dibuja.
    final loSigo = actual.loSigo;
    if (loSigo == null) return;

    state = AsyncData(actual.con(alternando: true));

    /**
     * ⚠️ Por `Seguimientos`, no por `LiveApi`.
     *
     * Es lo que avisa a la pestaña «Siguiendo» de que a quién sigo cambió. Sin
     * eso, seguir a alguien no se nota ahí hasta reiniciar la app.
     *
     * Y avisa **después** de que el servidor confirmó: un follow que falló no
     * cambió a quién sigo, así que rearmar la pestaña sería una petición de más
     * por cada toque fallido, justo cuando la red anda mal.
     */
    final seguimientos = ref.read(seguimientosProvider.notifier);

    try {
      final r = loSigo
          ? await seguimientos.dejarDeSeguir(arg)
          : await seguimientos.seguir(arg);

      state = AsyncData(
        VistaDeVendedor(perfil: actual.perfil.conFollow(r.siguiendo, r.seguidores)),
      );
    } catch (_) {
      state = AsyncData(actual.con(alternando: false));
      rethrow;
    }
  }

  /// Vuelve a pedir el perfil **sin borrar lo que ya se ve**.
  ///
  /// Es lo que mantiene el dato honesto cuando cambió desde otro lado —otro
  /// teléfono, la web— sin que la pantalla parpadee. `ref.invalidate` dejaría
  /// el provider en `loading` sin valor, y el perfil que la persona está
  /// mirando desaparecería para volver a aparecer igual.
  ///
  /// ⚠️ No pisa una operación en curso: si hay un follow viajando, el refresco
  /// se descarta. Al revés, la respuesta vieja del perfil borraría el resultado
  /// del toque que la persona acaba de dar.
  Future<void> reconciliar() async {
    if (state.valueOrNull?.alternando ?? false) return;

    final nuevo = await AsyncValue.guard(() => ref.read(liveApiProvider).perfil(arg));
    if (state.valueOrNull?.alternando ?? false) return;

    // Un refresco de cortesía que no llegó no puede vaciar la pantalla.
    final perfil = nuevo.valueOrNull;
    if (perfil == null) {
      if (state.valueOrNull == null) state = AsyncError(nuevo.error!, nuevo.stackTrace!);
      return;
    }

    state = AsyncData(VistaDeVendedor(perfil: perfil));
  }
}

/// El vendedor `sellerId`, compartido por todas las pantallas que lo muestran.
final perfilDeVendedorProvider =
    AsyncNotifierProvider.family<PerfilDeVendedorNotifier, VistaDeVendedor, String>(
  PerfilDeVendedorNotifier.new,
);
