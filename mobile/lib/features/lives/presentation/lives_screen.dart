import 'package:flutter/material.dart';

import '../../../shared/widgets/proximamente.dart';

class LivesScreen extends StatelessWidget {
  const LivesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Proximamente(
      titulo: 'En vivo',
      icono: Icons.sensors_rounded,
      descripcion:
          'El corazón del producto: transmisiones ocurriendo ahora, con chat y '
          'compra sin salir del video.',
      modulo: 'Live Sessions',
      puntos: [
        'Grilla de transmisiones activas, ordenada por lo que está por terminar.',
        'Entrar a un vivo con menos de 600 ms de retraso: ya está medido y validado.',
        'Chat en tiempo real y productos destacados por el vendedor.',
        'Aviso cuando arranca alguien a quien seguís.',
        'Si al vendedor se le corta la red: último cuadro congelado y chat vivo, nunca pantalla negra.',
      ],
    );
  }
}
