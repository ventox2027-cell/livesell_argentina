import { Injectable } from '@nestjs/common';

import { PrismaService } from '@/shared/prisma/prisma.service';

import {
  verDevolucion,
  verIntentoDePago,
  verOrden,
  verProducto,
  verUsuario,
  verVendedor,
} from './admin.view';

/**
 * Búsqueda global.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNA SOLA CAJA, PORQUE ASÍ LLEGA EL PROBLEMA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Quien atiende recibe *"pagué y no veo la compra"* con un dato pegado de
 * cualquier lado: el mail, el número de pedido del correo de confirmación, o
 * un id de Mercado Pago copiado del resumen de la tarjeta. No sabe —ni tiene
 * por qué saber— si eso es un `orderId`, un `paymentAttemptId` o un
 * `providerPaymentId`.
 *
 * Diez buscadores distintos obligarían a adivinar antes de buscar. Una caja
 * sola resuelve el caso real.
 *
 * ─── Por prefijo, no a ciegas ───
 *
 * Los ids del sistema llevan prefijo (`usr_`, `ord_`, `prd_`, `pay_`). Cuando
 * el texto empieza con uno conocido, se consulta **esa tabla y ninguna otra**:
 * una lectura por clave primaria en lugar de nueve consultas en paralelo.
 *
 * Sin eso, cada búsqueda de un id sería un barrido de la mitad del esquema, y
 * la caja de búsqueda —lo que más se usa en un panel de soporte— sería lo más
 * caro que hace la base.
 *
 * ─── Lo que NO hace ───
 *
 * **No hay búsqueda parcial de texto sobre datos personales.** No se puede
 * buscar "juan" y obtener todos los usuarios que se llaman Juan.
 *
 * Es deliberado: un panel que lista personas por coincidencia parcial es un
 * exportador de base de datos con otra interfaz. Para operar hace falta
 * encontrar a *alguien concreto* del que ya se tiene un dato exacto, no
 * explorar quiénes hay.
 *
 * El email y el teléfono se buscan por igualdad exacta. Los nombres de
 * producto y tienda sí admiten prefijo, porque no son datos personales.
 */

const PREFIJOS: Record<string, 'usuario' | 'vendedor' | 'tienda' | 'producto' | 'orden' | 'pago' | 'devolucion' | 'reserva'> = {
  usr: 'usuario',
  sel: 'vendedor',
  sto: 'tienda',
  prd: 'producto',
  ord: 'orden',
  pay: 'pago',
  ref: 'devolucion',
  rsv: 'reserva',
};

export interface ResultadoBusqueda {
  interpretadoComo: string;
  usuarios: ReturnType<typeof verUsuario>[];
  vendedores: ReturnType<typeof verVendedor>[];
  productos: ReturnType<typeof verProducto>[];
  ordenes: ReturnType<typeof verOrden>[];
  pagos: ReturnType<typeof verIntentoDePago>[];
  devoluciones: ReturnType<typeof verDevolucion>[];
}

const VACIO: Omit<ResultadoBusqueda, 'interpretadoComo'> = {
  usuarios: [],
  vendedores: [],
  productos: [],
  ordenes: [],
  pagos: [],
  devoluciones: [],
};

@Injectable()
export class AdminSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(q: string): Promise<ResultadoBusqueda> {
    const texto = q.trim();

    const prefijo = /^([a-z]{3})_/.exec(texto)?.[1];
    const tipo = prefijo ? PREFIJOS[prefijo] : undefined;

    if (tipo) return this.porId(tipo, texto);
    if (texto.includes('@')) return this.porEmail(texto);
    if (/^\+?\d[\d\s-]{5,}$/.test(texto)) return this.porTelefono(texto);

    /**
     * Sin prefijo ni forma reconocible.
     *
     * El caso típico es un `providerPaymentId` de Mercado Pago, que es un
     * número largo sin prefijo, o la referencia de una orden. Ambos son
     * búsquedas por igualdad sobre columnas indexadas.
     *
     * Se agrega la búsqueda por prefijo de nombre de producto, que no es dato
     * personal y es cómoda para encontrar qué vende alguien.
     */
    return this.porTextoLibre(texto);
  }

  private async porId(tipo: string, id: string): Promise<ResultadoBusqueda> {
    const interpretadoComo = `id de ${tipo}`;

    switch (tipo) {
      case 'usuario': {
        const u = await this.prisma.user.findUnique({ where: { id } });
        return { interpretadoComo, ...VACIO, usuarios: u ? [verUsuario(u)] : [] };
      }
      case 'vendedor': {
        const s = await this.prisma.seller.findUnique({ where: { id } });
        return { interpretadoComo, ...VACIO, vendedores: s ? [verVendedor(s)] : [] };
      }
      case 'tienda': {
        // Una tienda se busca para llegar a su vendedor y a sus productos.
        const [vendedor, productos] = await Promise.all([
          this.prisma.store
            .findUnique({ where: { id }, select: { seller: true } })
            .then((r) => r?.seller ?? null),
          this.prisma.product.findMany({ where: { storeId: id }, take: 20 }),
        ]);
        return {
          interpretadoComo,
          ...VACIO,
          vendedores: vendedor ? [verVendedor(vendedor)] : [],
          productos: productos.map(verProducto),
        };
      }
      case 'producto': {
        const p = await this.prisma.product.findUnique({ where: { id } });
        return { interpretadoComo, ...VACIO, productos: p ? [verProducto(p)] : [] };
      }
      case 'orden': {
        const o = await this.prisma.order.findUnique({
          where: { id },
          include: { attempts: true, refunds: true },
        });
        if (!o) return { interpretadoComo, ...VACIO };
        return {
          interpretadoComo,
          ...VACIO,
          ordenes: [verOrden(o)],
          pagos: o.attempts.map(verIntentoDePago),
          devoluciones: o.refunds.map(verDevolucion),
        };
      }
      case 'pago': {
        const a = await this.prisma.paymentAttempt.findUnique({
          where: { id },
          include: { order: true },
        });
        if (!a) return { interpretadoComo, ...VACIO };
        return {
          interpretadoComo,
          ...VACIO,
          pagos: [verIntentoDePago(a)],
          ordenes: [verOrden(a.order)],
        };
      }
      case 'devolucion': {
        const r = await this.prisma.refund.findUnique({
          where: { id },
          include: { order: true },
        });
        if (!r) return { interpretadoComo, ...VACIO };
        return {
          interpretadoComo,
          ...VACIO,
          devoluciones: [verDevolucion(r)],
          ordenes: [verOrden(r.order)],
        };
      }
      case 'reserva': {
        // Una reserva interesa por la orden que salió de ella.
        const o = await this.prisma.order.findFirst({ where: { reservationId: id } });
        return { interpretadoComo, ...VACIO, ordenes: o ? [verOrden(o)] : [] };
      }
      default:
        return { interpretadoComo: 'desconocido', ...VACIO };
    }
  }

  private async porEmail(email: string): Promise<ResultadoBusqueda> {
    /**
     * Igualdad exacta, en minúsculas.
     *
     * La columna es única y está indexada, así que esto es una lectura por
     * índice. Un `contains` sería un escaneo completo **y** un listador de
     * direcciones ajenas.
     */
    const u = await this.prisma.user.findFirst({
      where: { email: { equals: email.toLowerCase(), mode: 'insensitive' } },
      include: { seller: true },
    });

    if (!u) return { interpretadoComo: 'email', ...VACIO };

    const ordenes = await this.prisma.order.findMany({
      where: { buyerId: u.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      interpretadoComo: 'email',
      ...VACIO,
      usuarios: [verUsuario(u)],
      vendedores: u.seller ? [verVendedor(u.seller)] : [],
      ordenes: ordenes.map(verOrden),
    };
  }

  private async porTelefono(tel: string): Promise<ResultadoBusqueda> {
    // Se normaliza a dígitos: quien busca puede escribirlo con espacios,
    // guiones o sin el +54.
    const digitos = tel.replace(/\D/g, '');
    if (digitos.length < 6) return { interpretadoComo: 'teléfono', ...VACIO };

    /**
     * Por sufijo, no por coincidencia libre.
     *
     * Los teléfonos se guardan en E.164 (`+5491122334455`) y la gente los dice
     * de mil formas. Comparar los últimos dígitos encuentra a la persona sin
     * exigir que quien atiende adivine el formato exacto.
     */
    const u = await this.prisma.user.findFirst({
      where: { phoneE164: { endsWith: digitos.slice(-8) } },
      include: { seller: true },
    });

    if (!u) return { interpretadoComo: 'teléfono', ...VACIO };

    return {
      interpretadoComo: 'teléfono',
      ...VACIO,
      usuarios: [verUsuario(u)],
      vendedores: u.seller ? [verVendedor(u.seller)] : [],
    };
  }

  private async porTextoLibre(texto: string): Promise<ResultadoBusqueda> {
    const [porReferencia, porPagoProveedor, porDevolucionProveedor, productos] = await Promise.all([
      this.prisma.order.findFirst({ where: { reference: texto } }),
      this.prisma.paymentAttempt.findMany({
        where: { providerPaymentId: texto },
        include: { order: true },
        take: 5,
      }),
      this.prisma.refund.findMany({
        where: { providerRefundId: texto },
        include: { order: true },
        take: 5,
      }),
      this.prisma.product.findMany({
        where: { name: { startsWith: texto, mode: 'insensitive' }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const ordenes = [
      ...(porReferencia ? [porReferencia] : []),
      ...porPagoProveedor.map((a) => a.order),
      ...porDevolucionProveedor.map((r) => r.order),
    ];

    // Una misma orden puede llegar por dos caminos —su referencia y su pago—.
    const unicas = new Map(ordenes.map((o) => [o.id, o]));

    return {
      interpretadoComo:
        porPagoProveedor.length > 0
          ? 'id de pago del proveedor'
          : porDevolucionProveedor.length > 0
            ? 'id de devolución del proveedor'
            : porReferencia
              ? 'referencia de orden'
              : 'nombre de producto',
      ...VACIO,
      ordenes: [...unicas.values()].map(verOrden),
      pagos: porPagoProveedor.map(verIntentoDePago),
      devoluciones: porDevolucionProveedor.map(verDevolucion),
      productos: productos.map(verProducto),
    };
  }
}
