import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { env, isLocalEnv } from '@/config/env.schema';

import { DomainError, HTTP_STATUS_BY_CODE } from './domain.error';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

/**
 * Traduce cualquier excepción a una respuesta uniforme.
 *
 * El cliente Flutter mapea SIEMPRE `error.code`, nunca `error.message`: el
 * mensaje puede cambiar de redacción sin previo aviso, el código no.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    const traceId = (req.headers['x-request-id'] as string) ?? req.id;

    const { status, body } = this.toResponse(exception, traceId);

    // 5xx = bug nuestro y hay que verlo. 4xx = el cliente pidió algo inválido.
    if (status >= 500) {
      this.logger.error({ err: exception, traceId, url: req.url }, body.error.message);
    } else {
      this.logger.warn({ code: body.error.code, traceId, url: req.url }, body.error.message);
    }

    void reply.status(status).send(body);
  }

  private toResponse(exception: unknown, traceId: string): { status: number; body: ErrorBody } {
    if (exception instanceof DomainError) {
      return {
        status: HTTP_STATUS_BY_CODE[exception.code] ?? 400,
        body: {
          error: { code: exception.code, message: exception.message, details: exception.details, traceId },
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Los datos enviados no son válidos',
            details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            traceId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: 'HTTP_ERROR',
            message: typeof res === 'string' ? res : exception.message,
            details: typeof res === 'object' ? res : undefined,
            traceId,
          },
        },
      };
    }

    // Desconocido: nunca se filtra el detalle interno al cliente en producción.
    return {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Error interno',
          details:
            isLocalEnv(env.NODE_ENV) && exception instanceof Error
              ? { message: exception.message, stack: exception.stack }
              : undefined,
          traceId,
        },
      },
    };
  }
}
