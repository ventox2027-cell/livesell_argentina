import type { FastifyRequest } from 'fastify';

import { env } from '@/config/env.schema';
import type { DeploymentProvider } from '@/shared/http/deployment-provider';

export { PROVEEDORES, type DeploymentProvider } from '@/shared/http/deployment-provider';

/**
 * De dónde sale la IP de quien hace la petición, según dónde estemos corriendo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO NO PUEDE SER `req.ip` Y LISTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los endpoints de autenticación se limitan por IP, porque todavía no hay
 * usuario a quien atribuirle los intentos. Si quien llama puede elegir su
 * propia IP, elige una distinta en cada intento y el límite deja de existir.
 *
 * Con `trustProxy: true`, Fastify toma la entrada MÁS A LA IZQUIERDA de
 * `X-Forwarded-For`, y esa la escribe el cliente:
 *
 *     curl -H "X-Forwarded-For: 1.2.3.4" https://api.vendox.ar/api/v1/auth/google
 *
 * Ésa era la configuración. Se arregló, y este archivo es donde vive el
 * arreglo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DOS CAPAS, EN ESTE ORDEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **1. La cabecera propietaria del borde, si el proveedor tiene una.**
 *
 * Algunos bordes escriben una cabecera propia con la IP real y SOBRESCRIBEN
 * cualquier valor que venga de afuera. Cuando existe y está documentada, es la
 * fuente más confiable: no hay lista que interpretar ni saltos que contar.
 *
 * **2. `req.ip`, con `trustProxy` configurado como NÚMERO de saltos.**
 *
 * Fastify cuenta esa cantidad de posiciones desde la DERECHA de
 * `X-Forwarded-For` y se queda con la entrada que escribió nuestro proxy. Lo
 * que el cliente haya inventado queda a la izquierda y se ignora.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EL PROVEEDOR SE DECLARA Y NO SE DETECTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sería cómodo mirar si viene `Fly-Client-IP` y deducir "estamos en Fly". Eso
 * es exactamente el agujero que estamos cerrando: la detección se haría sobre
 * una cabecera que, fuera de Fly, la escribe cualquiera. Alguien manda
 * `Fly-Client-IP: 1.2.3.4` a un despliegue en Code Engine y vuelve a elegir su
 * propia IP.
 *
 * La regla es: **una cabecera sólo es confiable si el borde donde estamos
 * corriendo la sobrescribe**, y saber dónde estamos corriendo es configuración,
 * no algo a adivinar de la petición. Por eso `DEPLOYMENT_PROVIDER` es
 * obligatorio y su lista es cerrada.
 */

interface Estrategia {
  /**
   * Cabecera propietaria que el borde escribe SOBRESCRIBIENDO lo que venga de
   * afuera. `undefined` significa que este proveedor no tiene ninguna en la que
   * se pueda confiar, y entonces se usa sólo el conteo de saltos.
   *
   * ⚠️ Poner acá una cabecera que el borde sólo *agregue* —en vez de
   * sobrescribir— reabre la falsificación por completo, porque se leería antes
   * que el conteo de saltos y con más prioridad.
   */
  readonly cabecera?: string;
  /** Qué hace el borde, para que la decisión quede auditable en el código. */
  readonly porQue: string;
}

const ESTRATEGIAS: Record<DeploymentProvider, Estrategia> = {
  /**
   * Sin proxy. `req.ip` es la IP del socket, que no se puede falsificar porque
   * no sale de ninguna cabecera.
   */
  local: {
    porQue: 'sin proxy: la IP sale del socket TCP',
  },

  /**
   * Fly documenta `Fly-Client-IP` como la IP de origen, y su borde la escribe
   * descartando cualquier valor entrante. Es la única de las cuatro que hoy
   * tiene una cabecera propietaria en la que apoyarse.
   */
  fly: {
    cabecera: 'fly-client-ip',
    porQue: 'el borde de Fly escribe Fly-Client-IP y descarta la que venga de afuera',
  },

  /**
   * Render no publica una cabecera propietaria equivalente: documenta
   * `X-Forwarded-For`. Como su proxy AGREGA en vez de sobrescribir, leerla
   * directo sería volver al problema original.
   *
   * Se usa el conteo de saltos, que es justamente el mecanismo correcto para
   * una cabecera que se va acumulando.
   */
  render: {
    porQue: 'sin cabecera propietaria: X-Forwarded-For se resuelve contando saltos',
  },

  /**
   * IBM Code Engine corre sobre Knative con un ingress que agrega a
   * `X-Forwarded-For`. Mismo caso que Render: sin cabecera que el borde
   * sobrescriba, la vía segura es contar saltos.
   *
   * Si en algún momento IBM documenta una cabecera propietaria que el borde
   * sobrescriba, se agrega acá — y sólo entonces.
   */
  ibm_code_engine: {
    porQue: 'sin cabecera propietaria: X-Forwarded-For se resuelve contando saltos',
  },

  /**
   * Railway pone un proxy propio delante de cada servicio y, como Render e IBM,
   * documenta `X-Forwarded-For` sin publicar una cabecera propietaria que su
   * borde sobrescriba.
   *
   * ⚠️ Railway **sí** manda `X-Envoy-External-Address`, y es tentador usarla
   * porque trae una sola IP ya resuelta. No se usa: no está documentada como
   * garantía del borde, y una cabecera que el proxy *agregue* en vez de
   * sobrescribir se puede falsificar desde afuera. Leerla tendría más prioridad
   * que el conteo de saltos y reabriría el problema entero por comodidad.
   *
   * Con el conteo de saltos —`TRUSTED_PROXY_HOPS=1`, que es lo que agrega el
   * borde de Railway— la IP sale bien y no depende de nada que se pueda
   * inventar desde afuera.
   */
  railway: {
    porQue: 'sin cabecera propietaria confiable: X-Forwarded-For se resuelve contando saltos',
  },
};

/**
 * ¿Esto parece una dirección IP?
 *
 * ─── Por qué se valida algo que "no se puede falsificar" ───
 *
 * El valor termina siendo parte de una clave de Redis (`rl:auth:ip:<valor>`).
 * Aunque el borde sea confiable, aceptar una cadena arbitraria de una cabecera
 * y usarla para construir claves es la clase de cosa que se convierte en
 * problema cuando algo más arriba cambia: claves gigantes, claves con saltos de
 * línea, o simplemente un valor distinto por petición que hace crecer Redis sin
 * techo.
 *
 * Es una comprobación de forma, no de validez: alcanza con distinguir una
 * dirección de un texto cualquiera. Si no pasa, se cae a `req.ip`, que Fastify
 * ya validó.
 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

function pareceIp(valor: string): boolean {
  if (IPV4.test(valor)) {
    return valor.split('.').every((o) => Number(o) <= 255);
  }
  // IPv6 se comprueba flojo a propósito: la gramática completa es enorme y acá
  // sólo hace falta descartar lo que claramente no es una dirección.
  return IPV6.test(valor) && valor.includes(':');
}

export class ClientIpResolver {
  private readonly estrategia: Estrategia;

  constructor(readonly proveedor: DeploymentProvider) {
    this.estrategia = ESTRATEGIAS[proveedor];
  }

  /** Qué hace este proveedor. Se registra al arrancar. */
  get descripcion(): string {
    return `${this.proveedor}: ${this.estrategia.porQue}`;
  }

  resolver(req: FastifyRequest): string {
    const cabecera = this.estrategia.cabecera;

    if (cabecera) {
      const crudo = req.headers[cabecera];
      const valor = (Array.isArray(crudo) ? crudo[0] : crudo)?.trim();
      if (valor && pareceIp(valor)) return valor;
      // Presente pero con basura, o ausente: se cae al conteo de saltos en vez
      // de confiar en algo que no parece una dirección.
    }

    return req.ip;
  }
}

/**
 * El resolver del proceso.
 *
 * Se construye una vez, al importar. `DEPLOYMENT_PROVIDER` ya está validado
 * contra la lista cerrada por el esquema de configuración, así que acá no hay
 * nada que comprobar de nuevo.
 */
let compartido: ClientIpResolver | null = null;

export function resolverDeIp(): ClientIpResolver {
  compartido ??= new ClientIpResolver(env.DEPLOYMENT_PROVIDER);
  return compartido;
}

/** Atajo para el código que sólo quiere la IP. */
export function ipDelCliente(req: FastifyRequest): string {
  return resolverDeIp().resolver(req);
}
