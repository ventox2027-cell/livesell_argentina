import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/state/auth_providers.dart';

/// Soporte, desde la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO ES UN SISTEMA NUEVO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend de tickets existe desde hace rato y funciona: crea la
/// conversación, la clasifica, contesta con el asistente y **escala a una
/// persona** cuando corresponde. Lo único que faltaba era una pantalla.
///
/// Este archivo no agrega ninguna regla. Consume `/support/tickets` tal como
/// está y no reimplementa nada de lo que decide el servidor: ni la categoría
/// sugerida, ni cuándo escalar, ni qué estado sigue a cuál.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE EL ASISTENTE NO PUEDE HACER
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Orientar, clasificar y escalar. **Nada más.** No devuelve plata, no mueve
/// pedidos, no suspende cuentas y no cambia identidades. Eso lo garantiza el
/// backend —hay una comprobación que escala el ticket si la respuesta promete
/// algo que no puede cumplir, ver `escalada.ts`— y la app no tiene forma de
/// saltearlo porque no tiene ningún endpoint para eso.

/// En qué estado está la conversación.
///
/// Los cinco que existen en el backend, sin inventar ninguno. El `desconocido`
/// es para un estado que agreguemos mañana: mejor mostrar el crudo que romper
/// la pantalla.
enum EstadoDelTicket {
  abierto,
  esperandoRespuesta,
  escalado,
  resuelto,
  cerrado,
  desconocido;

  static EstadoDelTicket desde(String? valor) => switch (valor) {
        'ABIERTO' => EstadoDelTicket.abierto,
        'ESPERANDO_RESPUESTA' => EstadoDelTicket.esperandoRespuesta,
        'ESCALADO' => EstadoDelTicket.escalado,
        'RESUELTO' => EstadoDelTicket.resuelto,
        'CERRADO' => EstadoDelTicket.cerrado,
        _ => EstadoDelTicket.desconocido,
      };

  /// Lo que lee la persona.
  ///
  /// ⚠️ Desde SU punto de vista, no desde el nuestro. `ABIERTO` significa
  /// «esperando una respuesta nuestra» del lado del equipo; para quien escribió
  /// significa «estamos con esto». Traducir literalmente el enum dejaría a
  /// alguien mirando la palabra «abierto» sin saber si tiene que hacer algo.
  String get texto => switch (this) {
        EstadoDelTicket.abierto => 'Estamos con esto',
        EstadoDelTicket.esperandoRespuesta => 'Esperando tu respuesta',
        EstadoDelTicket.escalado => 'Lo está viendo una persona',
        EstadoDelTicket.resuelto => 'Resuelto',
        EstadoDelTicket.cerrado => 'Cerrado',
        EstadoDelTicket.desconocido => 'En curso',
      };

  /// Si la persona puede seguir escribiendo.
  ///
  /// Cerrado no se reabre: se abre uno nuevo. Es la regla del backend y la app
  /// la respeta escondiendo el campo en vez de dejar que falle al enviar.
  bool get admiteRespuesta => this != EstadoDelTicket.cerrado;

  /// Si conviene que se note. Escalado es el único que cambia lo que puede
  /// esperar: deja de contestar el asistente y pasa a contestar alguien.
  bool get destacado => this == EstadoDelTicket.escalado;
}

/// Quién escribió cada mensaje.
enum AutorDelMensaje {
  yo,
  asistente,
  equipo;

  static AutorDelMensaje desde(String? valor) => switch (valor) {
        'USUARIO' => AutorDelMensaje.yo,
        'EQUIPO' => AutorDelMensaje.equipo,
        // Cualquier otra cosa se trata como asistente: es lo más conservador.
        // Atribuirle a una persona del equipo algo que escribió un modelo sería
        // exactamente al revés de lo que hay que hacer.
        _ => AutorDelMensaje.asistente,
      };

  /// ⚠️ El asistente se identifica como asistente, siempre.
  ///
  /// Nunca «VendoX» a secas ni un nombre de persona. Alguien tiene derecho a
  /// saber si le está contestando un modelo o alguien del equipo, sobre todo
  /// cuando lo que está preguntando es por plata.
  String get nombre => switch (this) {
        AutorDelMensaje.yo => 'Vos',
        AutorDelMensaje.asistente => 'Asistente de VendoX',
        AutorDelMensaje.equipo => 'Equipo de VendoX',
      };
}

/// Las categorías que acepta el backend. Mismo orden, mismos valores.
enum CategoriaDeTicket {
  envio('ENVIO', 'Envío'),
  cambios('CAMBIOS', 'Cambios y devoluciones'),
  pagos('PAGOS', 'Pagos'),
  disputa('DISPUTA', 'Problema con una compra'),
  cuenta('CUENTA', 'Mi cuenta'),
  vendedor('VENDEDOR', 'Vender en VendoX'),
  problemaTecnico('PROBLEMA_TECNICO', 'Algo no funciona'),
  otro('OTRO', 'Otra cosa');

  const CategoriaDeTicket(this.valor, this.texto);

  final String valor;
  final String texto;

  static CategoriaDeTicket desde(String? valor) => CategoriaDeTicket.values.firstWhere(
        (c) => c.valor == valor,
        orElse: () => CategoriaDeTicket.otro,
      );
}

class Ticket {
  const Ticket({
    required this.id,
    required this.asunto,
    required this.categoria,
    required this.estado,
    required this.ultimoMensajeEl,
    this.orderId,
    this.mensajes = const [],
  });

  factory Ticket.fromJson(Map<String, dynamic> j) => Ticket(
        id: j['id'] as String,
        asunto: j['subject'] as String? ?? 'Consulta',
        categoria: CategoriaDeTicket.desde(j['category'] as String?),
        estado: EstadoDelTicket.desde(j['status'] as String?),
        ultimoMensajeEl:
            DateTime.tryParse(j['lastMessageAt'] as String? ?? '') ?? DateTime.now(),
        orderId: j['orderId'] as String?,
        mensajes: (j['messages'] as List<dynamic>? ?? const [])
            .map((e) => MensajeDeSoporte.fromJson(e as Map<String, dynamic>))
            .toList(growable: false),
      );

  final String id;
  final String asunto;
  final CategoriaDeTicket categoria;
  final EstadoDelTicket estado;
  final DateTime ultimoMensajeEl;
  final String? orderId;

  /// Sólo vienen en el detalle. La lista no los trae.
  final List<MensajeDeSoporte> mensajes;
}

class MensajeDeSoporte {
  const MensajeDeSoporte({
    required this.id,
    required this.autor,
    required this.texto,
    required this.fecha,
    this.escalado = false,
  });

  factory MensajeDeSoporte.fromJson(Map<String, dynamic> j) => MensajeDeSoporte(
        id: j['id'] as String,
        autor: AutorDelMensaje.desde(j['author'] as String?),
        texto: j['body'] as String? ?? '',
        fecha: DateTime.tryParse(j['createdAt'] as String? ?? '') ?? DateTime.now(),
        escalado: j['escalated'] as bool? ?? false,
      );

  final String id;
  final AutorDelMensaje autor;
  final String texto;
  final DateTime fecha;

  /// Este mensaje disparó la escalada a una persona.
  final bool escalado;
}

/// El error, con el mensaje que escribió el servidor.
class SoporteException implements Exception {
  const SoporteException(this.mensaje, {this.demasiadosIntentos = false});

  final String mensaje;

  /// Pegó contra el límite de peticiones. La app lo dice distinto: no es un
  /// fallo, es «esperá un rato», y ofrecer «reintentar» ahí sólo empeora.
  final bool demasiadosIntentos;

  @override
  String toString() => mensaje;
}

class SoporteApi {
  SoporteApi(this._api);
  final ApiClient _api;

  Future<List<Ticket>> misTickets() async {
    final res = await _api.get<Map<String, dynamic>>('/support/tickets');
    final items = res.data?['items'] as List<dynamic>? ?? const [];
    return items.map((e) => Ticket.fromJson(e as Map<String, dynamic>)).toList(growable: false);
  }

  Future<Ticket> detalle(String id) async {
    final res = await _api.get<Map<String, dynamic>>('/support/tickets/$id');
    return Ticket.fromJson(res.data!);
  }

  /// Abre una conversación.
  ///
  /// La categoría es opcional: si no se manda, el backend la deduce del texto.
  /// La app la ofrece igual porque elegirla es más rápido que escribirla, pero
  /// **no la adivina localmente** — dos criterios de clasificación que
  /// discrepan terminan mandando el ticket a la cola equivocada.
  Future<Ticket> abrir({
    required String mensaje,
    String? asunto,
    CategoriaDeTicket? categoria,
    String? orderId,
  }) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/support/tickets',
      data: {
        'mensaje': mensaje,
        if (asunto != null && asunto.trim().isNotEmpty) 'asunto': asunto.trim(),
        if (categoria != null) 'categoria': categoria.valor,
        if (orderId != null) 'orderId': orderId,
      },
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
    return Ticket.fromJson(res.data!);
  }

  Future<void> responder(String id, String mensaje) async {
    final res = await _api.raw.post<Map<String, dynamic>>(
      '/support/tickets/$id/messages',
      data: {'mensaje': mensaje},
    );
    if (res.statusCode != 201 && res.statusCode != 200) throw _error(res);
  }

  Future<void> marcarResuelto(String id) async {
    await _api.patch<Map<String, dynamic>>('/support/tickets/$id/resolve');
  }

  SoporteException _error(dynamic res) {
    final codigo = res.statusCode as int?;
    if (codigo == 429) {
      return const SoporteException(
        'Abriste varias consultas seguidas. Probá de nuevo en un rato.',
        demasiadosIntentos: true,
      );
    }

    final cuerpo = res.data;
    if (cuerpo is Map<String, dynamic>) {
      final error = cuerpo['error'];
      if (error is Map<String, dynamic>) {
        final m = error['message'];
        if (m is String && m.isNotEmpty) return SoporteException(m);
      }
    }
    return const SoporteException('No pudimos enviar tu consulta');
  }
}

final soporteApiProvider = Provider<SoporteApi>((ref) => SoporteApi(ref.watch(apiClientProvider)));

final misTicketsProvider = FutureProvider<List<Ticket>>(
  (ref) => ref.watch(soporteApiProvider).misTickets(),
);

final ticketProvider = FutureProvider.family<Ticket, String>(
  (ref, id) => ref.watch(soporteApiProvider).detalle(id),
);
