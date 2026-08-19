import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens.dart';
import '../../../seller/data/seller_repository.dart';
import '../../../seller/presentation/seller_home_screen.dart';

/// El acceso a Mi tienda, arriba de todo y para quien vende.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// DÓNDE ESTABA Y POR QUÉ ERA UN PROBLEMA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// «Mi tienda» era la fila número trece de Perfil, bajo el título «Vender», por
/// debajo de Cuenta, Ayuda, Seguridad, Personas bloqueadas, Guardados,
/// Descargar mis datos y Política de privacidad.
///
/// En un teléfono eso queda fuera de la pantalla: hay que entrar a Perfil,
/// bajar casi una pantalla entera, y recién ahí tocar. Para alguien que abre la
/// app entre una venta y otra —que es exactamente cómo se usa esto— el lugar
/// más importante de la aplicación estaba enterrado entre opciones de
/// configuración.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// POR QUÉ NO ES UNA PESTAÑA
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Fue lo primero que se evaluó, y se midió antes de descartarlo.
///
/// La barra reparte el ancho en partes iguales entre sus elementos: con cinco,
/// cada uno se lleva 78 px en una pantalla de 390. Con seis, 65 px. Y el botón
/// VIVO no es un ícono: es una píldora de 74 px —14 de padding, 16 de ícono, 4
/// de separación, 26 de texto, 14 de padding— que a 65 px se desborda.
///
/// O sea que una sexta pestaña obliga a achicar el elemento que distingue a
/// VendoX de una tienda cualquiera. No vale la pena por un tap.
///
/// Una pestaña condicional —sólo para quien vende— tiene el mismo problema de
/// ancho, y además metería la pantalla del vendedor dentro del `IndexedStack`,
/// que construye todos sus hijos al arrancar: el panel de la tienda pidiendo
/// datos mientras la persona todavía espera ver el feed.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LO QUE SÍ SE HIZO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Subirlo al primer lugar de Perfil y darle tamaño de tarjeta.
///
/// | | Antes | Ahora |
/// |---|---|---|
/// | Toques desde Inicio | 2 | 2 |
/// | Scroll | ~1 pantalla | ninguno |
/// | Posición en Perfil | fila 13 | primero |
///
/// El número de toques no baja, y ése no era el problema: el problema era que
/// el segundo toque estaba escondido. Ahora es lo primero que se ve.
///
/// ⚠️ Para quien NO vende, este widget no existe. La fila «Quiero vender» sigue
/// donde estaba, al final, bajo «Vender». La navegación de quien compra no
/// cambia en nada — que es la otra mitad del requisito.
class AccesoAMiTienda extends ConsumerWidget {
  const AccesoAMiTienda({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /**
     * Se observa el perfil del vendedor, y eso ADEMÁS lo precalienta.
     *
     * Abrir Perfil dispara `GET /sellers/me` si todavía no está en memoria. Es
     * el mismo pedido que haría el panel de la tienda un toque después, sólo
     * que hecho mientras la persona lee esta pantalla en vez de mientras mira
     * un spinner.
     *
     * `miPerfilVendedorProvider` no es `autoDispose`: lo que se trae acá sigue
     * estando cuando se entra.
     */
    final perfil = ref.watch(miPerfilVendedorProvider);
    final tienda = perfil.valueOrNull?.store?.name;

    return Material(
      color: AppColor.superficie,
      borderRadius: BorderRadius.circular(Redondeo.md),
      child: InkWell(
        borderRadius: BorderRadius.circular(Redondeo.md),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const SellerHomeScreen()),
        ),
        child: Container(
          padding: const EdgeInsets.all(Gap.lg),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Redondeo.md),
            border: Border.all(color: AppColor.borde),
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: AppColor.acento.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(Redondeo.sm),
                ),
                child: const Icon(Icons.storefront_rounded, color: AppColor.acento, size: 24),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'Mi tienda',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    /**
                     * ⚠️ El nombre de la tienda sólo si YA se sabe.
                     *
                     * Nada de un texto de relleno mientras carga: sería un dato
                     * inventado en la pantalla, y arriba de todo. Mientras no
                     * está, se dice qué hay adentro, que es cierto siempre.
                     */
                    Text(
                      tienda ?? 'Tus productos, ventas y ajustes',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, color: AppColor.textoSuave),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: AppColor.textoDebil),
            ],
          ),
        ),
      ),
    );
  }
}
