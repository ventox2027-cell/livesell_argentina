// Dónde va cada cosa en la zona inferior del vivo.
//
// ═══════════════════════════════════════════════════════════════════════════
// POR QUÉ ESTO ES UN MÓDULO APARTE Y NO CUENTAS ADENTRO DEL `build`
// ═══════════════════════════════════════════════════════════════════════════
//
// Porque es la parte que tiene que estar demostrablemente bien y es la única
// que se puede demostrar sin un teléfono en la mano.
//
// La regla que sostiene la pantalla —**el producto destacado se queda quieto**—
// es aritmética. Verificarla mirando un emulador es mirar píxeles y creerles;
// verificarla acá es comparar dos números. Los tests de `live_layout_test.dart`
// afirman las invariantes, no las alturas concretas: las alturas se van a
// ajustar en el teléfono, las invariantes no.
//
// Las alturas son constantes y no medidas en vivo: medirlas con un
// `LayoutBuilder` obligaría a un segundo pase de layout en cada cuadro, y no
// cambian.

/// Alto de la tarjeta del producto destacado.
const double altoProducto = 76;

/// Alto de la barra para escribir.
const double altoComposer = 52;

/// Alto de la fila del vendedor con el botón de seguir.
const double altoVendedor = 48;

/// Separación entre bloques.
const double aire = 12;

/// Las distancias al borde inferior de cada bloque de la zona de abajo.
///
/// Todas son "cuánto sube desde el borde de la pantalla", que es lo que espera
/// `Positioned.bottom`.
class MedidasDelVivo {
  const MedidasDelVivo({
    required this.chat,
    required this.altoDelChat,
    required this.producto,
    required this.composer,
    required this.vendedor,
    required this.mostrarVendedor,
  });

  final double chat;
  final double altoDelChat;

  /// `null` cuando el vendedor no está destacando nada.
  final double? producto;

  final double composer;
  final double vendedor;

  /// `false` con el teclado abierto. La fila del vendedor es lo menos
  /// importante de la pantalla mientras alguien escribe, y es lo único que
  /// puede ceder su lugar sin perder función.
  final bool mostrarVendedor;
}

/// Calcula la zona inferior.
///
/// [teclado] es `viewInsets.bottom`; [abajo] es el `padding.bottom` del sistema
/// —la barra de gestos—; [hayProducto] dice si el vendedor está destacando algo.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// LA TENSIÓN DEL TECLADO, RESUELTA EXPLÍCITAMENTE
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El pedido era doble: que el producto **no se mueva**, y que se **siga
/// viendo** mientras se escribe —"quien escribe '¿tenés en negro?' necesita
/// seguir viendo qué está mirando"—.
///
/// Con el orden acordado (chat, producto, composer, vendedor) los dos no se
/// pueden cumplir a la vez. El composer tiene que quedar arriba del teclado, el
/// producto va justo arriba del composer, y un teclado de Android ocupa cerca
/// del 40% de la pantalla. Un producto clavado a ~124 px del borde queda
/// **detrás del teclado**: quieto, sí, pero invisible. Que es exactamente lo
/// que había que evitar.
///
/// La resolución: el producto **nunca baja** y **nunca queda tapado**. En
/// reposo está en su lugar de siempre; con el teclado abierto sube lo mínimo
/// indispensable para seguir a la vista, y nada más.
///
/// Lo que NO pasa —y es lo que motivaba el pedido— es que se desplace la
/// interfaz entera: el video, el encabezado, la columna de acciones y el velo
/// no se enteran de que hay un teclado. Sólo se acomodan los dos bloques que
/// tienen que estar sobre él.
///
/// ─── Las reglas, en orden de prioridad ───
///
///   1. El composer se ancla arriba del teclado.
///   2. El producto queda arriba del composer y **nunca se mueve hacia abajo**.
///   3. El chat cede: se achica y sube para no pisar nada.
///   4. El vendedor se oculta mientras se escribe.
/// Alto máximo del chat en reposo y con el teclado abierto.
///
/// Son topes, no valores fijos: el alto real se recorta al espacio que quede.
const double altoChatEnReposo = 160;
const double altoChatEscribiendo = 120;

/// Lo que hay que dejar libre arriba del chat.
///
/// El encabezado con el estado y los espectadores, más aire para que el primer
/// mensaje no arranque pegado a él. Sin este margen, en un teléfono chico el
/// chat trepa por encima del encabezado y los mensajes viejos se leen sobre los
/// contadores.
const double _respiroSuperior = 96;

MedidasDelVivo medirZonaInferior({
  required double teclado,
  required double abajo,
  required bool hayProducto,
  double altoPantalla = double.infinity,
  double arriba = 0,
}) {
  final tecladoAbierto = teclado > 0;

  final composer = tecladoAbierto ? teclado + aire : abajo + altoVendedor;

  // El lugar de siempre: el que ocupa cuando no hay teclado.
  final productoEnReposo = abajo + altoComposer + altoVendedor + aire;

  final producto = !hayProducto
      ? null
      // `max` y no un `if`: con esto el producto sólo puede subir. Un teclado
      // más bajo que su posición de reposo —los de sugerencias de algunos
      // teclados chinos, o un teclado físico con barra— lo deja donde estaba en
      // vez de tironearlo hacia abajo.
      : _mayor(productoEnReposo, composer + altoComposer + aire);

  // Todo lo que va debajo del chat. Se calcula en un solo lugar para que ningún
  // bloque elija su posición por su cuenta: si cada uno lo hiciera, cualquier
  // cambio de altura los pisaría entre sí.
  final techoDeLaZonaFija = producto != null ? producto + altoProducto : composer + altoComposer;

  final baseDelChat = techoDeLaZonaFija + aire;

  /**
   * El alto del chat es un TOPE recortado por el espacio que queda.
   *
   * Antes eran 160 px fijos. En un teléfono chico —o con el teclado abierto y
   * un producto destacado— la zona de abajo se come tanto alto que el chat
   * trepaba por encima del encabezado: los mensajes viejos quedaban sobre el
   * contador de espectadores y el botón de cerrar.
   *
   * `altoPantalla` es infinito por omisión para que quien no lo pase obtenga el
   * comportamiento de siempre; la pantalla sí lo pasa.
   */
  final deseado = tecladoAbierto ? altoChatEscribiendo : altoChatEnReposo;
  final disponible =
      altoPantalla.isFinite ? altoPantalla - arriba - _respiroSuperior - baseDelChat : deseado;

  return MedidasDelVivo(
    chat: baseDelChat,
    // El chat es lo único que cede espacio. Con el teclado abierto queda menos
    // pantalla libre, y mostrar menos mensajes es preferible a taparlos con el
    // composer. Nunca negativo: en una pantalla imposible se muestra nada, no
    // una altura al revés que reventaría el layout.
    altoDelChat: _entre(disponible, 0, deseado),
    producto: producto,
    composer: composer,
    vendedor: abajo + 4,
    mostrarVendedor: !tecladoAbierto,
  );
}

double _mayor(double a, double b) => a > b ? a : b;
double _entre(double v, double min, double max) => v < min ? min : (v > max ? max : v);
