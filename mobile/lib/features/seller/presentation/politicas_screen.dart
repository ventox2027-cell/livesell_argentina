import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/politicas_api.dart';
import '../domain/politicas_models.dart';
import '../domain/seller_models.dart' show formatearPesos, porcentajeLegible;

/// Envío y devoluciones, del lado del vendedor.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PANTALLA PROPIA, NO DOS CAMPOS EN "EDITAR TIENDA"
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Lo que se define acá es plata que se le va a cobrar a compradores reales, y
/// obligaciones legales que el vendedor asume. Un par de campos sueltos en un
/// formulario largo se tocan sin pensar; una pantalla propia obliga a mostrar
/// las consecuencias al lado de cada opción.
///
/// Por eso hay un ejemplo del total en vivo: la pregunta que el vendedor se
/// hace de verdad no es "¿qué modo elijo?" sino "¿cuánto va a ver quien
/// compre?".
class PoliticasScreen extends ConsumerStatefulWidget {
  const PoliticasScreen({super.key, required this.storeId, required this.inicial});

  final String storeId;

  /// Lo que hay guardado hoy. Se pasa por parámetro en vez de pedirlo de nuevo:
  /// la pantalla anterior ya tiene la tienda cargada.
  final ({PoliticaDeEnvioEditable envio, PoliticaDeCambiosEditable cambios}) inicial;

  @override
  ConsumerState<PoliticasScreen> createState() => _PoliticasScreenState();
}

class _PoliticasScreenState extends ConsumerState<PoliticasScreen> {
  late PoliticaDeEnvioEditable _envio = widget.inicial.envio;
  late PoliticaDeCambiosEditable _cambios = widget.inicial.cambios;

  late final _monto = TextEditingController(
    text: _envio.montoFijo == 0 ? '' : (_envio.montoFijo ~/ 100).toString(),
  );
  late final _notaEnvio = TextEditingController(text: _envio.nota ?? '');
  late final _dias = TextEditingController(text: _cambios.dias.toString());
  late final _notaCambios = TextEditingController(text: _cambios.nota ?? '');

  bool _guardando = false;

  @override
  void dispose() {
    _monto.dispose();
    _notaEnvio.dispose();
    _dias.dispose();
    _notaCambios.dispose();
    super.dispose();
  }

  /// El precio de ejemplo del cálculo en vivo: diez mil pesos.
  ///
  /// Un número redondo y realista para el rubro. Con $1 el recargo del
  /// procesador daría cero por redondeo y parecería que no existe.
  static const _ejemplo = 1000000;

  Future<void> _guardar() async {
    if (!_envio.esValida || !_cambios.esValida) return;
    setState(() => _guardando = true);

    try {
      final api = ref.read(politicasApiProvider);
      await api.guardarEnvio(widget.storeId, _envio);
      await api.guardarCambios(widget.storeId, _cambios);

      if (!mounted) return;
      AppSnack.exito(context, 'Listo. Quien compre lo ve antes de pagar.');
      Navigator.of(context).pop(true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _guardando = false);
      AppSnack.error(context, 'No pudimos guardar. Probá de nuevo.');
    }
  }

  void _cambiarModo(ModoDeEnvio modo) {
    setState(() => _envio = _envio.copiarCon(modo: modo));
    if (!modo.necesitaMonto) _monto.clear();
  }

  void _cambiarMonto(String texto) {
    // Se escribe en pesos y se guarda en centavos. Pedirle centavos a alguien
    // que vende ropa sería pedirle que multiplique por cien de memoria.
    final pesos = int.tryParse(texto.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;
    setState(() => _envio = _envio.copiarCon(montoFijo: pesos * 100));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('Envío y devoluciones')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, 120),
        children: [
          const _Seccion('Cómo entregás'),
          for (final modo in ModoDeEnvio.values) ...[
            _Opcion(
              titulo: modo.titulo,
              detalle: modo.explicacion,
              elegida: _envio.modo == modo,
              onTap: () => _cambiarModo(modo),
            ),
            const SizedBox(height: Gap.sm),
          ],
          if (_envio.modo.necesitaMonto) ...[
            const SizedBox(height: Gap.md),
            TextField(
              controller: _monto,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              onChanged: _cambiarMonto,
              decoration: const InputDecoration(
                labelText: 'Cuánto cobrás de envío',
                prefixText: r'$ ',
                helperText: 'Se le suma al total de cada pedido.',
              ),
            ),
          ],
          const SizedBox(height: Gap.md),
          TextField(
            controller: _notaEnvio,
            maxLength: 500,
            maxLines: 2,
            onChanged: (v) => setState(() => _envio = _envio.copiarCon(nota: v)),
            decoration: const InputDecoration(
              labelText: 'Aclaración (opcional)',
              hintText: 'Envíos los martes y jueves. Retiro por Palermo.',
            ),
          ),
          const SizedBox(height: Gap.xl),
          const _Seccion('Costo de Mercado Pago'),
          if (_envio.recargoDisponible)
            _Interruptor(
              titulo: 'Sumarlo al total',
              detalle: _envio.trasladaCostoDelProcesador
                  ? 'Quien compre paga el costo del cobro. Lo ve desglosado.'
                  : 'Vos absorbés el costo del cobro. Quien compre no lo ve.',
              valor: _envio.trasladaCostoDelProcesador,
              onCambio: (v) =>
                  setState(() => _envio = _envio.copiarCon(trasladaCostoDelProcesador: v)),
            )
          else
            // Deshabilitado, no oculto: quien ya lo tenía elegido tiene que
            // poder ver qué pasó con su configuración.
            const _Aviso(
              'Por ahora el costo de Mercado Pago lo absorbe el vendedor. Quien '
              'compra paga el producto y el envío, nada más.\n\n'
              'Trasladarlo requiere conocer el costo exacto antes de cerrar el '
              'total, y eso depende del medio de pago que elija quien compra. '
              'Lo vamos a habilitar cuando podamos hacerlo bien.',
            ),
          const SizedBox(height: Gap.lg),
          _Ejemplo(envio: _envio, precio: _ejemplo),
          const SizedBox(height: Gap.xxl),
          const _Seccion('Cambios y devoluciones'),
          for (final modo in ModoDeCambios.values) ...[
            _Opcion(
              titulo: modo.titulo,
              detalle: modo.explicacion,
              elegida: _cambios.modo == modo,
              onTap: () => setState(() => _cambios = _cambios.copiarCon(modo: modo)),
            ),
            const SizedBox(height: Gap.sm),
          ],
          const SizedBox(height: Gap.md),
          TextField(
            controller: _dias,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            onChanged: (v) => setState(
              () => _cambios = _cambios.copiarCon(dias: int.tryParse(v) ?? 0),
            ),
            decoration: InputDecoration(
              labelText: 'Días para cambiar o devolver',
              helperText: 'Mínimo ${PoliticaDeCambiosEditable.diasMinimosLegales}. '
                  'Podés ofrecer más.',
              errorText: _cambios.esValida
                  ? null
                  : 'En Argentina son ${PoliticaDeCambiosEditable.diasMinimosLegales} días '
                      'como mínimo. No se puede ofrecer menos.',
            ),
          ),
          if (_cambios.puedeElegirQuienPagaElEnvio) ...[
            const SizedBox(height: Gap.md),
            _Interruptor(
              titulo: 'El envío de vuelta lo pagás vos',
              detalle: _cambios.envioDeVueltaLoPagaElVendedor
                  ? 'Vos pagás el envío de la devolución.'
                  : 'Lo paga quien cambia. Sólo vale para los cambios que ofrecés '
                      'de más: el arrepentimiento es sin costo para el comprador.',
              valor: _cambios.envioDeVueltaLoPagaElVendedor,
              onCambio: (v) => setState(
                () => _cambios = _cambios.copiarCon(envioDeVueltaLoPagaElVendedor: v),
              ),
            ),
          ],
          const SizedBox(height: Gap.md),
          TextField(
            controller: _notaCambios,
            maxLength: 1000,
            maxLines: 3,
            onChanged: (v) => setState(() => _cambios = _cambios.copiarCon(nota: v)),
            decoration: const InputDecoration(
              labelText: 'Condiciones (opcional)',
              hintText: 'Con la etiqueta puesta y sin uso.',
            ),
          ),
          const SizedBox(height: Gap.lg),
          const _AvisoLegal(),
        ],
      ),
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.all(Gap.lg),
        child: FilledButton(
          onPressed: _guardando || !_envio.esValida || !_cambios.esValida ? null : _guardar,
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: _guardando
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Text('Guardar', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        ),
      ),
    );
  }
}

/// El total que va a ver quien compre, calculado en vivo.
///
/// Es la pregunta que el vendedor se hace de verdad. Sin esto, elegir
/// "trasladar el costo de Mercado Pago" es una decisión a ciegas: nadie tiene
/// 6,19 % en la cabeza.
///
/// ⚠️ El número es una aproximación y lo dice. La tasa real la informa Mercado
/// Pago DESPUÉS de cobrar y depende del plazo de acreditación y del medio. El
/// cálculo de verdad lo hace el backend al crear cada pedido; esto es
/// orientativo, y presentarlo como exacto sería mentir.
class _Ejemplo extends StatelessWidget {
  const _Ejemplo({required this.envio, required this.precio});

  final PoliticaDeEnvioEditable envio;
  final int precio;

  /// Redondeo al centavo, igual que `porcentajeDe` en el backend.
  ///
  /// El `+ 5000` antes de dividir por 10000 es medio punto básico: hace que
  /// 0,5 suba en vez de perderse. Copiar la operación es inevitable —el
  /// ejemplo se recalcula mientras el vendedor mueve el monto, sin ir al
  /// servidor— pero las TASAS no se copian, vienen de `envio`.
  static int _porcentajeDe(int monto, int bps) => (monto * bps + 5000) ~/ 10000;

  @override
  Widget build(BuildContext context) {
    final costoEnvio = envio.modo.necesitaMonto ? envio.montoFijo : 0;
    final base = precio + costoEnvio;
    // La misma condición que aplica el backend: el ajuste de la tienda sólo
    // cuenta si el servidor tiene el traslado habilitado. Si el ejemplo
    // mostrara un recargo que el pedido real no va a tener, el vendedor
    // configuraría su tienda mirando un número falso.
    final recargo = envio.recargoDisponible && envio.trasladaCostoDelProcesador
        ? _porcentajeDe(base, envio.costoDelProcesadorBps)
        : 0;

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            r'Si vendés algo de $10.000',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: Gap.md),
          _LineaEjemplo('Producto', formatearPesos(precio)),
          if (costoEnvio > 0) _LineaEjemplo('Envío', formatearPesos(costoEnvio)),
          if (recargo > 0) _LineaEjemplo('Costo del cobro', formatearPesos(recargo)),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: Gap.sm),
            child: Divider(height: 1, color: AppColor.borde),
          ),
          _LineaEjemplo('Paga quien compra', formatearPesos(base + recargo), fuerte: true),
          _LineaEjemplo(
            'Comisión de VendoX (${porcentajeLegible(envio.comisionBps)} %)',
            // Sobre el producto, no sobre el total: el envío es plata que vos le
            // entregás al correo, y cobrarte comisión sobre eso sería cobrarte
            // por gastar.
            '-${formatearPesos(_porcentajeDe(precio, envio.comisionBps))}',
          ),
          const SizedBox(height: Gap.sm),
          const Text(
            'El costo real de Mercado Pago lo informan ellos después de cobrar, '
            'así que esto es aproximado.',
            style: TextStyle(fontSize: 11, color: AppColor.textoDebil, height: 1.35),
          ),
        ],
      ),
    );
  }
}

class _LineaEjemplo extends StatelessWidget {
  const _LineaEjemplo(this.etiqueta, this.valor, {this.fuerte = false});

  final String etiqueta;
  final String valor;
  final bool fuerte;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            etiqueta,
            style: TextStyle(
              fontSize: 12.5,
              color: fuerte ? AppColor.texto : AppColor.textoSuave,
              fontWeight: fuerte ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
          Text(
            valor,
            style: TextStyle(
              fontSize: fuerte ? 14 : 12.5,
              fontWeight: fuerte ? FontWeight.w800 : FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _AvisoLegal extends StatelessWidget {
  const _AvisoLegal();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficieAlta,
        borderRadius: BorderRadius.circular(Redondeo.md),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.gavel_rounded, size: 16, color: AppColor.textoSuave),
          SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              // No es una advertencia legal nuestra: es explicarle al vendedor
              // una obligación que ya tiene, para que no se sorprenda cuando la
              // ejerza un comprador.
              'Elijas lo que elijas, quien compre online en Argentina tiene 10 días '
              'corridos para arrepentirse desde que recibe el producto, sin dar '
              'motivos y sin costo. Se lo mostramos siempre en tu tienda.',
              style: TextStyle(fontSize: 12, color: AppColor.textoSuave, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

/// Una explicación de por qué algo no está disponible.
///
/// No es un error ni una advertencia: es información. Por eso va en gris y no
/// en ámbar — el vendedor no tiene nada que corregir.
class _Aviso extends StatelessWidget {
  const _Aviso(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficieAlta,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline_rounded, size: 18, color: AppColor.textoSuave),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(
              texto,
              style: const TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}

class _Seccion extends StatelessWidget {
  const _Seccion(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.md),
      child: Text(
        texto.toUpperCase(),
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
          color: AppColor.textoDebil,
        ),
      ),
    );
  }
}

class _Opcion extends StatelessWidget {
  const _Opcion({
    required this.titulo,
    required this.detalle,
    required this.elegida,
    required this.onTap,
  });

  final String titulo;
  final String detalle;
  final bool elegida;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: elegida,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Redondeo.md),
        child: Container(
          padding: const EdgeInsets.all(Gap.md),
          decoration: BoxDecoration(
            color: elegida ? AppColor.superficieAlta : Colors.transparent,
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(
              color: elegida ? AppColor.acento : AppColor.borde,
              width: elegida ? 1.4 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                elegida ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                size: 18,
                color: elegida ? AppColor.acento : AppColor.textoDebil,
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      titulo,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: elegida ? FontWeight.w700 : FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      detalle,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColor.textoSuave,
                        height: 1.35,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Interruptor extends StatelessWidget {
  const _Interruptor({
    required this.titulo,
    required this.detalle,
    required this.valor,
    required this.onCambio,
  });

  final String titulo;
  final String detalle;
  final bool valor;
  final ValueChanged<bool> onCambio;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(titulo, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(
                detalle,
                style: const TextStyle(fontSize: 12, color: AppColor.textoSuave, height: 1.35),
              ),
            ],
          ),
        ),
        const SizedBox(width: Gap.md),
        Switch(value: valor, onChanged: onCambio),
      ],
    );
  }
}
