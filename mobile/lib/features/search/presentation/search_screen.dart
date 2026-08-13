import 'package:flutter/material.dart';

import '../../../shared/widgets/proximamente.dart';

class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Proximamente(
      titulo: 'Buscar',
      icono: Icons.search_rounded,
      descripcion:
          'Encontrar un producto sin saber cómo se llama es la mitad del '
          'trabajo de una app de venta.',
      modulo: 'Search',
      puntos: [
        'Búsqueda por producto, vendedor y categoría, tolerante a errores de tipeo.',
        'Filtros por precio, provincia y disponibilidad de envío.',
        'Vendedores en vivo primero: lo que está pasando ahora vale más que lo grabado.',
        'Historial y sugerencias a partir de lo que mirás.',
      ],
    );
  }
}
