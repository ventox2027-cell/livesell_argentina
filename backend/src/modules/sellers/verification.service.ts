import { createHmac } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { env } from '@/config/env.schema';
import { AuditService } from '@/shared/audit/audit.service';
import { DomainError } from '@/shared/errors/domain.error';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import {
  IdentityVerificationProvider,
  TaxVerificationProvider,
} from './identity.provider';
import { RiskService } from './risk.service';

/**
 * Verificación de identidad de vendedores.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL NÚMERO DE DOCUMENTO NO SE GUARDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Llega en la petición, se usa para consultar al proveedor, y se descarta. Lo
 * que queda en la base es un HMAC y los últimos cuatro dígitos.
 *
 * El HMAC —y no un hash pelado— porque un SHA-256 de un DNI argentino se
 * revierte por fuerza bruta en segundos: son cien millones de combinaciones
 * posibles y una tabla precalculada cabe en un pendrive. Con una clave secreta
 * de por medio, esa tabla no se puede construir sin robarla primero.
 *
 * Sirve exactamente para una cosa, y es la que importa: **detectar el mismo
 * documento en dos cuentas de vendedor**. Es la señal de fraude más directa que
 * tenemos —identidad robada, o alguien evadiendo una suspensión— y funciona sin
 * que el número esté en ningún lado.
 */

export class VerificacionInvalidaError extends DomainError {
  constructor(mensaje: string) {
    super('VALIDATION_FAILED', mensaje);
  }
}

export class SinVendedorError extends DomainError {
  constructor() {
    super('SELLER_NOT_FOUND', 'Todavía no sos vendedor');
  }
}

export interface DatosDeVerificacion {
  legalFirstName: string;
  legalLastName: string;
  docType: string;
  /** ⚠️ No se persiste. */
  docNumber: string;
  /** ⚠️ No se persiste. */
  taxId?: string;
  province: string;
  city: string;
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identidad: IdentityVerificationProvider,
    private readonly fiscal: TaxVerificationProvider,
    private readonly riesgo: RiskService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Huella de un documento.
   *
   * Usa `JWT_SECRET` como clave. No es lo ideal —lo correcto sería una clave
   * propia, rotable por separado— pero reutilizar una que ya existe y ya está
   * protegida es mucho mejor que inventar una tercera variable que alguien va a
   * dejar vacía en staging.
   *
   * ⚠️ Rotar `JWT_SECRET` invalida estas huellas: los duplicados dejarían de
   * detectarse hasta que cada vendedor reenvíe sus datos. Está anotado en
   * `docs/SELLER-VERIFICATION.md`.
   */
  private huella(valor: string): string {
    return createHmac('sha256', env.JWT_SECRET)
      .update(valor.replace(/\D/g, ''))
      .digest('hex');
  }

  private ultimos4(valor: string): string {
    const d = valor.replace(/\D/g, '');
    return d.slice(-4);
  }

  /** Lo que ve el vendedor de su propia verificación. Sin datos crudos. */
  async miEstado(userId: string) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      include: { verification: true },
    });
    if (!vendedor) throw new SinVendedorError();

    const v = vendedor.verification;

    return {
      estado: v?.state ?? 'NOT_STARTED',
      identidadVerificada: vendedor.verificationStatus === 'VERIFIED',
      enviadoEl: v?.submittedAt ?? null,
      revisadoEl: v?.reviewedAt ?? null,
      motivoRechazo: v?.rejectionReason ?? null,
      datos: v?.docNumberLast4
        ? {
            nombre: `${v.legalFirstName ?? ''} ${v.legalLastName ?? ''}`.trim(),
            documento: `${v.docType ?? 'DNI'} ····${v.docNumberLast4}`,
            cuit: v.taxIdLast4 ? `····${v.taxIdLast4}` : null,
            provincia: v.province,
            localidad: v.city,
          }
        : null,
      /**
       * El riesgo NO se le muestra al vendedor.
       *
       * Decirle "sos riesgo alto por estas cinco razones" es entregarle el mapa
       * exacto de qué evitar para no disparar las reglas. Quien está intentando
       * defraudar es justamente quien más provecho le saca.
       *
       * Lo que sí ve son sus límites, que son concretos y accionables.
       */
      limites: await this.riesgo.limitesDe(vendedor.id),
    };
  }

  /**
   * Envía los datos para revisión.
   *
   * Se puede reenviar tras un rechazo: la gente se equivoca tipeando, y no
   * poder corregirlo dejaría cuentas legítimas trabadas para siempre.
   */
  async enviar(userId: string, datos: DatosDeVerificacion, contexto: { ip?: string | null }) {
    const vendedor = await this.prisma.seller.findUnique({
      where: { userId },
      include: { verification: true },
    });
    if (!vendedor) throw new SinVendedorError();

    const actual = vendedor.verification;

    if (actual?.state === 'VERIFIED') {
      throw new VerificacionInvalidaError('Tu identidad ya está verificada');
    }
    if (actual?.state === 'IN_REVIEW') {
      throw new VerificacionInvalidaError('Ya la estamos revisando. Te avisamos cuando terminemos.');
    }

    // ─── Los proveedores ───
    //
    // Hoy son manuales y sólo validan la forma. Cuando existan los reales,
    // acá ya está el punto donde se los llama.

    const resIdentidad = await this.identidad.verificar({
      nombre: datos.legalFirstName,
      apellido: datos.legalLastName,
      tipoDocumento: datos.docType,
      numeroDocumento: datos.docNumber,
    });

    if (resIdentidad.verificado === false) {
      throw new VerificacionInvalidaError(resIdentidad.detalle);
    }

    const resFiscal = datos.taxId
      ? await this.fiscal.verificar({
          cuit: datos.taxId,
          nombre: datos.legalFirstName,
          apellido: datos.legalLastName,
        })
      : null;

    if (resFiscal?.verificado === false) {
      throw new VerificacionInvalidaError(resFiscal.detalle);
    }

    const docHash = this.huella(datos.docNumber);

    /**
     * ¿Este documento ya está en otra cuenta?
     *
     * No se rechaza el envío: puede haber explicaciones legítimas —una cuenta
     * vieja que la persona no recuerda, un error— y bloquear automáticamente
     * dejaría a gente honesta sin poder vender por una coincidencia que nadie
     * miró.
     *
     * Lo que hace es levantar el riesgo a alto, con su motivo, para que aparezca
     * arriba en el panel. La decisión la toma una persona.
     */
    const duplicado = await this.prisma.sellerVerification.findFirst({
      where: { docNumberHash: docHash, sellerId: { not: vendedor.id } },
      select: { sellerId: true },
    });

    if (duplicado) {
      this.logger.warn({
        msg: '⚠️ documento duplicado entre vendedores',
        sellerId: vendedor.id,
        otroSellerId: duplicado.sellerId,
      });
    }

    const datosGuardados = {
      state: 'PENDING' as const,
      legalFirstName: datos.legalFirstName,
      legalLastName: datos.legalLastName,
      docType: datos.docType,
      docNumberHash: docHash,
      docNumberLast4: this.ultimos4(datos.docNumber),
      taxIdHash: datos.taxId ? this.huella(datos.taxId) : null,
      taxIdLast4: datos.taxId ? this.ultimos4(datos.taxId) : null,
      province: datos.province,
      city: datos.city,
      identityProvider: resIdentidad.proveedor,
      identityCheckedAt: new Date(),
      identityResult: resIdentidad.detalle,
      taxProvider: resFiscal?.proveedor ?? null,
      taxCheckedAt: resFiscal ? new Date() : null,
      taxResult: resFiscal?.detalle ?? null,
      submittedAt: new Date(),
      rejectionReason: null,
    };

    await this.prisma.sellerVerification.upsert({
      where: { sellerId: vendedor.id },
      create: { id: newId('ver'), sellerId: vendedor.id, ...datosGuardados },
      update: datosGuardados,
    });

    await this.prisma.seller.update({
      where: { id: vendedor.id },
      data: { verificationStatus: 'PENDING' },
    });

    /**
     * La auditoría NO lleva el documento ni el CUIT.
     *
     * `AuditService` ya descarta `docNumber` por su lista de prohibidos, pero
     * acá directamente no se le pasa: la defensa que importa es no mandarlo, no
     * confiar en que lo filtren.
     */
    await this.audit.log({
      action: 'seller.verification_submitted',
      entityType: 'seller',
      entityId: vendedor.id,
      actorId: userId,
      after: {
        provincia: datos.province,
        documentoDuplicado: !!duplicado,
        proveedorIdentidad: resIdentidad.proveedor,
      },
      ip: contexto.ip,
    });

    await this.riesgo.recalcular(vendedor.id);

    return { estado: 'PENDING' as const, mensaje: 'Recibimos tus datos. Te avisamos cuando terminemos de revisarlos.' };
  }

  /**
   * Resuelve una verificación. Sólo desde el panel de administración.
   *
   * ─── Aprobar verifica la IDENTIDAD, no la calidad del vendedor ───
   *
   * `VERIFIED` significa "sabemos quién es". No dice nada sobre si vende bien,
   * si cumple, ni si conviene comprarle. Esa es la otra pregunta, y la responde
   * el nivel de riesgo con su historial.
   */
  async resolver(
    adminId: string,
    sellerId: string,
    decision: 'VERIFIED' | 'REJECTED',
    motivo: string,
  ) {
    const v = await this.prisma.sellerVerification.findUnique({ where: { sellerId } });
    if (!v) throw new VerificacionInvalidaError('Este vendedor no envió sus datos');

    if (v.state === decision) return { ok: true as const, yaEstaba: true };

    await this.prisma.$transaction([
      this.prisma.sellerVerification.update({
        where: { sellerId },
        data: {
          state: decision,
          reviewedAt: new Date(),
          reviewedBy: adminId,
          rejectionReason: decision === 'REJECTED' ? motivo : null,
        },
      }),
      this.prisma.seller.update({
        where: { id: sellerId },
        data: { verificationStatus: decision === 'VERIFIED' ? 'VERIFIED' : 'REJECTED' },
      }),
    ]);

    await this.audit.log({
      action: decision === 'VERIFIED' ? 'admin.seller_verified' : 'admin.seller_verification_rejected',
      entityType: 'seller',
      entityId: sellerId,
      actorId: adminId,
      actorType: 'admin',
      reason: motivo,
      before: { state: v.state },
      after: { state: decision },
    });

    await this.riesgo.recalcular(sellerId);

    return { ok: true as const, estado: decision };
  }

  /** Marca una verificación como en revisión, para que dos admins no la dupliquen. */
  async tomarParaRevisar(adminId: string, sellerId: string) {
    const { count } = await this.prisma.sellerVerification.updateMany({
      // La condición va en el WHERE: si otro admin la tomó primero, esto afecta
      // cero filas y lo sabemos sin una lectura previa que se pueda desactualizar.
      where: { sellerId, state: 'PENDING' },
      data: { state: 'IN_REVIEW', reviewedBy: adminId },
    });

    if (count === 0) {
      throw new VerificacionInvalidaError(
        'Esta verificación no está pendiente. Puede que otra persona la haya tomado.',
      );
    }

    return { ok: true as const };
  }
}
