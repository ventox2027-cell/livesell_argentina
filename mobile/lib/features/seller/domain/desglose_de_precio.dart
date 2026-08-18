/// Qué se lleva cada uno de una venta, y cuánto queda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// EL VENDEDOR NO TIENE POR QUÉ ADIVINAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Escribe «$100.000» y hasta ahora no sabía cuánto de eso iba a ver. Se
/// enteraba después de vender, que es la peor forma de enterarse: se siente
/// como un costo escondido aunque esté publicado en algún lado.
///
/// Esto lo muestra antes.
///
/// ─── Todo en centavos, como el resto del proyecto ───
///
/// Y con la misma operación de redondeo que usa el backend, para que el número
/// que se muestra sea el que después se cobra.
library;

/// Redondeo al centavo, igual que `porcentajeDe` en el backend.
///
/// El `+ 5000` antes de dividir por 10000 es medio punto básico: hace que 0,5
/// suba en vez de perderse. Copiar la OPERACIÓN es inevitable —el desglose se
/// recalcula mientras la persona escribe, sin ir al servidor— pero las TASAS
/// vienen del servidor. Ver `sellers.service.ts`.
int porcentajeDe(int monto, int bps) => (monto * bps + 5000) ~/ 10000;

/// Lo que se lleva cada uno de una venta.
class DesgloseDePrecio {
  const DesgloseDePrecio({
    required this.precio,
    required this.comision,
    required this.costoDelProcesador,
  });

  /// Lo que ve y paga quien compra.
  final int precio;

  /// Lo que se lleva VendoX. Sobre el producto, nunca sobre el envío.
  final int comision;

  /// Estimación de lo que cobra Mercado Pago.
  ///
  /// ⚠️ **Es una estimación y hay que decirlo.** La tasa real la informa
  /// Mercado Pago DESPUÉS de cobrar y depende del medio de pago, las cuotas y
  /// las condiciones de la cuenta del vendedor. Presentarlo como exacto sería
  /// la misma clase de promesa incumplible que un aviso que no se puede
  /// satisfacer.
  final int costoDelProcesador;

  /// Lo que se estima que recibe el vendedor.
  int get netoEstimado => precio - comision - costoDelProcesador;
}

/// El desglose de un precio de venta.
DesgloseDePrecio desglosarPrecio({
  required int precio,
  required int comisionBps,
  required int costoDelProcesadorBps,
}) {
  if (precio <= 0) {
    return const DesgloseDePrecio(precio: 0, comision: 0, costoDelProcesador: 0);
  }

  return DesgloseDePrecio(
    precio: precio,
    comision: porcentajeDe(precio, comisionBps),
    costoDelProcesador: porcentajeDe(precio, costoDelProcesadorBps),
  );
}

/// A qué precio hay que publicar para recibir aproximadamente `neto`.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA VUELTA TIENE QUE CERRAR
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Es despejar la misma cuenta: si `neto = precio − precio·c − precio·p`,
/// entonces `precio = neto / (1 − c − p)`.
///
/// El cuidado está en el redondeo. Si alguien pide recibir $100.000, ve
/// «publicá a $111.350», lo acepta, y el desglose de esa pantalla le dice que
/// va a recibir $99.998, la herramienta destruye exactamente la confianza que
/// vino a construir.
///
/// Por eso se ajusta al centavo: se calcula la aproximación y después se sube
/// de a un centavo hasta que el neto real alcance lo pedido. Son una o dos
/// vueltas — el error de redondeo nunca es mayor que eso — y garantiza que
/// **nunca queda por debajo** de lo que la persona pidió.
///
/// Devuelve `null` si las tasas suman 100 % o más: ahí no hay precio posible y
/// hay que decirlo, no devolver un número absurdo.
int? precioParaRecibir({
  required int neto,
  required int comisionBps,
  required int costoDelProcesadorBps,
}) {
  if (neto <= 0) return null;

  final restanBps = comisionBps + costoDelProcesadorBps;
  if (restanBps >= 10000) return null;

  int netoDe(int precio) => desglosarPrecio(
        precio: precio,
        comisionBps: comisionBps,
        costoDelProcesadorBps: costoDelProcesadorBps,
      ).netoEstimado;

  // Aproximación inicial, redondeando hacia arriba.
  var precio = (neto * 10000 + (10000 - restanBps) - 1) ~/ (10000 - restanBps);

  /**
   * Y después el ajuste fino, en las DOS direcciones.
   *
   * La aproximación usa porcentajes exactos y el desglose usa porcentajes
   * redondeados al centavo, así que puede quedar corta o pasarse por uno o dos
   * centavos. Las dos cosas importan y por motivos distintos:
   *
   *   · Quedarse corta rompe la promesa: pidió recibir $100.000 y recibiría
   *     $99.998.
   *   · Pasarse le hace publicar más caro de lo necesario, que es plata que
   *     deja de vender sin saber por qué.
   *
   * Los topes son guardas: sin ellos, un error de signo colgaría la interfaz
   * en un bucle infinito mientras alguien escribe un precio.
   */
  for (var i = 0; i < 100 && netoDe(precio) < neto; i += 1) {
    precio += 1;
  }
  for (var i = 0; i < 100 && precio > 1 && netoDe(precio - 1) >= neto; i += 1) {
    precio -= 1;
  }

  return precio;
}
