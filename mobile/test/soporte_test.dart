import 'package:flutter_test/flutter_test.dart';

import 'package:vendox/features/support/data/soporte_api.dart';

/// Soporte, del lado de la app.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SIEMPRE SE SABE QUIÉN CONTESTÓ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Alguien que está preguntando por plata tiene derecho a saber si le está
/// contestando un modelo o una persona. Y ante la duda, la app dice
/// «asistente»: atribuirle a una persona del equipo algo que escribió un
/// modelo es el error grave, no el contrario.

void main() {
  group('Quién escribió', () {
    test('los tres autores se distinguen', () {
      expect(AutorDelMensaje.desde('USUARIO'), AutorDelMensaje.yo);
      expect(AutorDelMensaje.desde('ASISTENTE'), AutorDelMensaje.asistente);
      expect(AutorDelMensaje.desde('EQUIPO'), AutorDelMensaje.equipo);
    });

    test('⛔ un autor desconocido cae en ASISTENTE, nunca en EQUIPO', () {
      /**
       * EL TEST QUE IMPORTA.
       *
       * Si mañana el backend agrega un autor nuevo, la app tiene que asumir lo
       * más conservador. Decir «Equipo de VendoX» sobre algo que escribió un
       * modelo es exactamente la confusión que esto evita.
       */
      expect(AutorDelMensaje.desde('BOT_NUEVO'), AutorDelMensaje.asistente);
      expect(AutorDelMensaje.desde(null), AutorDelMensaje.asistente);
    });

    test('⛔ el asistente se identifica como asistente', () {
      // Nunca «VendoX» a secas ni un nombre de persona.
      expect(AutorDelMensaje.asistente.nombre, contains('Asistente'));
      expect(AutorDelMensaje.equipo.nombre, contains('Equipo'));
      expect(AutorDelMensaje.asistente.nombre, isNot(AutorDelMensaje.equipo.nombre));
    });
  });

  group('Los estados', () {
    test('se traducen desde el punto de vista de quien escribió', () {
      /**
       * `ABIERTO` significa «esperando una respuesta nuestra» del lado del
       * equipo. Para quien preguntó significa «estamos con esto». Traducir el
       * enum literalmente deja a alguien mirando la palabra «abierto» sin saber
       * si tiene que hacer algo.
       */
      expect(EstadoDelTicket.desde('ABIERTO').texto, 'Estamos con esto');
      expect(EstadoDelTicket.desde('ESPERANDO_RESPUESTA').texto, 'Esperando tu respuesta');
      expect(EstadoDelTicket.desde('ESCALADO').texto, contains('persona'));
    });

    test('⛔ un estado nuevo no rompe la pantalla', () {
      // Mejor un texto genérico que una excepción en la lista de tickets.
      final e = EstadoDelTicket.desde('ALGO_QUE_NO_EXISTE');
      expect(e, EstadoDelTicket.desconocido);
      expect(e.texto, isNotEmpty);
    });

    test('⛔ un ticket cerrado no admite respuesta', () {
      /**
       * Es la regla del backend: cerrado no se reabre, se abre uno nuevo. La
       * app esconde el campo en vez de dejar que alguien escriba un mensaje
       * entero y recién ahí falle.
       */
      expect(EstadoDelTicket.cerrado.admiteRespuesta, isFalse);
      expect(EstadoDelTicket.resuelto.admiteRespuesta, isTrue);
      expect(EstadoDelTicket.abierto.admiteRespuesta, isTrue);
    });

    test('escalado es el único que se destaca', () {
      // Y no por decoración: es el único que cambia lo que la persona puede
      // esperar — deja de contestar el asistente.
      expect(EstadoDelTicket.escalado.destacado, isTrue);
      expect(EstadoDelTicket.abierto.destacado, isFalse);
      expect(EstadoDelTicket.resuelto.destacado, isFalse);
    });
  });

  group('Las categorías', () {
    test('coinciden con las del backend', () {
      // Ocho, con los mismos valores. Una de más manda un ticket a una cola
      // que no existe; una de menos hace que no se pueda elegir.
      expect(CategoriaDeTicket.values.map((c) => c.valor).toList(), [
        'ENVIO',
        'CAMBIOS',
        'PAGOS',
        'DISPUTA',
        'CUENTA',
        'VENDEDOR',
        'PROBLEMA_TECNICO',
        'OTRO',
      ]);
    });

    test('⛔ una categoría desconocida cae en OTRO', () {
      expect(CategoriaDeTicket.desde('INVENTADA'), CategoriaDeTicket.otro);
      expect(CategoriaDeTicket.desde(null), CategoriaDeTicket.otro);
    });
  });

  group('El ticket', () {
    test('se arma con lo que manda el servidor', () {
      final t = Ticket.fromJson({
        'id': 'sup_1',
        'subject': 'No me llegó el pedido',
        'category': 'ENVIO',
        'status': 'ESCALADO',
        'lastMessageAt': '2026-08-15T21:00:00.000Z',
        'messages': [
          {
            'id': 'sms_1',
            'author': 'USUARIO',
            'body': 'Hola',
            'createdAt': '2026-08-15T20:00:00.000Z',
          },
          {
            'id': 'sms_2',
            'author': 'ASISTENTE',
            'body': 'Lo paso al equipo',
            'escalated': true,
            'createdAt': '2026-08-15T20:01:00.000Z',
          },
        ],
      });

      expect(t.asunto, 'No me llegó el pedido');
      expect(t.categoria, CategoriaDeTicket.envio);
      expect(t.estado, EstadoDelTicket.escalado);
      expect(t.mensajes, hasLength(2));
      expect(t.mensajes[1].escalado, isTrue);
    });

    test('⛔ la lista viene sin mensajes y no rompe', () {
      // `GET /support/tickets` no los trae: sólo el detalle.
      final t = Ticket.fromJson({
        'id': 'sup_1',
        'subject': 'Consulta',
        'category': 'OTRO',
        'status': 'ABIERTO',
        'lastMessageAt': '2026-08-15T21:00:00.000Z',
      });

      expect(t.mensajes, isEmpty);
    });

    test('⛔ no expone nada interno', () {
      /**
       * El backend ya excluye `assignedToUserId` y `escalationReason` de la
       * proyección. Este test fija que la app tampoco los lea si algún día
       * llegaran por error: no hay campo donde guardarlos.
       */
      final t = Ticket.fromJson({
        'id': 'sup_1',
        'subject': 'Consulta',
        'category': 'OTRO',
        'status': 'ESCALADO',
        'lastMessageAt': '2026-08-15T21:00:00.000Z',
        'assignedToUserId': 'usr_admin_secreto',
        'escalationReason': 'MOTIVO_INTERNO',
      });

      expect(t.asunto, 'Consulta');
      // El modelo no tiene dónde ponerlos, así que se descartan solos.
      expect(t.toString(), isNot(contains('usr_admin_secreto')));
    });
  });
}
