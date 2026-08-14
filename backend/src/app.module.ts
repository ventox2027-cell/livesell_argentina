import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { env } from '@/config/env.schema';
import { HealthModule } from '@/modules/health/health.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AuthModule } from '@/modules/auth/auth.module';
import { CommerceModule } from '@/modules/commerce/commerce.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { LiveKitModule } from '@/modules/livekit/livekit.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { SpikeModule } from '@/modules/spike/spike.module';
import { DomainExceptionFilter } from '@/shared/errors/domain-exception.filter';
import { loggerConfig } from '@/shared/observability/logger.config';
import { MetricsInterceptor } from '@/shared/observability/metrics.interceptor';
import { ObservabilityModule } from '@/shared/observability/observability.module';
import { PrismaModule } from '@/shared/prisma/prisma.module';
import { RedisModule } from '@/shared/redis/redis.module';

/**
 * Los módulos de spike solo existen si están explícitamente habilitados.
 *
 * No es una optimización: es la garantía de que endpoints sin autenticación de
 * usuario —uno crea salas de LiveKit, el otro mueve dinero— no puedan quedar
 * expuestos por olvido. `env.schema.ts` además impide encenderlos en producción.
 */
function optionalModules(): DynamicModule['imports'] {
  const modules: NonNullable<DynamicModule['imports']> = [];
  if (env.SPIKE_ENABLED) modules.push(SpikeModule);
  if (env.PAYMENTS_SPIKE_ENABLED) modules.push(PaymentsModule);
  return modules;
}

@Module({
  imports: [
    LoggerModule.forRoot(loggerConfig),
    // Bus de eventos de dominio en proceso. Ver shared/events/domain-events.ts.
    EventEmitterModule.forRoot({ maxListeners: 20, verboseMemoryLeak: true }),
    ObservabilityModule,
    PrismaModule,
    RedisModule,
    LiveKitModule,
    HealthModule,
    // Va antes que los módulos opcionales: registra los guards globales, y
    // todo lo que se monte después queda cerrado por defecto.
    AuthModule,
    CommerceModule,
    InventoryModule,
    OrdersModule,
    ...(optionalModules() ?? []),
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule {}
