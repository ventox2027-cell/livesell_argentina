/// Los interruptores de emergencia, tal como los publica el backend.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ESTO NO ES LA REGLA — ES LA INTERFAZ
/// ═══════════════════════════════════════════════════════════════════════════
///
/// La regla vive en el backend y rechaza con un 503 sin importar lo que la app
/// crea. Esta copia sirve para no dejar que alguien complete un checkout
/// entero, cargue la dirección, elija el envío y recién en el último toque
/// choque contra un error.
///
/// Por lo tanto puede quedar vieja sin consecuencias: se lee una vez al
/// arrancar. Si una bandera se apaga con la app abierta, quien esté adentro se
/// entera al intentar — con el mensaje del 503, que dice lo mismo.
///
/// ⚠️ **Todo por defecto en `true`.** Si el backend no manda el campo —una app
/// nueva contra un servidor viejo— la app no puede esconder medio producto. La
/// falta de información no es una emergencia; la emergencia la declara el
/// servidor diciéndolo.
class Banderas {
  const Banderas({
    this.vivos = true,
    this.checkout = true,
    this.altaDeVendedores = true,
    this.cargaDeProductos = true,
  });

  factory Banderas.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const Banderas();
    bool leer(String clave) => j[clave] as bool? ?? true;
    return Banderas(
      vivos: leer('LIVE_ENABLED'),
      checkout: leer('CHECKOUT_ENABLED'),
      altaDeVendedores: leer('SELLER_SIGNUP_ENABLED'),
      cargaDeProductos: leer('PRODUCT_UPLOAD_ENABLED'),
    );
  }

  /// Transmitir. No corta un vivo que ya está al aire.
  final bool vivos;

  /// Comprar. No toca los pedidos que ya existen.
  final bool checkout;

  /// Abrir una tienda. No suspende a quien ya vende.
  final bool altaDeVendedores;

  /// Cargar productos y subirles fotos. No esconde el catálogo.
  final bool cargaDeProductos;

  /// ¿Hay algo pausado?
  bool get algoPausado => !vivos || !checkout || !altaDeVendedores || !cargaDeProductos;

  /// El aviso que se muestra arriba de la pantalla afectada.
  ///
  /// No dice "bandera" ni qué se rompió: dice qué no se puede hacer ahora y
  /// que es temporal. Es la misma redacción que devuelve el backend en el 503,
  /// a propósito — leer dos textos distintos para lo mismo hace dudar de si
  /// son dos problemas.
  static const avisoDeVivos = 'Los vivos están pausados por unos minutos.';
  static const avisoDeCheckout =
      'Las compras están pausadas por unos minutos. Tu carrito no se pierde.';
  static const avisoDeAltaDeVendedores = 'El alta de vendedores está pausada por unos minutos.';
  static const avisoDeCargaDeProductos = 'La carga de productos está pausada por unos minutos.';
}
