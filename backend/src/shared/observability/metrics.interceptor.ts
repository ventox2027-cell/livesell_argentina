import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const http = ctx.switchToHttp();
    const req = http.getRequest<{ method: string; routerPath?: string; url: string }>();
    const start = process.hrtime.bigint();

    // routerPath ('/api/v1/spike/sessions/:id') y no url ('/api/v1/spike/sessions/spk_01J…'):
    // usar la url cruda genera una serie temporal nueva por cada id y hace
    // explotar la cardinalidad de Prometheus.
    const route = req.routerPath ?? 'unknown';

    const record = (status: number) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.httpDuration.observe({ method: req.method, route, status: String(status) }, seconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(http.getResponse<{ statusCode: number }>().statusCode),
        error: (err: { status?: number }) => record(err?.status ?? 500),
      }),
    );
  }
}
