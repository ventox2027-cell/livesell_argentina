import 'package:flutter/material.dart';

import '../../../shared/widgets/proximamente.dart';

class OrdersScreen extends StatelessWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Proximamente(
      titulo: 'Mis pedidos',
      icono: Icons.receipt_long_rounded,
      descripcion:
          'Qué compraste, en qué estado está y cuándo llega. Sin tener que '
          'escribirle al vendedor para averiguarlo.',
      modulo: 'Orders',
      puntos: [
        'Estado del pedido en tiempo real, del pago a la entrega.',
        'Comprobante de pago y datos del envío.',
        'Segunda compra en dos toques con el medio de pago guardado.',
        'Contacto directo con el vendedor por WhatsApp.',
      ],
    );
  }
}
