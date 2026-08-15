import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  Beneficio,
  MembresiaGuardada,
  OrigenDeMembresia,
  Periodo,
  Plan,
  beneficiosDe,
  calcularVencimiento,
  diasRestantes,
  limitesDe,
  planVigente,
  tieneBeneficio,
} from './membresias';

/**
 * VendoX Pro: otorgar, revocar y preguntar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUIÉN OTORGA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hoy, una persona del equipo desde el panel de administración. No hay cobro:
 * ver el comentario de cabecera de `membresias.ts` para por qué.
 *
 * Eso hace que `otorgar` sea, literalmente, la función que regala dinero. Está
 * auditada siempre y con el motivo adentro: dentro de un año nadie va a
 * acordarse de por qué este vendedor tiene Pro gratis.
 */

export class SinBeneficioError extends DomainError {
  constructor(beneficio: Beneficio) {
    super('PRO_REQUIRED', `Esto necesita VendoX Pro`, { beneficio });
  }
}

export class LimiteDelPlanError extends DomainError {
  constructor(mensaje: string, datos: Record<string, unknown>) {
    super('PLAN_LIMIT_REACHED', mensaje, datos);
  }
}

@Injectable()
export class MembresiasService {
  private readonly logger = new Logger(MembresiasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lo guardado, sin resolver.
   *
   * ⚠️ Casi nadie debería llamar a esto directamente: devuelve la fila tal cual
   * y un Pro vencido sigue diciendo `PRO`. Usar `planDe` o `exigirBeneficio`.
   */
  private async guardada(sellerId: string): Promise<MembresiaGuardada | null> {
    const fila = await this.prisma.sellerMembership.findUnique({
      where: { sellerId },
      select: { plan: true, vigenteHasta: true },
    });
    return fila;
  }

  /** El plan que rige ahora mismo. */
  async planDe(sellerId: string): Promise<Plan> {
    return planVigente(await this.guardada(sellerId));
  }

  /** Si puede hacer algo. No lanza: para decidir qué mostrar. */
  async puede(sellerId: string, beneficio: Beneficio): Promise<boolean> {
    return tieneBeneficio(await this.guardada(sellerId), beneficio);
  }

  /**
   * Lo mismo, pero cortando.
   *
   * La comprobación va acá y no en un decorador de la ruta: un beneficio no es
   * un permiso de acceso, es una regla de negocio, y tiene que valer también
   * cuando quien llama es otro servicio.
   */
  async exigirBeneficio(sellerId: string, beneficio: Beneficio): Promise<void> {
    if (!(await this.puede(sellerId, beneficio))) throw new SinBeneficioError(beneficio);
  }

  /** Los límites numéricos del plan vigente. */
  async limitesDe(sellerId: string) {
    return limitesDe(await this.guardada(sellerId));
  }

  /**
   * Lo que ve el vendedor en su panel.
   *
   * ⚠️ No incluye precios. No hay cobro todavía, y mostrar un precio que
   * después cambia es peor que no mostrar ninguno: la regla de veracidad vale
   * también para lo que le cobramos a los vendedores.
   */
  async miMembresia(sellerId: string) {
    const fila = await this.prisma.sellerMembership.findUnique({
      where: { sellerId },
      select: { plan: true, vigenteHasta: true, periodo: true, origen: true, createdAt: true },
    });

    const plan = planVigente(fila);

    return {
      plan,
      beneficios: beneficiosDe(fila),
      limites: limitesDe(fila),
      vigenteHasta: plan === 'PRO' ? (fila?.vigenteHasta ?? null) : null,
      diasRestantes: diasRestantes(fila),
      periodo: plan === 'PRO' ? (fila?.periodo ?? null) : null,
      /**
       * Si lo que tiene fue un regalo o una prueba.
       *
       * El vendedor tiene derecho a saberlo: alguien con Pro de cortesía que
       * cree que lo está pagando no entiende por qué le vence.
       */
      origen: plan === 'PRO' ? (fila?.origen ?? 'GRATIS') : 'GRATIS',
      /**
       * ⚠️ Deliberadamente ausente: el sello de identidad verificada.
       *
       * Vive en `Seller.verificationStatus` y se pide por otro lado. Que no
       * viaje junto a esto es parte de que sean cosas distintas.
       */
    };
  }

  /**
   * Lo mismo, entrando por el usuario.
   *
   * El resto del servicio trabaja con `sellerId` porque quien pregunta suele
   * ser otro servicio que ya lo tiene. Los controladores tienen el `userId`.
   */
  async miMembresiaDeUsuario(userId: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'Todavía no sos vendedor');
    return this.miMembresia(vendedor.id);
  }

  /**
   * Otorga o renueva Pro.
   *
   * Renovar temprano SUMA al final en vez de reemplazar: alguien con dos
   * semanas por delante no puede perderlas por renovar antes de tiempo. Ver
   * `calcularVencimiento`.
   */
  async otorgar(
    sellerId: string,
    datos: {
      periodo: Periodo;
      origen: Exclude<OrigenDeMembresia, 'GRATIS'>;
      nota?: string;
      otorgadoPor?: string;
    },
  ) {
    // El vendedor tiene que existir: otorgarle Pro a un id inventado dejaría
    // una fila huérfana que nadie va a mirar nunca.
    const vendedor = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true },
    });
    if (!vendedor) throw new DomainError('SELLER_NOT_FOUND', 'No existe ese vendedor');

    const actual = await this.guardada(sellerId);
    const vigenteHasta = calcularVencimiento(datos.periodo, actual?.vigenteHasta ?? null);

    const fila = await this.prisma.sellerMembership.upsert({
      where: { sellerId },
      create: {
        id: newId('mem'),
        sellerId,
        plan: 'PRO',
        periodo: datos.periodo,
        origen: datos.origen,
        nota: datos.nota ?? null,
        otorgadoPor: datos.otorgadoPor ?? null,
        vigenteHasta,
      },
      update: {
        plan: 'PRO',
        periodo: datos.periodo,
        origen: datos.origen,
        nota: datos.nota ?? null,
        otorgadoPor: datos.otorgadoPor ?? null,
        vigenteHasta,
        // Se renovó: el próximo aviso de vencimiento tiene que volver a salir.
        avisadoEl: null,
      },
      select: { plan: true, vigenteHasta: true, periodo: true, origen: true },
    });

    /**
     * ⚠️ Se audita SIEMPRE, con el motivo y con quién lo dio.
     *
     * Es la función que regala dinero. Sin registro, un Pro de cortesía en la
     * base es indistinguible de uno que alguien puso por error.
     */
    await this.audit.log({
      action: 'membership.granted',
      entityType: 'seller',
      entityId: sellerId,
      actorId: datos.otorgadoPor ?? null,
      after: {
        plan: 'PRO',
        periodo: datos.periodo,
        origen: datos.origen,
        nota: datos.nota ?? null,
        vigenteHasta: vigenteHasta.toISOString(),
        // Lo anterior, para poder ver cuánto se extendió.
        vigenteHastaAnterior: actual?.vigenteHasta?.toISOString() ?? null,
      },
    });

    return fila;
  }

  /**
   * Le saca Pro.
   *
   * Vuelve a Free de inmediato, sin esperar al vencimiento: se usa cuando se
   * otorgó por error o cuando hay que cortar por abuso.
   *
   * ⚠️ No borra la fila. El historial de qué tuvo y cuándo es lo que permite
   * responder un reclamo.
   */
  async revocar(sellerId: string, motivo: string, actorId?: string) {
    const actual = await this.guardada(sellerId);
    if (!actual || actual.plan === 'FREE') {
      // No es un error: revocar algo que no tiene deja el mismo estado final.
      return { plan: 'FREE' as const, vigenteHasta: null };
    }

    const fila = await this.prisma.sellerMembership.update({
      where: { sellerId },
      data: { plan: 'FREE', vigenteHasta: null, periodo: null, origen: 'GRATIS', avisadoEl: null },
      select: { plan: true, vigenteHasta: true },
    });

    await this.audit.log({
      action: 'membership.revoked',
      entityType: 'seller',
      entityId: sellerId,
      actorId: actorId ?? null,
      after: {
        motivo,
        planAnterior: actual.plan,
        vigenteHastaAnterior: actual.vigenteHasta?.toISOString() ?? null,
      },
    });

    return fila;
  }
}
