import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/componentes.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../../shared/widgets/aviso_de_pausa.dart';
import '../../auth/data/banderas.dart';
import '../../social/data/guardados_api.dart';
import '../../inventory/presentation/reserve_sheet.dart';
import '../../orders/domain/order_models.dart';
import '../data/live_api.dart';
import '../domain/live_models.dart';
import 'widgets/catalogo_de_tienda.dart' show plata;
import 'widgets/envio_y_politicas.dart';

/// Elegir talle, color y cantidad. El paso previo a apartar.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE NO HAY, NO SE PUEDE TOCAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Un valor sin stock —dado lo ya elegido— se dibuja tachado y no responde. No
/// se oculta: que el vendedor tenga XS y esté agotado es información. Ocultarlo
/// haría creer que ese talle no existe, y quien lo busca se iría pensando que
/// no es para su cuerpo en vez de que se agotó.
///
/// La combinatoria la resuelve el modelo (`valorTieneStock`), no esta pantalla.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA TIENDA CERRADA NO CONSUME STOCK
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Si la tienda está cerrada, el botón **no** apartaba nada: deja una intención
/// —"avisame cuando abran"— que no crea `InventoryReservation` ni descuenta una
/// unidad. Reservar de verdad por una tienda cerrada apartaría stock durante
/// cinco minutos para alguien que no puede pagar, y se lo sacaría a quien sí.
///
/// ─── Se abre sobre el vivo ───
///
/// Como la de la tienda: es una hoja, la pantalla del vivo sigue montada y
/// LiveKit no se toca.
class VariantSheet extends ConsumerStatefulWidget {
  const VariantSheet({
    super.key,
    required this.productId,
    this.storeId,
    this.liveSessionId,
  });

  final String productId;

  /// Para consultar el horario. `null` cuando no se sabe de qué tienda viene:
  /// ahí se asume abierta y decide el backend.
  final String? storeId;

  /// Desde qué vivo se abrió, o `null` si vino del feed, del buscador o del
  /// perfil de la tienda.
  ///
  /// Es lo que habilita el precio exclusivo del vivo al comprar. Sólo se
  /// transporta: el descuento lo resuelve el backend.
  final String? liveSessionId;

  /// Devuelve el pedido si la compra se completó, o `null` si se cerró antes.
  static Future<Pedido?> mostrar(
    BuildContext context, {
    required String productId,
    String? storeId,
    String? liveSessionId,
  }) {
    return showModalBottomSheet<Pedido>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black38,
      builder: (ctx) => Padding(
        // La hoja se apoya arriba del teclado si aparece alguno.
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: VariantSheet(
          productId: productId,
          storeId: storeId,
          liveSessionId: liveSessionId,
        ),
      ),
    );
  }

  @override
  ConsumerState<VariantSheet> createState() => _VariantSheetState();
}

class _VariantSheetState extends ConsumerState<VariantSheet> {
  DetalleDeProducto? _producto;
  EstadoDeTienda? _tienda;
  bool _cargando = true;

  /// Un valor elegido por eje, indexado por nombre de eje.
  ///
  /// Un mapa y no una lista: los ejes vienen del backend y su orden puede
  /// cambiar entre respuestas. Indexar por posición ataría "Talle: M" al índice
  /// 0 y bastaría con que el vendedor reordene sus opciones para que la app
  /// elija color donde creía elegir talle.
  final Map<String, String> _elegido = {};

  int _cantidad = 1;
  bool _enviandoIntencion = false;

  /// Si eligió retirar en persona.
  ///
  /// Sólo significa algo cuando la tienda ofrece las dos opciones. En los demás
  /// modos el backend lo ignora, y está bien: si bastara con un campo del
  /// cuerpo para no pagar el envío, el vendedor despacharía paquetes que nadie
  /// le pagó.
  bool _retira = false;

  @override
  void initState() {
    super.initState();
    unawaited(_cargar());

    /**
     * Se registra que lo vio, sin esperar.
     *
     * Es lo que llena «vistos recientemente». No se espera ni se maneja el
     * error a propósito: registrar la visita es una comodidad, no parte de
     * abrir el producto, y un viaje de red más antes de mostrar la hoja se
     * nota en la acción más frecuente de toda la app.
     */
    ref.read(guardadosApiProvider).marcarVisto(widget.productId);
  }

  Future<void> _cargar() async {
    setState(() => _cargando = true);

    final api = ref.read(liveApiProvider);
    final storeId = widget.storeId;

    // Las dos peticiones salen juntas: el horario no depende del producto, y
    // encadenarlas sumaría dos viajes de ida y vuelta antes de mostrar nada.
    final pedidoDeProducto = api.producto(widget.productId);

    /**
     * El horario nunca puede bloquear una compra.
     *
     * Si el endpoint de horario falla, se asume **abierta** y se sigue. Al
     * revés —mostrar "cerrada" porque una consulta secundaria se cayó— frenaría
     * una venta que el backend habría aceptado sin problema. Y si de verdad
     * está cerrada, el backend rechaza la reserva: la app nunca es la autoridad.
     */
    final pedidoDeHorario = storeId == null
        ? Future<EstadoDeTienda?>.value()
        : api.estadoDeTienda(storeId).then<EstadoDeTienda?>((e) => e).catchError(
              (Object _) => null,
            );

    try {
      final producto = await pedidoDeProducto;
      final tienda = await pedidoDeHorario;
      if (!mounted) return;

      setState(() {
        _producto = producto;
        _tienda = tienda;
        _cargando = false;

        // Con un solo valor posible en un eje, se elige solo. Obligar a tocar
        // "Único" es un paso que no decide nada.
        for (final eje in producto.ejes) {
          if (eje.valores.length == 1) _elegido[eje.nombre] = eje.valores.first.id;
        }
      });
    } catch (_) {
      // Sin producto no hay nada que elegir: la hoja muestra el reintento.
      if (mounted) setState(() => _cargando = false);
    }
  }

  Set<String> get _valoresElegidos => _elegido.values.toSet();

  VarianteDeProducto? get _variante => _producto?.variantePara(_valoresElegidos);

  bool get _tiendaAbierta => _tienda?.abierta ?? true;

  /// Apartar y pagar, sin salir del vivo.
  ///
  /// `ReserveSheet` ya encadena con `CheckoutSheet` y devuelve la reserva
  /// cuando el pedido salió. Se reutiliza tal cual: son las mismas pantallas
  /// que ya funcionan desde el feed, con la misma clave de idempotencia y la
  /// misma cuenta regresiva.
  Future<void> _comprar() async {
    final producto = _producto;
    final variante = _variante;
    if (producto == null || variante == null) return;

    final pedido = await ReserveSheet.mostrar(
      context,
      productVariantId: variante.id,
      nombreProducto: producto.nombre,
      precio: plata(variante.precioCentavos),
      // `etiqueta` es null cuando la variante es la interna del producto: sin
      // opciones no hay nada que nombrar, y "Default" no le dice nada a nadie.
      variante: variante.etiqueta,
      // Sólo se manda si la tienda ofrece las dos opciones: en los demás modos
      // el backend lo ignora y mandarlo igual confundiría al leer los logs.
      retiraEnPersona: producto.envio.hayQueElegir && _retira,
      // Si la compra arrancó en un vivo, el pedido lo tiene que saber: es lo
      // único que habilita el precio exclusivo.
      liveSessionId: widget.liveSessionId,
    );

    if (!mounted) return;

    // `null` si se cerró antes de pagar: la hoja de variantes queda abierta y
    // se puede elegir otra cosa. Cerrarla también sería devolver a alguien al
    // vivo por haber cambiado de talle a mitad de camino.
    if (pedido != null) Navigator.of(context).pop(pedido);
  }

  /// "Avisame cuando abran." **No aparta stock.** Ver la nota de arriba.
  Future<void> _dejarIntencion() async {
    final variante = _variante;
    if (variante == null || _enviandoIntencion) return;

    setState(() => _enviandoIntencion = true);
    try {
      await ref.read(liveApiProvider).dejarIntencion(variante.id, _cantidad);
      if (!mounted) return;
      // El aviso va ANTES de cerrar. El `ScaffoldMessenger` vive por encima de
      // la hoja, así que el mensaje sobrevive; al revés, el contexto ya está
      // desactivado cuando se lo busca y el aviso no aparece nunca.
      AppSnack.info(context, 'Listo. Te avisamos cuando la tienda abra.');
      Navigator.of(context).pop();
    } catch (_) {
      if (mounted) AppSnack.error(context, 'No pudimos guardar tu interés.');
    } finally {
      if (mounted) setState(() => _enviandoIntencion = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
      decoration: const BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.xl)),
      ),
      child: SafeArea(
        top: false,
        child: _cargando
            ? const SizedBox(height: 220, child: Center(child: CircularProgressIndicator()))
            : _producto == null
                ? _ErrorDeCarga(onReintentar: () => unawaited(_cargar()))
                : _contenido(_producto!),
      ),
    );
  }

  Widget _contenido(DetalleDeProducto producto) {
    final variante = _variante;
    final faltaElegir = _elegido.length < producto.ejes.length;
    final sinCombinacion = !faltaElegir && variante == null;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: Gap.sm),
        Container(
          width: 36,
          height: 4,
          decoration: BoxDecoration(
            color: AppColor.borde,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Cabecera(producto: producto, variante: variante),
                const SizedBox(height: Gap.xl),

                for (final eje in producto.ejes) ...[
                  _Eje(
                    eje: eje,
                    elegido: _elegido[eje.nombre],
                    // Lo ya elegido en los OTROS ejes: con "Negro" puesto, "XS"
                    // se deshabilita si no hay ningún negro en XS.
                    otrosElegidos: {
                      for (final e in _elegido.entries)
                        if (e.key != eje.nombre) e.value,
                    },
                    producto: producto,
                    onElegir: (valorId) => setState(() {
                      if (_elegido[eje.nombre] == valorId) {
                        _elegido.remove(eje.nombre);
                      } else {
                        _elegido[eje.nombre] = valorId;
                      }
                      // La cantidad vuelve a uno al cambiar de variante: el
                      // stock de la nueva puede ser menor que el elegido.
                      _cantidad = 1;
                    }),
                  ),
                  const SizedBox(height: Gap.lg),
                ],

                // Envío y devoluciones ANTES de reservar. Enterarse del costo
                // del envío con la tarjeta en la mano es la razón número uno
                // por la que alguien abandona una compra.
                EnvioYPoliticas(
                  envio: producto.envio,
                  cambios: producto.cambios,
                  retira: _retira,
                  onCambiarRetiro:
                      producto.envio.hayQueElegir ? (v) => setState(() => _retira = v) : null,
                ),
                const SizedBox(height: Gap.lg),

                if (variante != null && !variante.agotada) ...[
                  _Cantidad(
                    valor: _cantidad,
                    // No se puede pedir más de lo que hay: el backend lo
                    // rechazaría igual, y frenarlo acá evita un error que se
                    // ve como un fallo de la app.
                    maximo: variante.disponible.clamp(1, 10),
                    onCambio: (v) => setState(() => _cantidad = v),
                  ),
                  const SizedBox(height: Gap.md),
                ],

                if (sinCombinacion)
                  const _Aviso(
                    icono: Icons.info_outline_rounded,
                    texto: 'Esa combinación no existe. Probá con otra.',
                  ),

                if (variante != null && variante.agotada)
                  const _Aviso(
                    icono: Icons.remove_shopping_cart_outlined,
                    texto: 'Esta combinación está agotada.',
                    color: AppColor.error,
                  ),

                if (!_tiendaAbierta)
                  _Aviso(
                    icono: Icons.schedule_rounded,
                    texto: _tienda?.motivo.isNotEmpty ?? false
                        ? _tienda!.motivo
                        : 'La tienda está cerrada ahora.',
                    color: AppColor.alerta,
                  ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xl),
          child: _BotonPrincipal(
            faltaElegir: faltaElegir,
            variante: variante,
            tiendaAbierta: _tiendaAbierta,
            trabajando: _enviandoIntencion,
            onComprar: _comprar,
            onIntencion: _dejarIntencion,
          ),
        ),
      ],
    );
  }
}

class _Cabecera extends StatelessWidget {
  const _Cabecera({required this.producto, this.variante});

  final DetalleDeProducto producto;
  final VarianteDeProducto? variante;

  @override
  Widget build(BuildContext context) {
    // Mientras no haya variante elegida se muestra el precio base. No es un
    // engaño: es el precio del producto, y al elegir se actualiza al de la
    // variante si difiere.
    final precio = variante?.precioCentavos ?? producto.precioBaseCentavos;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(Redondeo.md),
          child: SizedBox(
            width: 76,
            height: 76,
            child: producto.imagenUrl == null
                ? const ColoredBox(
                    color: AppColor.superficieAlta,
                    child: Icon(Icons.image_rounded, color: AppColor.textoDebil),
                  )
                : CachedNetworkImage(
                    imageUrl: producto.imagenUrl!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => const ColoredBox(color: AppColor.superficieAlta),
                    errorWidget: (_, __, ___) => const ColoredBox(
                      color: AppColor.superficieAlta,
                      child: Icon(Icons.image_rounded, color: AppColor.textoDebil),
                    ),
                  ),
          ),
        ),
        const SizedBox(width: Gap.lg),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                producto.nombre,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, height: 1.25),
              ),
              const SizedBox(height: Gap.xs),
              Text(
                plata(precio),
                style: const TextStyle(
                  fontSize: 23,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.7,
                ),
              ),
              if (variante != null && !variante!.agotada && variante!.disponible <= 5)
                Text(
                  variante!.disponible == 1 ? 'Última unidad' : 'Quedan ${variante!.disponible}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: AppColor.alerta,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Eje extends StatelessWidget {
  const _Eje({
    required this.eje,
    required this.elegido,
    required this.otrosElegidos,
    required this.producto,
    required this.onElegir,
  });

  final EjeDeVariacion eje;
  final String? elegido;
  final Set<String> otrosElegidos;
  final DetalleDeProducto producto;
  final ValueChanged<String> onElegir;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          eje.nombre,
          style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: Gap.sm),
        Wrap(
          spacing: Gap.sm,
          runSpacing: Gap.sm,
          children: [
            for (final v in eje.valores)
              _Opcion(
                texto: v.valor,
                elegida: elegido == v.id,
                // El modelo decide, no esta pantalla.
                disponible: producto.valorTieneStock(v.id, otrosElegidos),
                onTap: () => onElegir(v.id),
              ),
          ],
        ),
      ],
    );
  }
}

class _Opcion extends StatelessWidget {
  const _Opcion({
    required this.texto,
    required this.elegida,
    required this.disponible,
    required this.onTap,
  });

  final String texto;
  final bool elegida;
  final bool disponible;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      // Sin stock no responde. Se sigue viendo: ver el talle tachado explica
      // que existe y se agotó; no verlo hace pensar que nunca existió.
      onTap: disponible ? onTap : null,
      child: AnimatedContainer(
        duration: Duraciones.instantanea,
        padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: 10),
        decoration: BoxDecoration(
          color: elegida ? AppColor.acento : AppColor.superficieAlta,
          borderRadius: BorderRadius.circular(Redondeo.sm),
          border: Border.all(
            color: elegida ? AppColor.acento : AppColor.borde,
          ),
        ),
        child: Text(
          texto,
          style: TextStyle(
            fontSize: 14,
            fontWeight: elegida ? FontWeight.w700 : FontWeight.w500,
            color: disponible ? AppColor.texto : AppColor.textoDebil,
            // Tachado además de gris: el gris solo no le llega a todo el mundo.
            decoration: disponible ? null : TextDecoration.lineThrough,
            decorationColor: AppColor.textoDebil,
          ),
        ),
      ),
    );
  }
}

class _Cantidad extends StatelessWidget {
  const _Cantidad({required this.valor, required this.maximo, required this.onCambio});

  final int valor;
  final int maximo;
  final ValueChanged<int> onCambio;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        const Text('Cantidad', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
        Row(
          children: [
            _Paso(
              icono: Icons.remove_rounded,
              onTap: valor <= 1 ? null : () => onCambio(valor - 1),
            ),
            SizedBox(
              width: 46,
              child: Text(
                '$valor',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
              ),
            ),
            _Paso(
              icono: Icons.add_rounded,
              onTap: valor >= maximo ? null : () => onCambio(valor + 1),
            ),
          ],
        ),
      ],
    );
  }
}

class _Paso extends StatelessWidget {
  const _Paso({required this.icono, this.onTap});

  final IconData icono;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.sm),
      child: Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: AppColor.superficieAlta,
          borderRadius: BorderRadius.circular(Redondeo.sm),
        ),
        child: Icon(
          icono,
          size: 18,
          color: onTap == null ? AppColor.textoDebil : AppColor.texto,
        ),
      ),
    );
  }
}

/// El botón cambia de significado según el estado. Nunca hay dos.
///
/// Un "Comprar" gris al lado de un "Avisame" activo obliga a leer para entender
/// cuál sirve. Con uno solo, lo que se puede hacer ahora es evidente.
class _BotonPrincipal extends ConsumerWidget {
  const _BotonPrincipal({
    required this.faltaElegir,
    required this.variante,
    required this.tiendaAbierta,
    required this.trabajando,
    required this.onComprar,
    required this.onIntencion,
  });

  final bool faltaElegir;
  final VarianteDeProducto? variante;
  final bool tiendaAbierta;
  final bool trabajando;
  final Future<void> Function() onComprar;
  final Future<void> Function() onIntencion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final estilo = FilledButton.styleFrom(minimumSize: const Size(0, 52));
    const fuente = TextStyle(fontSize: 16, fontWeight: FontWeight.w700);

    if (faltaElegir || variante == null) {
      return SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: null,
          style: estilo,
          child: const Text('Elegí una opción', style: fuente),
        ),
      );
    }

    if (variante!.agotada) {
      return SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: null,
          style: estilo,
          child: const Text('Agotado', style: fuente),
        ),
      );
    }

    // Tienda cerrada: intención, no reserva. Ver la nota de la clase.
    if (!tiendaAbierta) {
      return Column(
        children: [
          SizedBox(
            width: double.infinity,
            child: FilledButton.tonal(
              onPressed: trabajando ? null : () => unawaited(onIntencion()),
              style: estilo,
              child: trabajando
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Avisame cuando abra', style: fuente),
            ),
          ),
          const SizedBox(height: Gap.sm),
          const Text(
            'No se aparta stock: te avisamos y comprás cuando abra.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColor.textoSuave),
          ),
        ],
      );
    }

    /**
     * Con las compras pausadas, el botón se apaga acá y no en el checkout.
     *
     * Este es el último punto donde la persona todavía no invirtió nada:
     * dejarla pasar significaría elegir talle, cargar la dirección, elegir el
     * envío y recién en el último toque leer que no se puede comprar.
     */
    final sinCheckout = pausado(ref, _sinCheckout);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const AvisoDePausa(mostrarSi: _sinCheckout, texto: Banderas.avisoDeCheckout),
        // El CTA de marca. Es la acción que genera plata: gradiente violeta →
        // magenta, glow corto y el hundido al apretar.
        BotonVendoX(
          etiqueta: 'Comprar',
          icono: Icons.bolt_rounded,
          onTap: sinCheckout ? null : () => unawaited(onComprar()),
        ),
      ],
    );
  }
}

bool _sinCheckout(Banderas b) => !b.checkout;

class _Aviso extends StatelessWidget {
  const _Aviso({required this.icono, required this.texto, this.color = AppColor.textoSuave});

  final IconData icono;
  final String texto;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Gap.sm),
      child: Row(
        children: [
          Icon(icono, size: 16, color: color),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(texto, style: TextStyle(fontSize: 13, color: color, height: 1.35)),
          ),
        ],
      ),
    );
  }
}

class _ErrorDeCarga extends StatelessWidget {
  const _ErrorDeCarga({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Gap.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.wifi_off_rounded, size: 34, color: AppColor.textoSuave),
          const SizedBox(height: Gap.md),
          const Text('No pudimos cargar el producto'),
          const SizedBox(height: Gap.lg),
          FilledButton(onPressed: onReintentar, child: const Text('Reintentar')),
        ],
      ),
    );
  }
}
