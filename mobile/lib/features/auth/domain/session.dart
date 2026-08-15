/// Modelos de sesión y usuario.
///
/// Ningún campo sensible: acá no hay tokens de tarjeta, ni documentos, ni
/// contraseñas —el producto no tiene—. Lo que se guarda del usuario es lo que
/// la interfaz necesita mostrar.
library;

class Usuario {
  const Usuario({
    required this.id,
    required this.firstName,
    required this.lastName,
    required this.email,
    required this.role,
    this.phone,
    this.phoneVerified = false,
    this.whatsappOptIn = true,
    this.avatarUrl,
    this.fechaDeNacimiento,
  });

  factory Usuario.fromJson(Map<String, dynamic> j) => Usuario(
        id: j['id'] as String,
        firstName: j['firstName'] as String? ?? '',
        lastName: j['lastName'] as String? ?? '',
        email: j['email'] as String? ?? '',
        role: j['role'] as String? ?? 'buyer',
        phone: j['phone'] as String?,
        phoneVerified: j['phoneVerified'] as bool? ?? false,
        whatsappOptIn: j['whatsappOptIn'] as bool? ?? true,
        avatarUrl: j['avatarUrl'] as String?,
        // `AAAA-MM-DD` o null. Declarada, no verificada.
        fechaDeNacimiento: j['birthDate'] as String?,
      );

  final String id;
  final String firstName;
  final String lastName;
  final String email;
  final String role;
  final String? phone;
  final bool phoneVerified;
  final bool whatsappOptIn;
  final String? avatarUrl;

  /// Fecha de nacimiento declarada, `AAAA-MM-DD`. VendoX es 18+.
  ///
  /// Se declara una sola vez: el backend rechaza el cambio. Por eso la app
  /// muestra el dato pero no ofrece editarlo.
  final String? fechaDeNacimiento;

  Map<String, dynamic> toJson() => {
        'id': id,
        'firstName': firstName,
        'lastName': lastName,
        'email': email,
        'role': role,
        'phone': phone,
        'phoneVerified': phoneVerified,
        'whatsappOptIn': whatsappOptIn,
        'avatarUrl': avatarUrl,
        'birthDate': fechaDeNacimiento,
      };

  String get nombreCompleto => '$firstName $lastName'.trim();

  /// Iniciales para el avatar cuando no hay foto. Con una sola letra el
  /// círculo se ve vacío; con tres, apretado.
  String get iniciales {
    final a = firstName.isNotEmpty ? firstName[0] : '';
    final b = lastName.isNotEmpty ? lastName[0] : '';
    final r = '$a$b'.toUpperCase();
    return r.isEmpty ? '?' : r;
  }

  bool get esVendedor => role == 'seller';
}

/// Lo que le falta a la cuenta para poder comprar.
///
/// Es el contrato del onboarding progresivo: se entra con un toque y la app
/// pide cada dato en el momento en que hace falta, no todos al principio.
enum DatoFaltante {
  telefono,
  verificacionTelefono,
  nombre,

  /// VendoX es 18+. Se pide antes de comprar y antes de crear la tienda.
  fechaDeNacimiento;

  static DatoFaltante? desde(String raw) => switch (raw) {
        'phone' => DatoFaltante.telefono,
        'phoneVerification' => DatoFaltante.verificacionTelefono,
        'name' => DatoFaltante.nombre,
        'birthDate' => DatoFaltante.fechaDeNacimiento,
        _ => null,
      };
}

/// Estado de autenticación de la aplicación.
///
/// `desconocido` existe y no es lo mismo que `sinSesion`: al arrancar hay unos
/// milisegundos leyendo el Keychain, y sin ese tercer estado la app muestra la
/// pantalla de login por un instante antes de entrar. Ese parpadeo se ve, y se
/// ve mal.
sealed class EstadoSesion {
  const EstadoSesion();
}

class SesionDesconocida extends EstadoSesion {
  const SesionDesconocida();
}

class SinSesion extends EstadoSesion {
  const SinSesion({this.motivo});

  /// Por qué se cerró. Permite decir "tu sesión venció" en vez de mostrar el
  /// login sin explicación después de que la app se cerró sola.
  final String? motivo;
}

class ConSesion extends EstadoSesion {
  const ConSesion({required this.usuario, this.faltantes = const []});
  final Usuario usuario;
  final List<DatoFaltante> faltantes;

  bool get puedeComprar => !faltantes.contains(DatoFaltante.telefono);
}
