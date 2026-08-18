import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';
import { conUrls, urlPublicaDe } from '@/shared/storage/url-publica';
import { exigirHabilitada } from '@/shared/config/banderas';
import { DomainError } from '@/shared/errors/domain.error';
import { DomainEvent, DomainEventBus } from '@/shared/events/domain-events';
import { PrismaService } from '@/shared/prisma/prisma.service';
import {
  MAX_IMAGENES_POR_PRODUCTO,
  StorageProvider,
  validarImagen,
  type ArchivoSubido,
} from '@/shared/storage/storage.provider';
import { newId } from '@/shared/utils/id';

import type { ReorderImagesDto } from './dto/commerce.dto';
import { OwnershipService } from './ownership.service';

/**
 * Imágenes de producto.
 *
 * ─── El orden importa más de lo que parece ───
 *
 * `position = 0` es la portada: la que se ve en el feed, en el listado y en el
 * chat cuando alguien comparte el producto. Para un vendedor, elegir cuál va
 * primero es una decisión de venta, no un detalle.
 *
 * Por eso reordenar es una operación propia y transaccional, y no un `PATCH`
 * de posición imagen por imagen — a mitad de camino quedarían dos con la misma
 * posición y la portada sería la que decidiera el orden de lectura.
 */

export class DemasiadasImagenesError extends DomainError {
  constructor() {
    super(
      'TOO_MANY_IMAGES',
      `Un producto puede tener hasta ${MAX_IMAGENES_POR_PRODUCTO} imágenes`,
      { max: MAX_IMAGENES_POR_PRODUCTO },
    );
  }
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  async upload(userId: string, productId: string, archivo: ArchivoSubido) {
    // Interruptor de emergencia. El caso real: alguien encontró cómo subir
    // un ejecutable disfrazado de imagen y hay que cerrar la puerta ya.
    exigirHabilitada('PRODUCT_UPLOAD_ENABLED');

    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });

    const cuantas = await this.prisma.productImage.count({ where: { productId: product.id } });
    if (cuantas >= MAX_IMAGENES_POR_PRODUCTO) throw new DemasiadasImagenesError();

    // Valida por CONTENIDO, no por lo que declaró el cliente. Ver la nota de
    // los números mágicos en storage.provider.ts.
    const mimeReal = validarImagen(archivo);

    const guardado = await this.storage.guardar({
      buffer: archivo.buffer,
      mimeType: mimeReal,
      prefijo: `products/${product.id}`,
    });

    const imagen = await this.prisma.productImage.create({
      data: {
        id: newId('img'),
        productId: product.id,
        url: guardado.url,
        storageKey: guardado.storageKey,
        mimeType: guardado.mimeType,
        sizeBytes: guardado.sizeBytes,
        // La primera que sube es la portada. Después puede reordenar.
        position: cuantas,
      },
    });

    this.events.publish(DomainEvent.imageAdded, {
      entityId: imagen.id,
      actorId: userId,
      data: { productId: product.id },
    });
    await this.audit.log({
      action: 'product.image_added',
      entityType: 'product',
      entityId: product.id,
      actorId: userId,
      after: { imageId: imagen.id, position: imagen.position },
    });

    // La `url` derivada, no la columna. Hoy dan lo mismo —se acaba de
    // escribir— pero devolver la columna acá y la derivada en todo el resto
    // sería dejar dos fuentes para el mismo dato.
    return { ...imagen, url: urlPublicaDe(imagen.storageKey) };
  }

  async remove(userId: string, productId: string, imageId: string) {
    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });

    const imagen = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId: product.id },
    });
    if (!imagen) throw new DomainError('IMAGE_NOT_FOUND', 'Imagen no encontrada');

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: imagen.id } });

      /**
       * Se compactan las posiciones.
       *
       * Sin esto, borrar la del medio deja un hueco (0, 2, 3) y el siguiente
       * `upload` calcula su posición contando filas — chocaría con una
       * existente. Los huecos en un orden explícito siempre terminan mal.
       */
      const restantes = await tx.productImage.findMany({
        where: { productId: product.id },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      for (const [i, img] of restantes.entries()) {
        await tx.productImage.update({ where: { id: img.id }, data: { position: i } });
      }
    });

    // El archivo se borra DESPUÉS de cometer la transacción. Al revés, un
    // fallo de base dejaría la fila apuntando a un archivo que ya no existe y
    // la app mostraría una imagen rota.
    await this.storage.borrar(imagen.storageKey);

    this.events.publish(DomainEvent.imageRemoved, {
      entityId: imagen.id,
      actorId: userId,
      data: { productId: product.id },
    });

    return { ok: true as const };
  }

  /**
   * Reordena.
   *
   * Recibe la lista completa en el orden deseado. Es más simple y más seguro
   * que mover de a una: no hay estados intermedios con posiciones repetidas.
   */
  async reorder(userId: string, productId: string, dto: ReorderImagesDto) {
    const { product } = await this.ownership.productOf(userId, productId, { requireActive: true });

    const actuales = await this.prisma.productImage.findMany({
      where: { productId: product.id },
      select: { id: true },
    });
    const idsValidos = new Set(actuales.map((i) => i.id));

    // La lista tiene que traer exactamente las mismas imágenes. Si trae una
    // ajena, es un intento de tocar el producto de otro; si falta una, el
    // resultado tendría huecos.
    if (dto.imageIds.length !== actuales.length) {
      throw new DomainError('VALIDATION_FAILED', 'La lista no coincide con las imágenes actuales');
    }
    for (const id of dto.imageIds) {
      if (!idsValidos.has(id)) {
        throw new DomainError('IMAGE_NOT_FOUND', 'Alguna imagen no pertenece a este producto');
      }
    }

    await this.prisma.$transaction(
      dto.imageIds.map((id, i) =>
        this.prisma.productImage.update({ where: { id }, data: { position: i } }),
      ),
    );

    await this.audit.log({
      action: 'product.images_reordered',
      entityType: 'product',
      entityId: product.id,
      actorId: userId,
      after: { orden: dto.imageIds },
    });

    const imagenes = await this.prisma.productImage.findMany({
      where: { productId: product.id },
      orderBy: { position: 'asc' },
      select: { id: true, storageKey: true, position: true, altText: true },
    });

    // Con `url` derivada, igual que en el resto de las respuestas: la app no
    // conoce `storageKey` ni tiene por qué.
    return conUrls(imagenes);
  }
}
