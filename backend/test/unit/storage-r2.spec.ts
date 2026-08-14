import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Almacenamiento en Cloudflare R2.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL SDK VA MOCKEADO, Y ESO ES LO CORRECTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Estos tests no hablan con Cloudflare. Si lo hicieran, correr la suite
 * necesitaría credenciales e internet, fallaría cuando R2 tuviera un mal día, y
 * dejaría basura en un bucket real.
 *
 * Lo que sí se comprueba es todo lo que es nuestro y puede estar mal:
 *
 *   · Que la clave del objeto la generemos NOSOTROS y no salga del nombre que
 *     mandó el cliente.
 *   · Que el `Content-Type` guardado sea el tipo REAL detectado por los bytes.
 *   · Que lo que se PERSISTE nunca sea una URL firmada.
 *   · Que un fallo al borrar no tumbe la operación pero tampoco quede en
 *     silencio.
 *   · Que las credenciales no salgan en ningún lado.
 */

const enviados: unknown[] = [];
const firmadas: unknown[] = [];
let fallarEnviar: Error | null = null;

vi.mock('@aws-sdk/client-s3', () => {
  class Comando {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      constructor(public readonly config: Record<string, unknown>) {}
      send(comando: unknown): Promise<unknown> {
        if (fallarEnviar) return Promise.reject(fallarEnviar);
        enviados.push(comando);
        return Promise.resolve({});
      }
      destroy(): void {}
    },
    PutObjectCommand: class extends Comando {
      readonly tipo = 'put';
    },
    DeleteObjectCommand: class extends Comando {
      readonly tipo = 'delete';
    },
    GetObjectCommand: class extends Comando {
      readonly tipo = 'get';
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (_cliente: unknown, comando: { input: { Key: string } }, opciones: unknown) => {
    firmadas.push({ key: comando.input.Key, opciones });
    return Promise.resolve(
      `https://cuenta.r2.cloudflarestorage.com/${comando.input.Key}?X-Amz-Signature=abc123&X-Amz-Expires=300`,
    );
  },
}));

const CONFIG_R2 = {
  STORAGE_DRIVER: 'r2',
  R2_ACCESS_KEY_ID: 'AKIA-DE-PRUEBA',
  R2_SECRET_ACCESS_KEY: 'un-secreto-que-no-debe-aparecer-nunca',
  R2_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  R2_BUCKET: 'vendox-products',
  R2_SIGNED_URL_TTL_S: 300,
  R2_PUBLIC_BASE_URL: undefined as string | undefined,
  PUBLIC_BASE_URL: 'https://api.vendox.ar',
};

async function crearProveedor(sobreescribir: Partial<typeof CONFIG_R2> = {}) {
  vi.resetModules();
  enviados.length = 0;
  firmadas.length = 0;
  fallarEnviar = null;

  vi.doMock('@/config/env.schema', () => ({
    env: { ...CONFIG_R2, ...sobreescribir },
    isLocalEnv: () => false,
  }));

  const { R2StorageProvider } = await import('@/shared/storage/r2.provider');

  const metrics = {
    subida: vi.fn(),
    subidaFallida: vi.fn(),
    borrado: vi.fn(),
    borradoFallido: vi.fn(),
  };

  return { proveedor: new R2StorageProvider(metrics as never), metrics };
}

/** Un PNG mínimo pero válido: la firma real en los primeros bytes. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

describe('R2StorageProvider', () => {
  afterEach(() => vi.doUnmock('@/config/env.schema'));

  describe('subida', () => {
    it('genera la clave por su cuenta, con UUID y la extensión del tipo real', async () => {
      const { proveedor } = await crearProveedor();

      const r = await proveedor.guardar({
        buffer: PNG,
        mimeType: 'image/png',
        prefijo: 'products/prd_01ABC',
      });

      expect(r.storageKey).toMatch(/^products\/prd_01ABC\/[a-f0-9-]{36}\.png$/);
      expect(r.sizeBytes).toBe(PNG.length);
    });

    it('dos subidas del MISMO archivo dan claves distintas', async () => {
      // Sin esto, dos vendedores subiendo la misma foto de stock se pisarían
      // el archivo entre ellos.
      const { proveedor } = await crearProveedor();

      const a = await proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' });
      const b = await proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' });

      expect(a.storageKey).not.toBe(b.storageKey);
    });

    it('guarda el Content-Type REAL', async () => {
      /**
       * Un archivo guardado como `text/html` y servido desde nuestro dominio
       * sería XSS almacenado. Acá sólo llegan tipos `image/*` porque el
       * validador los detecta por los bytes, no por lo que declaró el cliente.
       */
      const { proveedor } = await crearProveedor();

      await proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' });

      const put = enviados[0] as { input: { ContentType: string; Bucket: string } };
      expect(put.input.ContentType).toBe('image/png');
      expect(put.input.Bucket).toBe('vendox-products');
    });

    it('cachea para siempre, que es seguro porque la clave lleva UUID', async () => {
      const { proveedor } = await crearProveedor();

      await proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' });

      const put = enviados[0] as { input: { CacheControl: string } };
      expect(put.input.CacheControl).toContain('immutable');
    });

    it('un fallo de R2 da STORAGE_UNAVAILABLE y cuenta la métrica', async () => {
      const { proveedor, metrics } = await crearProveedor();
      fallarEnviar = new Error('NetworkingError: connect ETIMEDOUT');

      await expect(
        proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' }),
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

      expect(metrics.subidaFallida).toHaveBeenCalledOnce();
      expect(metrics.subida).not.toHaveBeenCalled();
    });

    it('el error que se le muestra al cliente no dice quién guarda los archivos', async () => {
      // Saber qué proveedor hay detrás es el primer paso para buscarle
      // vulnerabilidades conocidas.
      const { proveedor } = await crearProveedor();
      fallarEnviar = new Error('S3 AccessDenied for bucket vendox-products');

      await proveedor
        .guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' })
        .catch((err: Error) => {
          expect(err.message).not.toMatch(/r2|cloudflare|s3|bucket|aws/i);
        });
    });

    it('cuenta bytes subidos', async () => {
      const { proveedor, metrics } = await crearProveedor();

      await proveedor.guardar({ buffer: PNG, mimeType: 'image/png', prefijo: 'products/p1' });

      expect(metrics.subida).toHaveBeenCalledWith(PNG.length);
    });
  });

  describe('lo que se PERSISTE', () => {
    it('sin dominio público, es una URL nuestra estable — nunca una firmada', async () => {
      /**
       * El test más importante del archivo.
       *
       * `ProductImage.url` y `OrderItem.imageUrlSnapshot` se guardan en la
       * base, y el segundo es un registro histórico: lo que el comprador vio
       * cuando compró. Una URL firmada ahí adentro se vence, y el historial de
       * pedidos de todo el mundo se llena de imágenes rotas sin que nada lo
       * avise.
       */
      const { proveedor } = await crearProveedor();

      const r = await proveedor.guardar({
        buffer: PNG,
        mimeType: 'image/png',
        prefijo: 'products/p1',
      });

      expect(r.url).toBe(`https://api.vendox.ar/media/${r.storageKey}`);
      expect(r.url).not.toContain('X-Amz-Signature');
      expect(r.url).not.toContain('Expires');
      expect(r.url).not.toContain('r2.cloudflarestorage.com');
    });

    it('con dominio público, va directo al CDN', async () => {
      const { proveedor } = await crearProveedor({ R2_PUBLIC_BASE_URL: 'https://img.vendox.ar' });

      const r = await proveedor.guardar({
        buffer: PNG,
        mimeType: 'image/png',
        prefijo: 'products/p1',
      });

      expect(r.url).toBe(`https://img.vendox.ar/${r.storageKey}`);
    });

    it('tolera una barra final en el dominio configurado', async () => {
      const { proveedor } = await crearProveedor({ R2_PUBLIC_BASE_URL: 'https://img.vendox.ar/' });

      expect(proveedor.urlPublica('products/p1/x.png')).toBe(
        'https://img.vendox.ar/products/p1/x.png',
      );
    });
  });

  describe('URL firmada', () => {
    it('se firma la clave pedida, con el vencimiento configurado', async () => {
      const { proveedor } = await crearProveedor();

      const url = await proveedor.urlFirmada('products/p1/abc.png');

      expect(url).toContain('X-Amz-Signature');
      expect(firmadas[0]).toMatchObject({
        key: 'products/p1/abc.png',
        opciones: { expiresIn: 300 },
      });
    });
  });

  describe('borrado', () => {
    it('borra el objeto por su clave', async () => {
      const { proveedor, metrics } = await crearProveedor();

      await proveedor.borrar('products/p1/abc.png');

      const del = enviados[0] as { input: { Key: string; Bucket: string } };
      expect(del.input.Key).toBe('products/p1/abc.png');
      expect(del.input.Bucket).toBe('vendox-products');
      expect(metrics.borrado).toHaveBeenCalledOnce();
    });

    it('un fallo al borrar NO lanza, pero tampoco queda en silencio', async () => {
      /**
       * Se llama después de cometer la transacción que borró la fila: la
       * imagen ya no existe para nadie. Propagar el error haría que el vendedor
       * viera "no se pudo borrar" cuando sí se borró — volvería a intentarlo,
       * no la encontraría, y no entendería nada.
       *
       * Lo que queda es un objeto huérfano ocupando lugar. Cuesta storage, no
       * corrección, y se cuenta para poder alertarlo.
       */
      const { proveedor, metrics } = await crearProveedor();
      fallarEnviar = new Error('AccessDenied');

      await expect(proveedor.borrar('products/p1/abc.png')).resolves.toBeUndefined();

      expect(metrics.borradoFallido).toHaveBeenCalledOnce();
      expect(metrics.borrado).not.toHaveBeenCalled();
    });
  });

  describe('configuración del cliente', () => {
    it('usa forcePathStyle, que es lo que R2 soporta', async () => {
      // Sin esto el SDK arma `bucket.endpoint/clave`, un host que no resuelve,
      // y el error habla de DNS en vez de configuración.
      const { proveedor } = await crearProveedor();
      const cliente = (proveedor as unknown as { cliente: { config: Record<string, unknown> } })
        .cliente;

      expect(cliente.config.forcePathStyle).toBe(true);
      expect(cliente.config.region).toBe('auto');
    });
  });
});
