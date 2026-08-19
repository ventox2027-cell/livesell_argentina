/**
 * Contra qué conexión corren las migraciones, y por qué importa tanto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL FALLO QUE ESTE ARCHIVO EXISTE PARA EXPLICAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un despliegue en Railway murió dos veces, antes de arrancar Nest, con:
 *
 *     P1002  Timed out trying to acquire a postgres advisory lock
 *            SELECT pg_advisory_lock(72707369)
 *            Timeout: 10000ms
 *
 * `prisma migrate deploy` toma un lock de SESIÓN antes de aplicar nada. Es lo
 * que evita que dos contenedores que arrancan a la vez apliquen la misma
 * migración dos veces.
 *
 * PgBouncer en modo transacción no sostiene una sesión: cada sentencia puede
 * caer en un backend distinto. El `pg_advisory_lock` se toma en uno y la
 * consulta siguiente pregunta en otro, que no lo tiene. Nadie lo suelta y nadie
 * lo consigue: diez segundos y muere.
 *
 * ⚠️ El lock NO es el problema y no hay que desactivarlo. El problema es a
 * dónde se conecta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CÓMO ELIGE PRISMA, Y CÓMO SE COMPRUEBA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `schema.prisma` declara `directUrl = env("DIRECT_URL")`, y con eso Prisma
 * migra por ahí y consulta por `url`. Está bien declarado desde hace tiempo.
 *
 * Y el banner que imprime `migrate deploy` —«Datasource "db" … at HOST»— es el
 * host que **realmente usa**, no el de `DATABASE_URL`. Se comprobó poniendo un
 * host inexistente en `DATABASE_URL` y la base real en `DIRECT_URL`: la
 * migración funcionó e imprimió el host de `DIRECT_URL`.
 *
 * O sea que si el despliegue muestra el host del pooler, **`DIRECT_URL` es la
 * del pooler**. No es un detalle de presentación: es el diagnóstico.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTA COMPROBACIÓN VIVE APARTE DE `env.schema.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `env.schema.ts` ya rechazaba una `DIRECT_URL` con `-pooler`. Pero esa
 * validación corre cuando arranca `dist/main.js`, y `migrate deploy` corre
 * ANTES. El guard existía y nunca llegaba a hablar: el despliegue moría diez
 * segundos antes, con un mensaje sobre locks que no menciona la causa.
 *
 * Estas funciones son puras y no dependen del esquema completo, así que se
 * pueden usar en los dos lugares: en el arranque del contenedor, antes de
 * migrar, y dentro de la validación de configuración. Una sola definición de
 * «esto es una conexión agrupada».
 */

/**
 * Si una cadena de conexión pasa por un agrupador de conexiones.
 *
 * Dos marcas, y hacen falta las dos:
 *
 *   · `-pooler.` en el host — cómo lo nombra Neon.
 *   · `pgbouncer=true` en la query — cómo se le avisa a Prisma que hay
 *     PgBouncer delante, y lo que usan Supabase y las instalaciones propias.
 *
 * Con una sola, la otra forma se cuela. Y basta que se cuele una vez para que
 * un despliegue muera sin explicación.
 */
export function esConexionAgrupada(url: string): boolean {
  return url.includes('-pooler.') || /[?&]pgbouncer=true/i.test(url);
}

/**
 * La cadena con la que Prisma va a migrar.
 *
 * `DIRECT_URL` si está; si no, `DATABASE_URL`. Es exactamente la regla de
 * `directUrl` en `schema.prisma`, escrita acá para poder comprobarla sin
 * levantar Prisma.
 */
export function urlQueUsaMigrate(entorno: NodeJS.ProcessEnv): string {
  const directa = entorno.DIRECT_URL?.trim();
  if (directa) return directa;
  return entorno.DATABASE_URL?.trim() ?? '';
}

/**
 * El host, sin credenciales, para poder decirlo en un log.
 *
 * ⚠️ Nunca se imprime la cadena entera. Lleva usuario y contraseña de la base,
 * y los logs de una plataforma los ve más gente de la que uno cree — y quedan
 * guardados.
 */
export function hostSinCredenciales(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    // Una cadena que ni siquiera parsea no se muestra ni recortada: lo que sea
    // que tenga adentro, no se sabe.
    return '(cadena de conexión ilegible)';
  }
}

/** Qué está mal, o `null` si se puede migrar. */
export interface ProblemaDeConexion {
  readonly motivo: 'sin_url' | 'agrupada';
  readonly mensaje: string;
}

/**
 * Revisa que se pueda migrar antes de intentarlo.
 *
 * Devuelve el problema en vez de lanzar: quien llama decide si eso corta el
 * arranque —lo hace— o sólo se registra.
 */
export function revisarConexionDeMigraciones(
  entorno: NodeJS.ProcessEnv,
): ProblemaDeConexion | null {
  const url = urlQueUsaMigrate(entorno);

  if (!url) {
    return {
      motivo: 'sin_url',
      mensaje:
        'No hay ninguna cadena de conexión para migrar. Falta DATABASE_URL (y, con pooler, ' +
        'también DIRECT_URL).',
    };
  }

  if (esConexionAgrupada(url)) {
    const cual = entorno.DIRECT_URL?.trim() ? 'DIRECT_URL' : 'DATABASE_URL';
    return {
      motivo: 'agrupada',
      mensaje:
        `${cual} pasa por un agrupador de conexiones y las migraciones no pueden correr ` +
        'por ahí: `migrate deploy` toma un lock de sesión, y en modo transacción no hay ' +
        'sesión que lo sostenga. El síntoma es P1002, «Timed out trying to acquire a ' +
        'postgres advisory lock», diez segundos después.\n' +
        '  Solución: poné en DIRECT_URL la conexión DIRECTA de Neon — la misma cadena con ' +
        'el selector «Pooled connection» DESACTIVADO, sin `-pooler` en el host y sin ' +
        '`pgbouncer=true`.\n' +
        '  DATABASE_URL se deja como está: la API en marcha sí usa el pooler, y le conviene.',
    };
  }

  return null;
}
