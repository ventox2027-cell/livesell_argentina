import { Injectable } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import type { UpsertAddressDto } from './dto/orders.dto';

/**
 * Direcciones de entrega.
 *
 * ─── Cuándo se pide ───
 *
 * No al registrarse: pedir una dirección para mirar un feed es gente que se va
 * antes de ver el primer video. Se pide antes de la PRIMERA compra, que es el
 * momento en que hay un motivo evidente para darla.
 *
 * ─── Una sola, y alcanza ───
 *
 * Nada de agenda de direcciones con etiquetas y favoritos. La mayoría de la
 * gente compra a su casa. El modelo soporta varias —hay `isDefault` y un
 * índice— pero la interfaz muestra una: agregar la segunda cuando alguien la
 * pida es fácil; sacar complejidad que ya se envió, no.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    return this.prisma.userAddress.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** La que se va a usar si no se elige otra. */
  async defaultFor(userId: string) {
    return this.prisma.userAddress.findFirst({
      where: { userId, deletedAt: null, isDefault: true },
    });
  }

  /**
   * Crea una dirección.
   *
   * Marcarla como principal desmarca la anterior **en la misma transacción**.
   * El índice único parcial no admite dos principales vivas, así que hacerlo
   * en dos pasos fallaría con un error de restricción a mitad de camino.
   */
  async create(userId: string, dto: UpsertAddressDto) {
    const id = newId('adr');

    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true, deletedAt: null },
          data: { isDefault: false },
        });
      }

      await tx.userAddress.create({
        data: {
          id,
          userId,
          recipientFullName: dto.recipientFullName,
          documentType: dto.documentType,
          documentNumber: dto.documentNumber,
          phoneE164: dto.phoneE164,
          street: dto.street,
          number: dto.number,
          floor: dto.floor ?? null,
          apartment: dto.apartment ?? null,
          city: dto.city,
          province: dto.province,
          postalCode: dto.postalCode,
          references: dto.references ?? null,
          isDefault: dto.isDefault,
        },
      });
    });

    // Los datos personales NO van a la bitácora: se registra que hubo una
    // dirección nueva, no cuál. La auditoría se lee entera cuando se investiga
    // algo y no tiene por qué exponer dónde vive la gente.
    void this.audit.log({
      action: 'address.created',
      entityType: 'user_address',
      entityId: id,
      actorId: userId,
      after: { isDefault: dto.isDefault, province: dto.province },
    });

    return this.prisma.userAddress.findUniqueOrThrow({ where: { id } });
  }

  /** Modifica una dirección propia. Ajena = no encontrada. */
  async update(userId: string, addressId: string, dto: UpsertAddressDto) {
    const existente = await this.prisma.userAddress.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    });
    if (!existente) throw new DomainError('ADDRESS_NOT_FOUND', 'Dirección no encontrada');

    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault && !existente.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId, isDefault: true, deletedAt: null },
          data: { isDefault: false },
        });
      }

      await tx.userAddress.update({
        where: { id: addressId },
        data: {
          recipientFullName: dto.recipientFullName,
          documentType: dto.documentType,
          documentNumber: dto.documentNumber,
          phoneE164: dto.phoneE164,
          street: dto.street,
          number: dto.number,
          floor: dto.floor ?? null,
          apartment: dto.apartment ?? null,
          city: dto.city,
          province: dto.province,
          postalCode: dto.postalCode,
          references: dto.references ?? null,
          isDefault: dto.isDefault,
        },
      });
    });

    return this.prisma.userAddress.findUniqueOrThrow({ where: { id: addressId } });
  }

  /**
   * Borrado lógico.
   *
   * Las órdenes ya guardaron su propia copia, así que borrarla no rompe
   * ningún historial. Igual no se borra de verdad: una dirección eliminada por
   * error se puede recuperar, y el costo de guardarla es una fila.
   */
  async remove(userId: string, addressId: string) {
    const { count } = await this.prisma.userAddress.updateMany({
      where: { id: addressId, userId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });
    if (count === 0) throw new DomainError('ADDRESS_NOT_FOUND', 'Dirección no encontrada');
    return { ok: true as const };
  }
}
