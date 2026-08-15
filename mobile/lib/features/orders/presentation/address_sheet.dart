import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../data/orders_repository.dart';
import '../domain/order_models.dart';

/// Dirección de entrega.
///
/// ─── Cuándo aparece ───
///
/// Antes de la PRIMERA compra, nunca antes. Pedir una dirección para mirar un
/// feed es gente que se va sin ver un video. Acá la persona ya decidió
/// comprar: tiene un motivo evidente para darla.
///
/// ─── Por qué los campos van separados ───
///
/// El correo argentino necesita calle, altura, piso y departamento por
/// separado. Una línea de texto libre obliga a adivinar dónde termina cada
/// cosa, y eso hace que un paquete vuelva al depósito.
class AddressSheet extends ConsumerStatefulWidget {
  const AddressSheet({super.key, this.existente});

  final Direccion? existente;

  /// Devuelve la dirección guardada, o `null` si se cerró sin guardar.
  static Future<Direccion?> mostrar(BuildContext context, {Direccion? existente}) {
    return showModalBottomSheet<Direccion>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (_) => AddressSheet(existente: existente),
    );
  }

  @override
  ConsumerState<AddressSheet> createState() => _AddressSheetState();
}

class _AddressSheetState extends ConsumerState<AddressSheet> {
  final _formKey = GlobalKey<FormState>();

  late final _destinatario = TextEditingController(text: widget.existente?.destinatario);
  late final _documento = TextEditingController(text: widget.existente?.documento);
  late final _telefono = TextEditingController(text: widget.existente?.telefono ?? '+549');
  late final _calle = TextEditingController(text: widget.existente?.calle);
  late final _numero = TextEditingController(text: widget.existente?.numero);
  late final _piso = TextEditingController(text: widget.existente?.piso);
  late final _depto = TextEditingController(text: widget.existente?.departamento);
  late final _ciudad = TextEditingController(text: widget.existente?.ciudad);
  late final _codigoPostal = TextEditingController(text: widget.existente?.codigoPostal);
  late final _referencias = TextEditingController(text: widget.existente?.referencias);

  late String _provincia = widget.existente?.provincia ?? _provincias.first;
  late String _tipoDocumento = widget.existente?.tipoDocumento ?? 'DNI';
  bool _guardando = false;

  @override
  void dispose() {
    for (final c in [
      _destinatario,
      _documento,
      _telefono,
      _calle,
      _numero,
      _piso,
      _depto,
      _ciudad,
      _codigoPostal,
      _referencias,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() => _guardando = true);
    try {
      final direccion = await ref.read(ordersRepositoryProvider).guardarDireccion(
        {
          'recipientFullName': _destinatario.text.trim(),
          'documentType': _tipoDocumento,
          'documentNumber': _documento.text.trim(),
          'phoneE164': _telefono.text.trim(),
          'street': _calle.text.trim(),
          'number': _numero.text.trim(),
          if (_piso.text.trim().isNotEmpty) 'floor': _piso.text.trim(),
          if (_depto.text.trim().isNotEmpty) 'apartment': _depto.text.trim(),
          'city': _ciudad.text.trim(),
          'province': _provincia,
          'postalCode': _codigoPostal.text.trim(),
          if (_referencias.text.trim().isNotEmpty) 'references': _referencias.text.trim(),
          'isDefault': true,
        },
        id: widget.existente?.id,
      );

      ref.invalidate(misDireccionesProvider);
      if (mounted) Navigator.of(context).pop(direccion);
    } catch (e) {
      if (mounted) AppSnack.error(context, e.toString());
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: Gap.xl,
        right: Gap.xl,
        top: Gap.md,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Gap.xl,
      ),
      child: SingleChildScrollView(
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColor.borde,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: Gap.lg),
              Text(
                widget.existente == null ? '¿A dónde te lo mandamos?' : 'Editar dirección',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: Gap.xl),
              _Campo(
                controlador: _destinatario,
                etiqueta: 'Quién recibe',
                pista: 'Nombre y apellido',
                capitalizacion: TextCapitalization.words,
                validar: (v) => (v ?? '').trim().length < 3 ? 'Poné el nombre completo' : null,
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 110,
                    child: DropdownButtonFormField<String>(
                      initialValue: _tipoDocumento,
                      decoration: const InputDecoration(labelText: 'Tipo'),
                      dropdownColor: AppColor.superficieAlta,
                      items: const [
                        DropdownMenuItem(value: 'DNI', child: Text('DNI')),
                        DropdownMenuItem(value: 'CUIL', child: Text('CUIL')),
                        DropdownMenuItem(value: 'CUIT', child: Text('CUIT')),
                      ],
                      onChanged: (v) => setState(() => _tipoDocumento = v ?? 'DNI'),
                    ),
                  ),
                  const SizedBox(width: Gap.md),
                  Expanded(
                    child: _Campo(
                      controlador: _documento,
                      etiqueta: 'Número',
                      teclado: TextInputType.number,
                      soloDigitos: true,
                      // Lo pide el correo para entregar y Mercado Pago para
                      // facturar. Sin él no se puede despachar.
                      validar: (v) {
                        final limpio = (v ?? '').replaceAll(RegExp(r'\D'), '');
                        if (limpio.length < 7 || limpio.length > 11) return 'Documento inválido';
                        return null;
                      },
                    ),
                  ),
                ],
              ),
              _Campo(
                controlador: _telefono,
                etiqueta: 'Teléfono',
                pista: '+5491122334455',
                teclado: TextInputType.phone,
                // Con código de país: es lo que el correo usa para avisar que
                // están en la puerta.
                validar: (v) => RegExp(r'^\+\d{8,15}$').hasMatch((v ?? '').trim())
                    ? null
                    : 'Va con código de país: +5491122334455',
              ),
              const SizedBox(height: Gap.sm),
              const _Separador('Dirección'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    flex: 3,
                    child: _Campo(
                      controlador: _calle,
                      etiqueta: 'Calle',
                      capitalizacion: TextCapitalization.words,
                      validar: (v) => (v ?? '').trim().length < 2 ? 'Falta la calle' : null,
                    ),
                  ),
                  const SizedBox(width: Gap.md),
                  Expanded(
                    child: _Campo(
                      controlador: _numero,
                      etiqueta: 'Altura',
                      teclado: TextInputType.number,
                      validar: (v) => (v ?? '').trim().isEmpty ? 'Falta' : null,
                    ),
                  ),
                ],
              ),
              Row(
                children: [
                  Expanded(child: _Campo(controlador: _piso, etiqueta: 'Piso (opcional)')),
                  const SizedBox(width: Gap.md),
                  Expanded(child: _Campo(controlador: _depto, etiqueta: 'Depto (opcional)')),
                ],
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    flex: 2,
                    child: _Campo(
                      controlador: _ciudad,
                      etiqueta: 'Ciudad',
                      capitalizacion: TextCapitalization.words,
                      validar: (v) => (v ?? '').trim().length < 2 ? 'Falta la ciudad' : null,
                    ),
                  ),
                  const SizedBox(width: Gap.md),
                  Expanded(
                    child: _Campo(
                      controlador: _codigoPostal,
                      etiqueta: 'CP',
                      pista: 'C1043',
                      capitalizacion: TextCapitalization.characters,
                      validar: (v) =>
                          RegExp(r'^[A-Za-z]?\d{4}[A-Za-z]{0,3}$').hasMatch((v ?? '').trim())
                              ? null
                              : 'CP inválido',
                    ),
                  ),
                ],
              ),
              DropdownButtonFormField<String>(
                initialValue: _provincia,
                decoration: const InputDecoration(labelText: 'Provincia'),
                dropdownColor: AppColor.superficieAlta,
                isExpanded: true,
                items: [
                  for (final p in _provincias) DropdownMenuItem(value: p, child: Text(p)),
                ],
                onChanged: (v) => setState(() => _provincia = v ?? _provincias.first),
              ),
              const SizedBox(height: Gap.lg),
              _Campo(
                controlador: _referencias,
                etiqueta: 'Referencias (opcional)',
                pista: 'Portón negro, timbre 3',
                // Es el campo que evita que el pedido vuelva al depósito.
              ),
              const SizedBox(height: Gap.lg),
              FilledButton(
                onPressed: _guardando ? null : _guardar,
                style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                child: _guardando
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Guardar dirección'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Campo extends StatelessWidget {
  const _Campo({
    required this.controlador,
    required this.etiqueta,
    this.pista,
    this.teclado,
    this.capitalizacion = TextCapitalization.none,
    this.validar,
    this.soloDigitos = false,
  });

  final TextEditingController controlador;
  final String etiqueta;
  final String? pista;
  final TextInputType? teclado;
  final TextCapitalization capitalizacion;
  final String? Function(String?)? validar;
  final bool soloDigitos;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.md),
      child: TextFormField(
        controller: controlador,
        keyboardType: teclado,
        textCapitalization: capitalizacion,
        validator: validar,
        inputFormatters: soloDigitos ? [FilteringTextInputFormatter.digitsOnly] : null,
        decoration: InputDecoration(labelText: etiqueta, hintText: pista),
      ),
    );
  }
}

class _Separador extends StatelessWidget {
  const _Separador(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.md),
      child: Text(
        texto.toUpperCase(),
        style: const TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w700,
          color: AppColor.textoDebil,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

/// Las 24 jurisdicciones.
///
/// Lista cerrada y no texto libre: "Bs As", "BsAs", "Buenos Aires" y "provincia
/// de buenos aires" son la misma cosa escrita de cuatro maneras, y cualquier
/// integración con logística las va a rechazar.
const _provincias = [
  'Buenos Aires',
  'CABA',
  'Catamarca',
  'Chaco',
  'Chubut',
  'Córdoba',
  'Corrientes',
  'Entre Ríos',
  'Formosa',
  'Jujuy',
  'La Pampa',
  'La Rioja',
  'Mendoza',
  'Misiones',
  'Neuquén',
  'Río Negro',
  'Salta',
  'San Juan',
  'San Luis',
  'Santa Cruz',
  'Santa Fe',
  'Santiago del Estero',
  'Tierra del Fuego',
  'Tucumán',
];
