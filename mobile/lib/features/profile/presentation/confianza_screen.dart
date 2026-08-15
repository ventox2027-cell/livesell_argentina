import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/config/paginas_publicas.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../moderation/presentation/bloqueados_screen.dart';

/// Centro de confianza.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// CADA FRASE DE ESTA PANTALLA TIENE QUE SER CIERTA HOY
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es la regla que ordena el archivo, y es más estricta que en cualquier otra
/// pantalla. Acá alguien viene a decidir si confía; una promesa que no se
/// cumple no es una decepción de producto, es un fraude.
///
/// Por eso **no hay** «garantía VendoX», ni «devolución garantizada», ni
/// «compra 100 % protegida». Nada de eso existe todavía. Lo que hay son cinco
/// mecanismos concretos, cada uno con su archivo detrás:
///
///   · el número de tarjeta nunca toca VendoX (`checkout_sheet.dart`);
///   · la entrega se confirma con un código de seis dígitos
///     (`delivery-code.ts`);
///   · sólo puede reseñar quien recibió (`reputacion.ts`);
///   · se puede bloquear y denunciar (`moderation/`);
///   · los datos se pueden descargar y la cuenta se puede cerrar
///     (`users.service.ts`).
///
/// Cuando exista un programa de protección al comprador, se agrega acá. Antes
/// no.
///
/// ─── Por qué existe esta pantalla y no alcanzaba con el perfil ───
///
/// Todo esto ya estaba: bloqueados, descargar mis datos, la política de
/// privacidad. Pero estaba **repartido** entre las filas de ajustes, mezclado
/// con el teléfono y las sesiones activas. Alguien que duda de una compra no
/// va a reconstruir la respuesta juntando cinco filas de un menú.
class ConfianzaScreen extends StatelessWidget {
  const ConfianzaScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Seguridad y confianza')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xxxl),
        children: [
          const Text(
            'Cómo cuidamos tus compras',
            style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, letterSpacing: -0.4),
          ),
          const SizedBox(height: Gap.sm),
          const Text(
            'Esto es lo que funciona hoy. Cuando agreguemos algo, va a aparecer acá.',
            style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.4),
          ),
          const SizedBox(height: Gap.xl),

          const _Mecanismo(
            icono: Icons.credit_card_off_outlined,
            titulo: 'Tu tarjeta no pasa por VendoX',
            detalle:
                'Los datos de tu tarjeta se cargan directamente en un formulario '
                'de Mercado Pago. Nunca llegan a nuestros servidores, así que no '
                'hay nada nuestro que puedan robarte.',
          ),
          const _Mecanismo(
            icono: Icons.pin_outlined,
            titulo: 'La entrega se confirma con un código',
            detalle:
                'Cuando comprás, te damos un número de seis dígitos. El vendedor '
                'sólo puede marcar el pedido como entregado si vos se lo decís. '
                'Nadie puede cerrar una entrega que no pasó.',
          ),
          const _Mecanismo(
            icono: Icons.rate_review_outlined,
            titulo: 'Sólo reseña quien recibió',
            detalle:
                'No se puede calificar a un vendedor sin haber recibido el '
                'pedido. Las estrellas que ves vienen de compras reales, no de '
                'cuentas creadas para inflar una reputación.',
          ),
          const _Mecanismo(
            icono: Icons.visibility_off_outlined,
            titulo: 'Podés bloquear y denunciar',
            detalle:
                'Bloquear a alguien lo saca de tu chat y de tus vivos al '
                'instante. Las denuncias las revisa una persona del equipo: no '
                'hay ningún sistema automático sancionando por su cuenta.',
          ),
          const _Mecanismo(
            icono: Icons.folder_shared_outlined,
            titulo: 'Tus datos son tuyos',
            detalle:
                'Podés descargar todo lo que guardamos sobre vos y cerrar tu '
                'cuenta cuando quieras. Es un derecho que te da la ley 25.326, '
                'y está en tu perfil.',
          ),

          const SizedBox(height: Gap.xl),
          const Divider(height: 1, color: AppColor.borde),
          const SizedBox(height: Gap.xl),

          const Text(
            'Lo que todavía NO hacemos',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: Gap.sm),
          /**
           * ⚠️ Este bloque es lo que hace honesta a la pantalla.
           *
           * Una lista de protecciones sin sus límites se lee como una garantía
           * total. Decir qué falta cuesta una venta hoy y evita un reclamo que
           * no vamos a poder resolver.
           */
          const Text(
            'No mediamos en las devoluciones ni retenemos el dinero hasta que '
            'recibís. El pago va directo a la cuenta del vendedor. Si algo sale '
            'mal, escribinos y te ayudamos a resolverlo con la tienda, pero no '
            'podemos devolverte la plata por nuestra cuenta.\n\n'
            'Cada tienda publica sus propias condiciones de cambio y devolución. '
            'Leelas antes de comprar: las vas a encontrar en la pantalla del '
            'producto.',
            style: TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.5),
          ),

          const SizedBox(height: Gap.xxl),
          const Text(
            'Herramientas',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: Gap.sm),
          _Accion(
            icono: Icons.block_outlined,
            texto: 'Personas bloqueadas',
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const BloqueadosScreen()),
            ),
          ),
          _Accion(
            icono: Icons.privacy_tip_outlined,
            texto: 'Política de privacidad',
            onTap: () => unawaited(_abrir(context, PaginasPublicas.privacidad)),
          ),
        ],
      ),
    );
  }

  /// Las páginas legales van al navegador del teléfono, no a un WebView.
  ///
  /// Una política de privacidad tiene que poder leerse con su URL a la vista:
  /// dentro de la app, nadie puede comprobar que el texto es el nuestro.
  Future<void> _abrir(BuildContext context, String url) async {
    final abrio = await abrirPaginaPublica(url);
    if (!abrio && context.mounted) {
      AppSnack.error(context, 'No se pudo abrir el navegador.');
    }
  }
}

class _Mecanismo extends StatelessWidget {
  const _Mecanismo({required this.icono, required this.titulo, required this.detalle});

  final IconData icono;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.xl),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColor.superficieAlta,
              borderRadius: BorderRadius.circular(Redondeo.md),
            ),
            child: Icon(icono, size: 19, color: AppColor.info),
          ),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  titulo,
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                Text(
                  detalle,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColor.textoSuave,
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Accion extends StatelessWidget {
  const _Accion({required this.icono, required this.texto, required this.onTap});

  final IconData icono;
  final String texto;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icono, size: 20, color: AppColor.textoSuave),
      title: Text(texto, style: const TextStyle(fontSize: 14.5)),
      trailing: const Icon(Icons.chevron_right_rounded, size: 20, color: AppColor.textoDebil),
      onTap: onTap,
    );
  }
}
