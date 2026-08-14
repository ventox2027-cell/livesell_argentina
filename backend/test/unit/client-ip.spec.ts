import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { ClientIpResolver, type DeploymentProvider } from '@/shared/http/client-ip';

/**
 * De dónde sale la IP que usa el límite de peticiones, en cada proveedor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE ESTÁ PROBANDO Y POR QUÉ IMPORTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los endpoints de autenticación se limitan por IP, porque todavía no hay
 * usuario a quien atribuirle los intentos. Si quien llama puede elegir su
 * propia IP, elige una distinta en cada intento y el límite no limita nada.
 *
 * El backend corría con `trustProxy: true`, que hace exactamente eso: Fastify
 * toma la entrada más a la izquierda de `X-Forwarded-For` y esa la escribe el
 * cliente.
 *
 * Cada test levanta **Fastify de verdad** con la configuración de un proveedor
 * y comprueba el comportamiento observable. Una prueba que sólo mirara la
 * constante de configuración habría pasado igual antes y después del arreglo.
 */

async function servidor(
  proveedor: DeploymentProvider,
  trustProxy: boolean | number,
): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy });
  const resolver = new ClientIpResolver(proveedor);
  app.get('/', (req) => ({ ip: resolver.resolver(req), socket: req.ip }));
  await app.ready();
  return app;
}

/** El caso que importa: el cliente miente y el proxy agrega la verdad detrás. */
const CLIENTE_MIENTE = '9.9.9.9, 203.0.113.7';
const LA_REAL = '203.0.113.7';

describe('ClientIpResolver', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Lo que tiene que valer para TODOS los proveedores
  // ───────────────────────────────────────────────────────────────────────────

  describe.each<[DeploymentProvider, number]>([
    ['fly', 1],
    ['render', 1],
    ['ibm_code_engine', 1],
  ])('%s (detrás de un proxy)', (proveedor, saltos) => {
    it('con el cliente mintiendo y el proxy agregando detrás, toma la del proxy', async () => {
      /**
       * El cliente manda `X-Forwarded-For: 9.9.9.9` fingiendo venir de ahí. El
       * proxy no lo borra —casi ninguno lo hace—: le agrega la IP real por
       * derecha. Llega:
       *
       *     X-Forwarded-For: 9.9.9.9, 203.0.113.7
       *                      ↑            ↑
       *              lo que inventó    lo que vio
       *               el cliente        el proxy
       *
       * Con `trustProxy: true` Fastify tomaba `9.9.9.9`.
       */
      const app = await servidor(proveedor, saltos);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-forwarded-for': CLIENTE_MIENTE },
      });

      expect(res.json().ip).toBe(LA_REAL);
      expect(res.json().ip).not.toBe('9.9.9.9');

      await app.close();
    });

    it('rellenar la izquierda con IPs inventadas no corre el resultado', async () => {
      // La forma obvia de intentar esquivar el conteo por saltos. No sirve: se
      // cuenta desde la derecha.
      const app = await servidor(proveedor, saltos);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          'x-forwarded-for': `1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, ${LA_REAL}`,
        },
      });

      expect(res.json().ip).toBe(LA_REAL);

      await app.close();
    });

    it('no acepta una cabecera de OTRO proveedor', async () => {
      /**
       * El test que justifica que `DEPLOYMENT_PROVIDER` se declare en vez de
       * detectarse.
       *
       * Si el resolver mirara `Fly-Client-IP` "por si acaso", en Render o en
       * Code Engine —donde ningún borde la sobrescribe— cualquiera la mandaría
       * y volvería a elegir su propia IP. Sólo se lee la cabecera del proveedor
       * declarado, y sólo si ese borde la sobrescribe.
       */
      const app = await servidor(proveedor, saltos);

      const ajenas = {
        'x-real-ip': '6.6.6.6',
        'x-client-ip': '6.6.6.6',
        'true-client-ip': '6.6.6.6',
        'cf-connecting-ip': '6.6.6.6',
        ...(proveedor === 'fly' ? {} : { 'fly-client-ip': '6.6.6.6' }),
      };

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { ...ajenas, 'x-forwarded-for': CLIENTE_MIENTE },
      });

      expect(res.json().ip).toBe(LA_REAL);
      expect(res.json().ip).not.toBe('6.6.6.6');

      await app.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Fly: el único con cabecera propietaria
  // ───────────────────────────────────────────────────────────────────────────

  describe('fly', () => {
    it('prefiere Fly-Client-IP sobre X-Forwarded-For', async () => {
      // El borde de Fly la escribe SOBRESCRIBIENDO lo que venga de afuera, así
      // que es más confiable que cualquier conteo de saltos.
      const app = await servidor('fly', 1);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          'fly-client-ip': '198.51.100.23',
          'x-forwarded-for': CLIENTE_MIENTE,
        },
      });

      expect(res.json().ip).toBe('198.51.100.23');

      await app.close();
    });

    /**
     * ⚠️ EL SUPUESTO DEL QUE DEPENDE EL CONTEO DE SALTOS
     *
     * `trustProxy: N` no valida nada: cuenta N posiciones desde la derecha y
     * confía en lo que encuentre. Es correcto sólo mientras haya exactamente N
     * proxies agregando su entrada.
     *
     * Si la petición llegara SIN pasar por el proxy, la única entrada de la
     * lista sería la que inventó el cliente, y contar un salto aterriza justo
     * ahí. En Fly la cabecera propietaria tapa ese caso; en Render y Code
     * Engine el que lo tapa es que las instancias no son alcanzables salvo por
     * el ingress.
     *
     * Queda escrito porque es la condición a re-verificar el día que se cambie
     * de proveedor o se agregue un CDN delante (ahí `TRUSTED_PROXY_HOPS` pasa
     * a 2).
     */
    it('Fly-Client-IP tapa el caso de una lista con una sola entrada', async () => {
      const app = await servidor('fly', 1);

      const conCabecera = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'fly-client-ip': LA_REAL, 'x-forwarded-for': '1.2.3.4' },
      });
      expect(conCabecera.json().ip).toBe(LA_REAL);

      // Sin ella, el conteo de saltos aterriza en lo que mandó el cliente.
      // Documentado, no deseable: por eso la cabecera va primero.
      const sinCabecera = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      expect(sinCabecera.json().ip).toBe('1.2.3.4');

      await app.close();
    });

    it('ignora un Fly-Client-IP que no parece una dirección', async () => {
      /**
       * El valor termina siendo parte de una clave de Redis
       * (`rl:auth:ip:<valor>`). Aceptar una cadena arbitraria de una cabecera
       * para construir claves es la clase de cosa que se vuelve un problema
       * cuando algo más arriba cambia: claves gigantes, con saltos de línea, o
       * simplemente una distinta por petición haciendo crecer Redis sin techo.
       */
      const app = await servidor('fly', 1);

      for (const basura of ['', '   ', 'no-es-una-ip', 'a'.repeat(500), '1.2.3', '999.1.1.1']) {
        const res = await app.inject({
          method: 'GET',
          url: '/',
          headers: { 'fly-client-ip': basura, 'x-forwarded-for': CLIENTE_MIENTE },
        });
        expect(res.json().ip).toBe(LA_REAL);
      }

      await app.close();
    });

    it('acepta IPv6', async () => {
      const app = await servidor('fly', 1);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'fly-client-ip': '2001:db8::1' },
      });

      expect(res.json().ip).toBe('2001:db8::1');

      await app.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Local
  // ───────────────────────────────────────────────────────────────────────────

  describe('local', () => {
    it('usa la IP del socket, que no sale de ninguna cabecera', async () => {
      const app = await servidor('local', 0);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          'x-forwarded-for': '1.2.3.4',
          'fly-client-ip': '1.2.3.4',
        },
      });

      expect(res.json().ip).toBe(res.json().socket);
      expect(res.json().ip).not.toBe('1.2.3.4');

      await app.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // La configuración vieja, para que quede escrito qué hacía
  // ───────────────────────────────────────────────────────────────────────────

  describe('trustProxy: true — el agujero que estaba en producción', () => {
    it('deja que el cliente elija su propia IP', async () => {
      const app = await servidor('render', true);

      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });

      expect(res.json().ip).toBe('1.2.3.4');

      await app.close();
    });

    it('cada intento puede venir de una IP distinta, así que el límite no limita', async () => {
      const app = await servidor('render', true);

      const vistas = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/',
          headers: { 'x-forwarded-for': `10.0.0.${i}` },
        });
        vistas.add(res.json().ip);
      }

      // 50 peticiones del mismo origen, 50 contadores distintos en Redis. Con
      // un límite de 10 por minuto se podían hacer todas las que se quisiera.
      expect(vistas.size).toBe(50);

      await app.close();
    });
  });

  describe('descripcion', () => {
    it('dice qué hace cada proveedor, para el log de arranque', () => {
      expect(new ClientIpResolver('fly').descripcion).toContain('Fly-Client-IP');
      expect(new ClientIpResolver('render').descripcion).toContain('saltos');
      expect(new ClientIpResolver('ibm_code_engine').descripcion).toContain('saltos');
      expect(new ClientIpResolver('local').descripcion).toContain('socket');
    });
  });
});
