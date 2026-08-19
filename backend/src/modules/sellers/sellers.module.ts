import { Module } from '@nestjs/common';

import { AuditService } from '@/shared/audit/audit.service';

import {
  IdentityVerificationProvider,
  ManualIdentityProvider,
  ManualTaxProvider,
  TaxVerificationProvider,
} from './identity.provider';
import { LimiteDeCatalogo } from './limite-de-catalogo';
import { TasaDeComision } from './tasa-de-comision.service';
import { MembresiasController } from './membresias.controller';
import { MembresiasService } from './membresias.service';
import { RiskService } from './risk.service';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

/**
 * Verificación de vendedores y riesgo.
 *
 * ─── Los proveedores de identidad se eligen acá ───
 *
 * Hoy los dos son manuales: una persona del equipo revisa. Cuando exista
 * contrato con RENAPER o con ARCA, se escribe el adaptador y se cambian estas
 * dos líneas. Nada del dominio se entera.
 *
 * **No hay adaptador falso.** Un `RenaperProvider` que devuelve `true` sin
 * llamar a nadie es una mentira que en tres meses alguien va a creer, y vamos a
 * tener vendedores "verificados por RENAPER" que nunca pasaron por ahí.
 */
@Module({
  controllers: [VerificationController, MembresiasController],
  providers: [
    VerificationService,
    RiskService,
    MembresiasService,
    LimiteDeCatalogo,
    TasaDeComision,
    AuditService,
    { provide: IdentityVerificationProvider, useClass: ManualIdentityProvider },
    { provide: TaxVerificationProvider, useClass: ManualTaxProvider },
  ],
  /**
   * `MembresiasService` se exporta porque lo van a preguntar otros módulos:
   * cupones, métricas, y cualquier cosa que sea Pro. Que la respuesta salga de
   * un solo lugar es lo que evita que dos módulos definan "ser Pro" distinto.
   */
  exports: [VerificationService, RiskService, MembresiasService, LimiteDeCatalogo, TasaDeComision],
})
export class SellersModule {}
