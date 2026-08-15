import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../state/auth_providers.dart';
import '../../data/auth_repository.dart';

/// Donde la persona declara su fecha de nacimiento. VendoX es 18+.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// CUÁNDO APARECE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Antes de la primera compra y antes de crear la tienda. No al registrarse:
/// meter un formulario entre "Continuar con Google" y el primer video es la
/// forma más cara de perder a alguien que todavía no sabe si la app le sirve.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// SE DECLARA UNA SOLA VEZ, Y ESO SE AVISA ANTES
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El backend rechaza el cambio, y con razón: si se pudiera editar, la regla no
/// existiría —alguien pone una fecha, la app lo frena, y vuelve a poner otra—.
///
/// Pero una regla así, descubierta después, es una trampa. Por eso la pantalla
/// lo dice ANTES de que la persona escriba, no en el error.
///
/// ⛔ Y no dice en ningún lado que la edad quede "verificada". No lo está: no
/// hay integración con ningún registro. Ver `backend/src/modules/users/edad.ts`.
class FechaDeNacimientoSheet extends ConsumerStatefulWidget {
  const FechaDeNacimientoSheet({super.key, required this.accion});

  /// Qué estaba intentando hacer. Cambia el título, no la regla.
  final AccionConEdad accion;

  /// Devuelve `true` si quedó declarada y la persona es mayor.
  static Future<bool> mostrar(BuildContext context, AccionConEdad accion) async {
    final r = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Redondeo.lg)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: FechaDeNacimientoSheet(accion: accion),
      ),
    );
    return r ?? false;
  }

  @override
  ConsumerState<FechaDeNacimientoSheet> createState() => _FechaDeNacimientoSheetState();
}

/// Qué se estaba intentando hacer cuando se pidió la fecha.
enum AccionConEdad {
  comprar,
  vender;

  String get titulo => switch (this) {
        AccionConEdad.comprar => 'Antes de tu primera compra',
        AccionConEdad.vender => 'Antes de abrir tu tienda',
      };
}

class _FechaDeNacimientoSheetState extends ConsumerState<FechaDeNacimientoSheet> {
  final _dia = TextEditingController();
  final _mes = TextEditingController();
  final _anio = TextEditingController();

  bool _enviando = false;
  String? _error;

  /// El rechazo definitivo: declaró ser menor. La hoja cambia de contenido.
  bool _rechazado = false;

  @override
  void dispose() {
    _dia.dispose();
    _mes.dispose();
    _anio.dispose();
    super.dispose();
  }

  bool get _completo => _dia.text.isNotEmpty && _mes.text.isNotEmpty && _anio.text.length == 4;

  /// `AAAA-MM-DD`, que es lo único que el backend acepta.
  ///
  /// Se arma acá y no se manda "15/3/2008": `new Date('15/03/2008')` se
  /// interpreta distinto según el servidor, así que la forma se fija de este
  /// lado y del otro no queda nada que adivinar.
  String get _iso {
    final d = _dia.text.padLeft(2, '0');
    final m = _mes.text.padLeft(2, '0');
    return '${_anio.text}-$m-$d';
  }

  /// El botón depende del largo de los tres campos, así que hay que reconstruir
  /// en cada tecla. Sin esto queda deshabilitado con la fecha ya completa.
  void _alEscribir() => setState(() => _error = null);

  Future<void> _confirmar() async {
    setState(() {
      _enviando = true;
      _error = null;
    });

    try {
      await ref.read(authRepositoryProvider).completarPerfil(fechaDeNacimiento: _iso);
      ref.invalidate(sesionProvider);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on AuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _enviando = false;
        // Menor de edad NO es un error del formulario: no se resuelve
        // reintentando. La hoja pasa a explicar, y deja de pedir la fecha.
        _rechazado = e.esMenorDeEdad;
        _error = e.mensaje;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _enviando = false;
        _error = 'No pudimos guardar la fecha. Probá de nuevo.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.md, Gap.xl, Gap.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _rechazado ? _contenidoRechazado() : _contenidoFormulario(),
        ),
      ),
    );
  }

  List<Widget> _contenidoFormulario() => [
        const _Manija(),
        const SizedBox(height: Gap.lg),
        Text(
          widget.accion.titulo,
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: Gap.sm),
        const Text(
          // Se dice POR QUÉ. "Es obligatorio" suena a trámite nuestro; que hay
          // una edad mínima legal es una razón que se entiende sola.
          'Necesitamos tu fecha de nacimiento. VendoX es para mayores de 18: '
          'comprar y vender son contratos, y la ley pide esa edad.',
          style: TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
        ),
        const SizedBox(height: Gap.lg),
        Row(
          children: [
            Expanded(
              child: _Campo(
                controlador: _dia,
                etiqueta: 'Día',
                largo: 2,
                alEscribir: _alEscribir,
              ),
            ),
            const SizedBox(width: Gap.sm),
            Expanded(
              child: _Campo(
                controlador: _mes,
                etiqueta: 'Mes',
                largo: 2,
                alEscribir: _alEscribir,
              ),
            ),
            const SizedBox(width: Gap.sm),
            Expanded(
              flex: 2,
              child: _Campo(
                controlador: _anio,
                etiqueta: 'Año',
                largo: 4,
                alEscribir: _alEscribir,
              ),
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: Gap.md),
          Text(
            _error!,
            style: const TextStyle(fontSize: 13, color: AppColor.error, height: 1.4),
          ),
        ],
        const SizedBox(height: Gap.lg),
        FilledButton(
          onPressed: _enviando || !_completo ? null : () => _confirmar(),
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: _enviando
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Text(
                  'Continuar',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
        ),
        const SizedBox(height: Gap.sm),
        const Text(
          // Se avisa ANTES, no en el error. Una regla que se descubre después
          // de equivocarse es una trampa.
          'Se carga una sola vez. Si te equivocás, hay que corregirlo desde Ayuda.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: AppColor.textoDebil, height: 1.4),
        ),
      ];

  List<Widget> _contenidoRechazado() => [
        const _Manija(),
        const SizedBox(height: Gap.xl),
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: AppColor.textoDebil.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(Redondeo.md),
          ),
          child: const Icon(Icons.info_outline_rounded, color: AppColor.textoSuave, size: 24),
        ),
        const SizedBox(height: Gap.lg),
        const Text(
          'VendoX es para mayores de 18',
          style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: Gap.sm),
        Text(
          // El mensaje del backend, que ya explica que es un requisito legal y
          // no una decisión nuestra. No se reescribe acá: la misma regla contada
          // de dos formas distintas termina en dos textos que se contradicen.
          _error ?? 'Es un requisito legal, no una decisión nuestra.',
          style: const TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
        ),
        const SizedBox(height: Gap.sm),
        const Text(
          'Podés seguir mirando los vivos.',
          style: TextStyle(fontSize: 14, color: AppColor.textoSuave, height: 1.45),
        ),
        const SizedBox(height: Gap.xl),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(false),
          style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
          child: const Text('Entendido', style: TextStyle(fontWeight: FontWeight.w700)),
        ),
      ];
}

class _Manija extends StatelessWidget {
  const _Manija();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 36,
        height: 4,
        decoration: BoxDecoration(
          color: AppColor.borde,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}

/// Un campo numérico corto.
///
/// Tres campos y no un selector de calendario: para llegar a 1990 en un
/// `showDatePicker` hay que retroceder treinta y seis años a mano. Escribir la
/// fecha es más rápido y es lo que la gente espera de un formulario de este
/// tipo.
class _Campo extends StatelessWidget {
  const _Campo({
    required this.controlador,
    required this.etiqueta,
    required this.largo,
    required this.alEscribir,
  });

  final TextEditingController controlador;
  final String etiqueta;
  final int largo;
  final VoidCallback alEscribir;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controlador,
      keyboardType: TextInputType.number,
      textAlign: TextAlign.center,
      maxLength: largo,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      onChanged: (_) => alEscribir(),
      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
      decoration: InputDecoration(
        labelText: etiqueta,
        counterText: '',
        filled: true,
        fillColor: AppColor.superficieAlta,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(Redondeo.md),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }
}
