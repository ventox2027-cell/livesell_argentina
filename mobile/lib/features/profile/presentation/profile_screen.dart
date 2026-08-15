import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../auth/data/auth_repository.dart';
import '../../moderation/presentation/bloqueados_screen.dart';
import '../../notifications/data/notifications_api.dart';
import '../../notifications/presentation/notifications_screen.dart';
import '../../../core/config/entorno.dart';
import '../../../core/config/paginas_publicas.dart';
import '../../../core/config/runtime_config.dart';
import '../../../core/design/tokens.dart';
import '../../../shared/widgets/app_snack.dart';
import '../../auth/domain/session.dart';
import '../../auth/state/auth_providers.dart';
import '../../seller/presentation/seller_home_screen.dart';
import '../../spike/presentation/home_screen.dart';
import 'complete_profile_sheet.dart';

/// Perfil.
///
/// Es la primera pantalla completamente funcional de la app: lee y escribe
/// datos reales contra el backend de Auth.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sesion = ref.watch(sesionProvider);
    if (sesion is! ConSesion) return const SizedBox.shrink();

    final u = sesion.usuario;

    return Scaffold(
      appBar: AppBar(title: const Text('Perfil')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, 100),
        children: [
          _Cabecera(usuario: u),
          const SizedBox(height: Gap.xl),

          // Lo que falta se muestra ARRIBA de todo y con acción directa. Un
          // dato pendiente escondido en un submenú no lo completa nadie.
          if (sesion.faltantes.isNotEmpty) ...[
            _TarjetaCompletar(faltantes: sesion.faltantes),
            const SizedBox(height: Gap.xl),
          ],

          // Los avisos van primero de la sección: es lo único de esta pantalla
          // que puede tener algo esperando, y lo que la persona vino a ver si
          // llegó acá desde una notificación que ya se fue de la barra.
          Consumer(
            builder: (context, ref, _) {
              final sinLeer = ref.watch(avisosSinLeerProvider).valueOrNull ?? 0;
              return _Fila(
                icono: Icons.notifications_none_rounded,
                texto: 'Avisos',
                detalle: sinLeer > 0 ? '$sinLeer sin leer' : null,
                resaltarDetalle: sinLeer > 0,
                onTap: () async {
                  await Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const NotificationsScreen(),
                    ),
                  );
                  // Al volver, el contador puede haber cambiado.
                  ref.invalidate(avisosSinLeerProvider);
                },
              );
            },
          ),

          const _Titulo('Cuenta'),
          _Fila(
            icono: Icons.person_outline_rounded,
            texto: 'Datos personales',
            detalle: u.nombreCompleto,
            onTap: () => CompleteProfileSheet.mostrar(context, ref),
          ),
          _Fila(
            icono: Icons.phone_outlined,
            texto: 'Teléfono',
            detalle: u.phone ?? 'Sin cargar',
            resaltarDetalle: u.phone == null,
            onTap: () => CompleteProfileSheet.mostrar(context, ref),
          ),
          _Fila(icono: Icons.mail_outline_rounded, texto: 'Email', detalle: u.email),
          _Fila(
            icono: Icons.cake_outlined,
            texto: 'Fecha de nacimiento',
            // Se muestra pero no se puede tocar: el backend rechaza el cambio y
            // ofrecer un campo que va a fallar es peor que no ofrecerlo.
            detalle: u.fechaDeNacimiento == null
                ? 'Se pide en tu primera compra'
                : _enCastellano(u.fechaDeNacimiento!),
          ),
          _Fila(
            icono: Icons.devices_outlined,
            texto: 'Sesiones activas',
            onTap: () => _verSesiones(context, ref),
          ),
          _Fila(
            icono: Icons.block_outlined,
            texto: 'Personas bloqueadas',
            // Tiene que ser fácil de encontrar: bloquear a veces se hace en
            // caliente, y una lista escondida convierte una decisión de un
            // segundo en algo permanente por accidente.
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const BloqueadosScreen()),
            ),
          ),
          _Fila(
            icono: Icons.download_outlined,
            texto: 'Descargar mis datos',
            detalle: 'Todo lo que guardamos sobre vos',
            onTap: () => _descargarMisDatos(context, ref),
          ),
          _Fila(
            icono: Icons.privacy_tip_outlined,
            texto: 'Política de privacidad',
            detalle: 'Qué guardamos y con quién lo compartimos',
            /**
             * Google Play exige un acceso visible a la política desde adentro
             * de la app, y hasta acá la única mención era una línea de texto
             * sin enlace en la pantalla de bienvenida — que además sólo ve
             * quien todavía no entró.
             *
             * Va en el navegador del teléfono y no en un WebView: una política
             * de privacidad tiene que poder leerse con su URL a la vista.
             */
            onTap: () async {
              final abrio = await abrirPaginaPublica(PaginasPublicas.privacidad);
              if (!abrio && context.mounted) {
                AppSnack.error(context, 'No se pudo abrir el navegador.');
              }
            },
          ),

          const SizedBox(height: Gap.xl),
          const _Titulo('Vender'),
          _Fila(
            icono: Icons.storefront_outlined,
            texto: u.esVendedor ? 'Mi tienda' : 'Quiero vender',
            detalle: u.esVendedor ? 'Productos y ajustes' : 'Creala en un paso',
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const SellerHomeScreen()),
            ),
          ),

          /**
           * La sección de desarrollo NO viaja en la APK de Google Play.
           *
           * Una pantalla de medición de latencia de LiveKit en una app de
           * compras es lo que hace que una revisión se detenga a preguntar qué
           * es. Y la URL del backend a la vista le regala a cualquiera el
           * objetivo sin tener que abrir la APK.
           *
           * `Entorno.herramientas` es una constante de compilación, así que
           * este bloque ni siquiera queda en el binario de release. Ver
           * `core/config/entorno.dart`.
           */
          if (Entorno.herramientas) ...[
            const SizedBox(height: Gap.xl),
            const _Titulo('Desarrollo'),
            _Fila(
              icono: Icons.speed_rounded,
              texto: 'Herramientas del Sprint 0',
              detalle: 'Medición de LiveKit y pagos',
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const SpikeHomeScreen()),
              ),
            ),
            _Fila(
              icono: Icons.dns_outlined,
              texto: 'Backend',
              detalle: RuntimeConfig.instance.apiBaseUrl,
            ),
          ],

          const SizedBox(height: Gap.xxl),
          OutlinedButton(
            onPressed: () => _cerrarSesion(context, ref),
            child: const Text('Cerrar sesión'),
          ),
          const SizedBox(height: Gap.md),
          TextButton(
            onPressed: () => _cerrarCuenta(context, ref),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Eliminar mi cuenta'),
          ),
        ],
      ),
    );
  }

  /// `1990-05-20` → `20/05/1990`.
  ///
  /// El backend manda ISO porque es lo que no se malinterpreta entre sistemas.
  /// Acá se muestra como se escribe una fecha en Argentina: nadie lee su fecha
  /// de nacimiento al revés.
  String _enCastellano(String iso) {
    final p = iso.split('-');
    if (p.length != 3) return iso;
    return '${p[2]}/${p[1]}/${p[0]}';
  }

  Future<void> _cerrarSesion(BuildContext context, WidgetRef ref) async {
    await ref.read(sesionProvider.notifier).cerrarSesion();
  }

  Future<void> _cerrarCuenta(BuildContext context, WidgetRef ref) async {
    final confirma = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColor.superficie,
        title: const Text('¿Eliminar tu cuenta?'),
        content: const Text(
          'Se cierran todas tus sesiones y dejás de recibir notificaciones.\n\n'
          'Tus compras se conservan por obligación contable, pero tus datos '
          'personales se borran.',
          style: TextStyle(color: AppColor.textoSuave, height: 1.45),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancelar')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColor.error),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );

    if (confirma != true) return;

    try {
      await ref.read(sesionProvider.notifier).cerrarCuenta();
    } on AuthException catch (e) {
      if (!context.mounted) return;
      /**
       * El backend puede negarse: hay pedidos en curso.
       *
       * Se muestra en un diálogo y no en un cartelito: el mensaje explica
       * cuántas operaciones quedan y qué hacer, y eso no entra ni se lee en
       * tres segundos.
       */
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: AppColor.superficie,
          title: const Text('Todavía no'),
          content: Text(
            e.mensaje,
            style: const TextStyle(color: AppColor.textoSuave, height: 1.45),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Entendido')),
          ],
        ),
      );
    } catch (_) {
      if (context.mounted) {
        AppSnack.error(context, 'No pudimos eliminar la cuenta. Probá de nuevo.');
      }
    }
  }

  /// Descarga todo lo que el backend guarda sobre esta persona.
  ///
  /// ─── Por qué se muestra en pantalla y no se guarda un archivo ───
  ///
  /// Guardar en el teléfono pide permisos de almacenamiento, un selector de
  /// carpeta y manejo de errores por sistema operativo. Compartirlo con la hoja
  /// nativa deja que la persona elija a dónde va —Drive, correo, notas— y es
  /// una línea de código.
  Future<void> _descargarMisDatos(BuildContext context, WidgetRef ref) async {
    AppSnack.info(context, 'Preparando tus datos…');
    try {
      final datos = await ref.read(authRepositoryProvider).exportarMisDatos();
      if (!context.mounted) return;

      // Con sangría: el archivo lo puede llegar a leer una persona, no sólo un
      // programa. Un JSON en una sola línea es ilegible.
      const codificador = JsonEncoder.withIndent('  ');
      await Share.share(codificador.convert(datos), subject: 'Mis datos de VendoX');
    } on AuthException catch (e) {
      if (context.mounted) AppSnack.error(context, e.mensaje);
    } catch (_) {
      if (context.mounted) {
        AppSnack.error(context, 'No pudimos preparar tus datos. Probá de nuevo.');
      }
    }
  }

  Future<void> _verSesiones(BuildContext context, WidgetRef ref) async {
    try {
      final sesiones = await ref.read(authRepositoryProvider).sesionesActivas();
      if (!context.mounted) return;

      await showModalBottomSheet<void>(
        context: context,
        builder: (_) => _HojaSesiones(sesiones: sesiones, ref: ref),
      );
    } catch (e) {
      if (context.mounted) AppSnack.error(context, 'No se pudieron cargar: $e');
    }
  }
}

class _Cabecera extends StatelessWidget {
  const _Cabecera({required this.usuario});
  final Usuario usuario;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: const BoxDecoration(
            gradient: LinearGradient(colors: [AppColor.acento, AppColor.acentoOscuro]),
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: Text(
            usuario.iniciales,
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
          ),
        ),
        const SizedBox(width: Gap.lg),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                usuario.nombreCompleto.isEmpty ? 'Sin nombre' : usuario.nombreCompleto,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 2),
              Text(
                usuario.email,
                style: const TextStyle(color: AppColor.textoSuave, fontSize: 13.5),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _TarjetaCompletar extends ConsumerWidget {
  const _TarjetaCompletar({required this.faltantes});
  final List<DatoFaltante> faltantes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final falta = faltantes.contains(DatoFaltante.telefono)
        ? 'Cargá un teléfono para poder comprar'
        : 'Completá tu perfil';

    return InkWell(
      onTap: () => CompleteProfileSheet.mostrar(context, ref),
      borderRadius: BorderRadius.circular(Redondeo.lg),
      child: Container(
        padding: const EdgeInsets.all(Gap.lg),
        decoration: BoxDecoration(
          color: AppColor.acento.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(Redondeo.lg),
          border: Border.all(color: AppColor.acento.withValues(alpha: 0.35)),
        ),
        child: Row(
          children: [
            const Icon(Icons.error_outline_rounded, color: AppColor.acento, size: 20),
            const SizedBox(width: Gap.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    falta,
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5),
                  ),
                  const SizedBox(height: 2),
                  const Text(
                    'Lo necesitamos para avisarte cuando salga tu pedido.',
                    style: TextStyle(color: AppColor.textoSuave, fontSize: 12.5),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: AppColor.acento),
          ],
        ),
      ),
    );
  }
}

class _Titulo extends StatelessWidget {
  const _Titulo(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Gap.sm, left: Gap.xs),
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

class _Fila extends StatelessWidget {
  const _Fila({
    required this.icono,
    required this.texto,
    this.detalle,
    this.onTap,
    this.resaltarDetalle = false,
  });

  final IconData icono;
  final String texto;
  final String? detalle;
  final VoidCallback? onTap;
  final bool resaltarDetalle;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Redondeo.md),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Gap.md, horizontal: Gap.xs),
        child: Row(
          children: [
            Icon(icono, size: 21, color: AppColor.textoSuave),
            const SizedBox(width: Gap.lg),
            Expanded(child: Text(texto, style: const TextStyle(fontSize: 15))),
            if (detalle != null)
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 170),
                child: Text(
                  detalle!,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: resaltarDetalle ? AppColor.alerta : AppColor.textoDebil,
                  ),
                ),
              ),
            if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 2),
                child: Icon(Icons.chevron_right_rounded, size: 20, color: AppColor.textoDebil),
              ),
          ],
        ),
      ),
    );
  }
}

class _HojaSesiones extends StatelessWidget {
  const _HojaSesiones({required this.sesiones, required this.ref});
  final List<Map<String, dynamic>> sesiones;
  final WidgetRef ref;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.xl, Gap.sm, Gap.xl, Gap.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Sesiones activas', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: Gap.sm),
          const Text(
            'Dispositivos donde tu cuenta está abierta. Si ves alguno que no '
            'reconocés, cerrá todas.',
            style: TextStyle(color: AppColor.textoSuave, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: Gap.lg),
          for (final s in sesiones)
            Padding(
              padding: const EdgeInsets.only(bottom: Gap.md),
              child: Row(
                children: [
                  const Icon(Icons.smartphone_rounded, size: 18, color: AppColor.textoSuave),
                  const SizedBox(width: Gap.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          (s['device'] as Map?)?['model']?.toString() ?? 'Dispositivo desconocido',
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                        ),
                        Text(
                          s['ip']?.toString() ?? 'sin IP',
                          style: const TextStyle(fontSize: 11.5, color: AppColor.textoDebil),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          const SizedBox(height: Gap.md),
          OutlinedButton(
            onPressed: () async {
              Navigator.pop(context);
              await ref.read(sesionProvider.notifier).cerrarTodas();
            },
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColor.error,
              side: const BorderSide(color: AppColor.error),
            ),
            child: const Text('Cerrar todas las sesiones'),
          ),
        ],
      ),
    );
  }
}
