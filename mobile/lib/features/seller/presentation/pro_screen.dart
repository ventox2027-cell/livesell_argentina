import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../data/pro_api.dart';
import '../data/tasas_api.dart';
import '../domain/seller_models.dart';

/// VendoX Pro.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// NO HAY BOTÓN DE «CONTRATAR», Y NO ES UN OLVIDO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El cobro está desacoplado a propósito: cada tienda de aplicaciones tiene sus
/// reglas sobre bienes digitales, y elegir mal significa reescribir el sistema
/// o que rechacen la app. Mientras esa decisión no esté tomada, Pro se otorga
/// desde el panel de administración.
///
/// Un botón que abra un cartel de «próximamente» sería peor que no tenerlo:
/// promete algo que no podemos cumplir todavía, y quien lo toca se va con la
/// sensación de que la app está a medias.
///
/// ⚠️ **No se muestra ningún precio.** Cuánto va a salir Pro es una decisión
/// comercial que no está tomada, y un número que después cambia es la misma
/// clase de mentira que un descuento inventado. Se muestran los beneficios;
/// el precio, cuando exista.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// PRO NO ES UN SELLO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La insignia de Pro **no se dibuja como** la de identidad verificada ni como
/// la de vendedor destacado. Esas se ganan; ésta se paga. Que se parezcan haría
/// que un sello comprado se lea como uno ganado, que es exactamente lo que las
/// otras tres existen para evitar. Ver `seller_profile_screen.dart`.
class ProScreen extends ConsumerWidget {
  const ProScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final membresia = ref.watch(miMembresiaProvider);

    return Scaffold(
      backgroundColor: AppColor.fondo,
      appBar: AppBar(title: const Text('VendoX Pro')),
      body: membresia.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(onReintentar: () => ref.invalidate(miMembresiaProvider)),
        data: (m) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(miMembresiaProvider);
            ref.invalidate(misCuponesProvider);
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.lg, Gap.xl, Gap.xxxl),
            children: [
              _EstadoDelPlan(membresia: m),
              const SizedBox(height: Gap.xl),
              _Beneficios(membresia: m),
              if (m.puedeUsarCupones) ...[
                const SizedBox(height: Gap.xxl),
                _Cupones(membresia: m),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _EstadoDelPlan extends ConsumerWidget {
  const _EstadoDelPlan({required this.membresia});
  final MiMembresia membresia;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pro = membresia.esPro;
    final tasas = ref.watch(tasasProvider).valueOrNull ?? TasasDeVendox.porOmision;

    return Container(
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.lg),
        border: Border.all(color: pro ? AppColor.acento : AppColor.borde),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                pro ? Icons.rocket_launch_rounded : Icons.storefront_outlined,
                size: 22,
                color: pro ? AppColor.acento : AppColor.textoSuave,
              ),
              const SizedBox(width: Gap.md),
              Text(
                pro ? 'Tenés VendoX Pro' : 'Plan gratuito',
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
            ],
          ),
          const SizedBox(height: Gap.md),
          Text(
            _detalle(membresia, tasas.comisionBps),
            style: const TextStyle(fontSize: 13.5, color: AppColor.textoSuave, height: 1.4),
          ),
          if (pro && membresia.venceProximo) ...[
            const SizedBox(height: Gap.md),
            Container(
              padding: const EdgeInsets.all(Gap.md),
              decoration: BoxDecoration(
                color: AppColor.alerta.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(Redondeo.md),
              ),
              child: const Row(
                children: [
                  Icon(Icons.schedule_rounded, size: 17, color: AppColor.alerta),
                  SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(
                      // Sin aviso, los cupones dejan de funcionar en medio de
                      // un vivo y el vendedor se entera por los compradores.
                      'Cuando venza, tus cupones dejan de aplicarse.',
                      style: TextStyle(fontSize: 12.5, height: 1.35),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// El texto del estado.
  ///
  /// Con Pro dice cuántos días quedan y de dónde salió. Lo segundo importa:
  /// alguien con Pro de cortesía que cree que lo está pagando no entiende por
  /// qué le vence.
  String _detalle(MiMembresia m, int comisionBps) {
    if (!m.esPro) {
      // El porcentaje sale del servidor. Acá decía «6 %» escrito a mano, y
      // siguió diciéndolo después de que la comisión bajara a 4 %: no rompió
      // nada, no falló ningún test, y le mostró al vendedor un número que le
      // hacía calcular mal su ganancia. Es el tipo de error que sólo encuentra
      // alguien leyendo la pantalla.
      return 'Estás usando VendoX sin costo. Publicar, transmitir y vender no '
          'tienen cargo: la comisión del ${porcentajeLegible(comisionBps)} % se '
          'cobra sólo cuando vendés.';
    }

    final dias = m.diasRestantes;
    final cuanto = dias == null
        ? ''
        : dias == 1
            ? ' Te queda 1 día.'
            : ' Te quedan $dias días.';

    final origen = switch (m.origen) {
      'CORTESIA' => ' Te lo dio VendoX.',
      'PRUEBA' => ' Es un período de prueba.',
      _ => '',
    };

    return 'Tenés las herramientas de Pro activas.$cuanto$origen';
  }
}

/// Qué incluye cada plan.
///
/// ⚠️ Sólo se listan beneficios que **existen en el código**. Una lista de
/// promesas es una lista de reclamos: si acá dice «analítica avanzada» y la
/// pantalla no está, alguien pagó por nada. Ver `membresias.ts`.
class _Beneficios extends StatelessWidget {
  const _Beneficios({required this.membresia});
  final MiMembresia membresia;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Qué incluye Pro',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: Gap.md),
        _Beneficio(
          icono: Icons.local_offer_outlined,
          titulo: 'Cupones de descuento',
          detalle: membresia.esPro
              ? 'Hasta ${membresia.cuponesActivosPermitidos} activos a la vez.'
              : 'Códigos que tus compradores escriben al pagar.',
          incluido: membresia.puedeUsarCupones,
        ),
        _Beneficio(
          icono: Icons.insights_outlined,
          titulo: 'Métricas de tu tienda',
          detalle: 'Cuántas personas miraron, guardaron, apartaron y compraron.',
          incluido: membresia.puedeVerAnalitica,
        ),
        const SizedBox(height: Gap.lg),
        /**
         * ⚠️ Acá NO va un botón de contratar. Ver la nota de la pantalla.
         *
         * Se dice cómo se consigue, que es la información honesta que hay hoy.
         */
        if (!membresia.esPro)
          Container(
            padding: const EdgeInsets.all(Gap.md),
            decoration: BoxDecoration(
              color: AppColor.superficieAlta,
              borderRadius: BorderRadius.circular(Redondeo.md),
            ),
            child: const Text(
              'Todavía no se puede contratar desde la app. Estamos terminando '
              'de definirlo y te vamos a avisar cuando esté.',
              style: TextStyle(fontSize: 12.5, color: AppColor.textoSuave, height: 1.4),
            ),
          ),
      ],
    );
  }
}

class _Beneficio extends StatelessWidget {
  const _Beneficio({
    required this.icono,
    required this.titulo,
    required this.detalle,
    required this.incluido,
  });

  final IconData icono;
  final String titulo;
  final String detalle;
  final bool incluido;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            incluido ? Icons.check_circle_rounded : icono,
            size: 19,
            color: incluido ? AppColor.exito : AppColor.textoDebil,
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
                    fontWeight: FontWeight.w700,
                    color: incluido ? AppColor.texto : AppColor.textoSuave,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  detalle,
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: AppColor.textoDebil,
                    height: 1.35,
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

/// Los cupones del vendedor.
class _Cupones extends ConsumerWidget {
  const _Cupones({required this.membresia});
  final MiMembresia membresia;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cupones = ref.watch(misCuponesProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Tus cupones',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
              ),
            ),
            TextButton.icon(
              onPressed: () => unawaited(_crear(context, ref)),
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('Nuevo'),
            ),
          ],
        ),
        const SizedBox(height: Gap.sm),
        cupones.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(Gap.lg),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (_, __) => const Text(
            'No pudimos cargar tus cupones.',
            style: TextStyle(fontSize: 13, color: AppColor.textoSuave),
          ),
          data: (lista) => lista.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: Gap.md),
                  child: Text(
                    'Todavía no creaste ninguno. Un cupón es un código que tus '
                    'compradores escriben al pagar; el descuento lo ponés vos.',
                    style: TextStyle(fontSize: 13, color: AppColor.textoSuave, height: 1.4),
                  ),
                )
              : Column(children: lista.map((c) => _FilaDeCupon(cupon: c)).toList()),
        ),
      ],
    );
  }

  Future<void> _crear(BuildContext context, WidgetRef ref) async {
    final creado = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColor.superficie,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: const _NuevoCupon(),
      ),
    );

    if (creado == true) ref.invalidate(misCuponesProvider);
  }
}

class _FilaDeCupon extends ConsumerWidget {
  const _FilaDeCupon({required this.cupon});
  final Cupon cupon;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      margin: const EdgeInsets.only(bottom: Gap.sm),
      padding: const EdgeInsets.all(Gap.md),
      decoration: BoxDecoration(
        color: AppColor.superficie,
        borderRadius: BorderRadius.circular(Redondeo.md),
        border: Border.all(color: AppColor.borde),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  cupon.codigo,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 0.8,
                    color: cupon.activo ? AppColor.texto : AppColor.textoDebil,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _descripcion(cupon),
                  style: const TextStyle(fontSize: 12.5, color: AppColor.textoSuave),
                ),
              ],
            ),
          ),
          Switch(
            value: cupon.activo,
            onChanged: (v) async {
              await ref.read(proApiProvider).alternarCupon(cupon.id, activo: v);
              ref.invalidate(misCuponesProvider);
            },
          ),
        ],
      ),
    );
  }

  /// Qué descuenta y cuánto se usó.
  ///
  /// ⚠️ «Sin límite» cuando `usosRestantes` es `null`. No se inventa un número:
  /// es el mismo criterio que el resto del sistema.
  String _descripcion(Cupon c) {
    final cuanto = c.esPorcentaje ? '${c.valor} % off' : '\$ ${c.valor ~/ 100} off';
    final usos = c.usosRestantes == null
        ? '${c.usos} ${c.usos == 1 ? "uso" : "usos"} · sin límite'
        : '${c.usos} de ${c.usos + c.usosRestantes!} usados';
    return '$cuanto · $usos';
  }
}

/// El formulario de un cupón nuevo.
///
/// ⚠️ Valida lo mínimo para no mandar algo obviamente incompleto. **Las reglas
/// de negocio las valida el servidor** —el máximo del 80 %, el tope, la ventana
/// invertida— y su mensaje se muestra tal cual: dos validaciones del mismo
/// criterio terminan discrepando, y la que manda es la del backend.
class _NuevoCupon extends ConsumerStatefulWidget {
  const _NuevoCupon();

  @override
  ConsumerState<_NuevoCupon> createState() => _NuevoCuponState();
}

class _NuevoCuponState extends ConsumerState<_NuevoCupon> {
  final _codigo = TextEditingController();
  final _valor = TextEditingController();
  bool _porcentaje = true;
  bool _guardando = false;
  String? _error;

  @override
  void dispose() {
    _codigo.dispose();
    _valor.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final codigo = _codigo.text.trim();
    final valor = int.tryParse(_valor.text.trim());

    if (codigo.isEmpty || valor == null || valor <= 0) {
      setState(() => _error = 'Completá el código y el descuento');
      return;
    }

    setState(() {
      _guardando = true;
      _error = null;
    });

    try {
      await ref.read(proApiProvider).crearCupon(
            codigo: codigo,
            tipo: _porcentaje ? 'PORCENTAJE' : 'MONTO_FIJO',
            // En centavos cuando es monto fijo: el vendedor escribe pesos.
            valor: _porcentaje ? valor : valor * 100,
          );
      if (mounted) Navigator.of(context).pop(true);
    } on CuponException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.mensaje;
          _guardando = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'No pudimos crear el cupón';
          _guardando = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Gap.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Nuevo cupón', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _codigo,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [
              LengthLimitingTextInputFormatter(20),
              TextInputFormatter.withFunction(
                (_, nuevo) => nuevo.copyWith(text: nuevo.text.toUpperCase()),
              ),
            ],
            decoration: const InputDecoration(
              labelText: 'Código',
              hintText: 'VERANO25',
              helperText: 'Lo que tus compradores van a escribir al pagar.',
            ),
            style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.8),
          ),
          const SizedBox(height: Gap.lg),
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: true, label: Text('Porcentaje')),
              ButtonSegment(value: false, label: Text('Monto fijo')),
            ],
            selected: {_porcentaje},
            onSelectionChanged: (s) => setState(() => _porcentaje = s.first),
          ),
          const SizedBox(height: Gap.lg),
          TextField(
            controller: _valor,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: _porcentaje ? 'Descuento (%)' : 'Descuento (\$)',
              // El descuento lo paga el vendedor: conviene que lo tenga claro
              // antes de crear el cupón, no cuando vea las ventas.
              helperText: 'Lo descontás vos de tu precio.',
              errorText: _error,
            ),
          ),
          const SizedBox(height: Gap.xl),
          FilledButton(
            onPressed: _guardando ? null : _guardar,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 50)),
            child: _guardando
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Crear cupón'),
          ),
        ],
      ),
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.onReintentar});
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('No pudimos cargar tu plan.'),
          const SizedBox(height: Gap.md),
          TextButton(onPressed: onReintentar, child: const Text('Reintentar')),
        ],
      ),
    );
  }
}
