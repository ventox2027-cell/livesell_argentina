import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Valida el payload contra un esquema Zod.
 *
 * Se usa por parámetro: `@Body(new ZodValidationPipe(CreateSessionSchema))`.
 * El ZodError que lanza lo captura DomainExceptionFilter y lo convierte en un
 * 400 con la lista de campos que fallaron.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    return this.schema.parse(value);
  }
}
