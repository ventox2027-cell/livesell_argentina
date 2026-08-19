import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  esConexionAgrupada,
  hostSinCredenciales,
  revisarConexionDeMigraciones,
  urlQueUsaMigrate,
} from '@/config/conexion-de-migraciones';

/**
 * Que las migraciones nunca corran por el pooler.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL DESPLIEGUE QUE MURIÓ DOS VECES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     P1002  Timed out trying to acquire a postgres advisory lock
 *            SELECT pg_advisory_lock(72707369)
 *
 * `migrate deploy` toma un lock de SESIÓN. PgBouncer en modo transacción no
 * sostiene sesiones: el lock se toma en un backend y la consulta siguiente
 * pregunta en otro. Diez segundos y muere, con un mensaje que no menciona el
 * pooler por ningún lado.
 *
 * El guard ya existía en `env.schema.ts`… y corría al arrancar `main.js`, o
 * sea DESPUÉS de migrar. Existía y nunca llegaba a hablar.
 *
 * Estos tests son lo que impide que eso vuelva.
 */
const DIRECTA = 'postgresql://u:p@ep-mute-dust-acarpl7w.sa-east-1.aws.neon.tech/vendox_clean';
const AGRUPADA =
  'postgresql://u:p@ep-mute-dust-acarpl7w-pooler.sa-east-1.aws.neon.tech/vendox_clean';

describe('Detectar una conexión agrupada', () => {
  it('la directa de Neon no lo es', () => {
    expect(esConexionAgrupada(DIRECTA)).toBe(false);
  });

  it('⛔ el host con `-pooler` sí', () => {
    expect(esConexionAgrupada(AGRUPADA)).toBe(true);
  });

  /**
   * La otra forma de decirlo. Supabase y las instalaciones propias no ponen
   * `-pooler` en el host: avisan con la query.
   *
   * Con una sola de las dos marcas, la otra se cuela — y basta que se cuele
   * una vez para que un despliegue muera sin explicación.
   */
  it('⛔ `pgbouncer=true` en la query también', () => {
    expect(esConexionAgrupada(`${DIRECTA}?pgbouncer=true`)).toBe(true);
    expect(esConexionAgrupada(`${DIRECTA}?sslmode=require&pgbouncer=true`)).toBe(true);
  });

  it('⛔ y no se escapa por mayúsculas', () => {
    expect(esConexionAgrupada(`${DIRECTA}?PgBouncer=TRUE`)).toBe(true);
  });

  /**
   * `pgbouncer=false` NO es una conexión agrupada. Un `includes('pgbouncer')`
   * a secas la habría marcado, y habría bloqueado un despliegue correcto.
   */
  it('`pgbouncer=false` no marca nada', () => {
    expect(esConexionAgrupada(`${DIRECTA}?pgbouncer=false`)).toBe(false);
  });

  /** Una base local no tiene pooler y no puede quedar bloqueada. */
  it('la local pasa', () => {
    expect(esConexionAgrupada('postgresql://livesell:livesell@127.0.0.1:5433/livesell')).toBe(
      false,
    );
  });
});

describe('Qué URL usa migrate', () => {
  /**
   * Es la regla de `directUrl` en `schema.prisma`, escrita acá para poder
   * comprobarla sin levantar Prisma.
   *
   * Y se verificó contra Prisma de verdad: con un host inexistente en
   * DATABASE_URL y la base real en DIRECT_URL, `migrate deploy` funcionó e
   * imprimió el host de DIRECT_URL.
   */
  it('manda DIRECT_URL cuando está', () => {
    expect(urlQueUsaMigrate({ DATABASE_URL: AGRUPADA, DIRECT_URL: DIRECTA })).toBe(DIRECTA);
  });

  it('sin DIRECT_URL cae en DATABASE_URL', () => {
    expect(urlQueUsaMigrate({ DATABASE_URL: DIRECTA })).toBe(DIRECTA);
  });

  /** Una variable vacía es lo mismo que no tenerla. En un panel se deja así. */
  it('⛔ DIRECT_URL vacía no cuenta como definida', () => {
    expect(urlQueUsaMigrate({ DATABASE_URL: DIRECTA, DIRECT_URL: '   ' })).toBe(DIRECTA);
  });
});

describe('La revisión previa al arranque', () => {
  /** El caso normal en Railway: pooled para la API, directa para migrar. */
  it('pooled + directa está bien', () => {
    expect(revisarConexionDeMigraciones({ DATABASE_URL: AGRUPADA, DIRECT_URL: DIRECTA })).toBeNull();
  });

  /**
   * ⛔ EL FALLO EXACTO QUE SE VIO EN RAILWAY.
   *
   * Las dos variables con la cadena del pooler. Es el error natural cuando se
   * copian del mismo panel, y anula por completo la razón de que exista la
   * segunda.
   */
  it('⛔ DIRECT_URL apuntando al pooler se rechaza', () => {
    const p = revisarConexionDeMigraciones({ DATABASE_URL: AGRUPADA, DIRECT_URL: AGRUPADA });

    expect(p?.motivo).toBe('agrupada');
    expect(p?.mensaje).toContain('DIRECT_URL');
    // El mensaje tiene que nombrar el error que va a ver quien despliegue.
    expect(p?.mensaje).toContain('P1002');
    // Y decir qué hacer, no sólo qué está mal.
    expect(p?.mensaje).toContain('Pooled connection');
  });

  it('⛔ sin DIRECT_URL y con DATABASE_URL agrupada, también', () => {
    const p = revisarConexionDeMigraciones({ DATABASE_URL: AGRUPADA });

    expect(p?.motivo).toBe('agrupada');
    expect(p?.mensaje).toContain('DATABASE_URL');
  });

  it('⛔ sin ninguna URL se corta con un motivo distinto', () => {
    expect(revisarConexionDeMigraciones({})?.motivo).toBe('sin_url');
  });

  /** En local no hay pooler y no hay DIRECT_URL. No puede bloquear nada. */
  it('la configuración local pasa sin DIRECT_URL', () => {
    expect(
      revisarConexionDeMigraciones({
        DATABASE_URL: 'postgresql://livesell:livesell@127.0.0.1:5433/livesell',
      }),
    ).toBeNull();
  });
});

describe('El host que se imprime en los logs', () => {
  /**
   * ⛔ NUNCA la cadena entera.
   *
   * Lleva usuario y contraseña de la base. Los logs de una plataforma los ve
   * más gente de la que uno cree, y quedan guardados.
   */
  it('⛔ no filtra usuario ni contraseña', () => {
    const salida = hostSinCredenciales(
      'postgresql://neondb_owner:npg_SUPERSECRETO@ep-algo.neon.tech/vendox_clean?sslmode=require',
    );

    expect(salida).not.toContain('npg_SUPERSECRETO');
    expect(salida).not.toContain('neondb_owner');
    expect(salida).not.toContain('@');
  });

  /** Pero sí lo suficiente para poder verificar contra qué se migró. */
  it('muestra host y base', () => {
    expect(hostSinCredenciales(DIRECTA)).toBe(
      'ep-mute-dust-acarpl7w.sa-east-1.aws.neon.tech/vendox_clean',
    );
  });

  it('distingue la directa del pooler a simple vista', () => {
    expect(hostSinCredenciales(AGRUPADA)).toContain('-pooler');
    expect(hostSinCredenciales(DIRECTA)).not.toContain('-pooler');
  });

  /**
   * Una cadena rota no se muestra ni recortada: lo que sea que tenga adentro,
   * no se sabe. Y sobre todo, no puede tirar el proceso que existe para dar un
   * mensaje claro.
   */
  it('⛔ una cadena ilegible no explota ni muestra nada', () => {
    expect(hostSinCredenciales('esto no es una url')).toBe('(cadena de conexión ilegible)');
  });
});

/**
 * La configuracion que hace que todo esto funcione.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE LEEN LOS ARCHIVOS, Y NO ES UN CAPRICHO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El fallo no fue un bug de logica: fue de configuracion. `schema.prisma`
 * declaraba bien `directUrl`, `env.schema.ts` validaba bien el pooler, y el
 * despliegue murio igual — porque la validacion corria despues de migrar.
 *
 * Ninguna de esas tres cosas se puede comprobar ejecutando codigo: son la forma
 * de los archivos. Asi que se leen.
 *
 * Es la unica manera de que una refactorizacion futura no vuelva a dejar las
 * migraciones corriendo contra el pooler sin que nadie se entere.
 */
describe('La configuracion de migraciones no se puede romper en silencio', () => {
  const raiz = process.cwd();
  /**
   * El esquema SIN comentarios.
   *
   * ⚠️ Mismo cuidado que con el script de arranque, y por el mismo motivo: la
   * primera versión buscaba `directUrl = env("DIRECT_URL")` en el archivo
   * entero. Se comprobó comentando esa línea y el test seguía pasando — porque
   * la encontraba adentro del comentario.
   *
   * Un test que lee un archivo tiene que leer lo que el archivo DECLARA, no lo
   * que menciona.
   */
  const esquema = readFileSync(join(raiz, 'prisma/schema.prisma'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const arranque = readFileSync(join(raiz, 'scripts/arrancar.sh'), 'utf8');

  /** Las líneas que el shell EJECUTA, sin comentarios ni vacías. */
  const ordenDeComandos = arranque
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  /**
   * ⛔ Sin esta linea, Prisma migra por `url` — el pooler — y vuelve el P1002.
   */
  it('⛔ el esquema declara directUrl', () => {
    expect(esquema).toMatch(/directUrl\s*=\s*env\("DIRECT_URL"\)/);
  });

  /**
   * Y la de la aplicacion sigue siendo la agrupada. La API en marcha SI quiere
   * el pooler: son muchas conexiones cortas y es exactamente para lo que sirve.
   */
  it('el esquema deja `url` en DATABASE_URL para el runtime', () => {
    expect(esquema).toMatch(/\burl\s*=\s*env\("DATABASE_URL"\)/);
  });

  /**
   * ⛔ El cliente de Prisma en marcha se construye con DATABASE_URL.
   *
   * Si alguien lo cambiara a DIRECT_URL para «unificar», la API le pegaria a la
   * conexion directa de Neon: menos conexiones disponibles, y se agotan bajo
   * carga justo cuando mas gente esta comprando.
   */
  it('⛔ PrismaService usa DATABASE_URL, no DIRECT_URL', () => {
    const servicio = readFileSync(join(raiz, 'src/shared/prisma/prisma.service.ts'), 'utf8');

    expect(servicio).toContain('env.DATABASE_URL');
    expect(servicio).not.toContain('env.DIRECT_URL');
  });

  /**
   * ⛔ La revision corre ANTES de migrar.
   *
   * Es todo el arreglo. El guard ya existia en `env.schema.ts` y corria al
   * arrancar `main.js`, o sea despues: el despliegue moria diez segundos antes
   * con un error sobre locks que no menciona el pooler.
   */
  it('⛔ el arranque revisa la conexion antes de migrar', () => {
    /**
     * ⚠️ Sólo las líneas EJECUTABLES.
     *
     * La primera versión buscaba las cadenas en el archivo entero y comparaba
     * posiciones. Fallaba, y por una razón que vale la pena dejar escrita: el
     * comentario de cabecera de `arrancar.sh` menciona
     * `prisma migrate deploy && node dist/main.js` para explicar por qué NO se
     * hace así. El test comparaba contra esa mención y no contra el comando.
     *
     * Un test que lee un archivo tiene que leer lo que el archivo HACE, no lo
     * que cuenta.
     */
    const revision = ordenDeComandos.findIndex((l) => l.includes('revisar-conexion'));
    const migracion = ordenDeComandos.findIndex((l) => l.includes('prisma migrate deploy'));

    expect(revision).toBeGreaterThan(-1);
    expect(migracion).toBeGreaterThan(-1);
    expect(revision).toBeLessThan(migracion);
  });

  /**
   * ⛔ Y sigue fallando cerrado.
   *
   * `set -e` es lo que hace que una migracion fallida corte el arranque. Sin
   * eso, la API levantaria contra un esquema a medias: `/health` responde 200 y
   * cada consulta rompe. Es peor que no arrancar.
   */
  it('⛔ `set -e` sigue estando, y antes de todo', () => {
    expect(ordenDeComandos[0]).toBe('set -e');
  });

  /** Las migraciones se siguen aplicando solas al arrancar. */
  it('el arranque sigue migrando', () => {
    expect(arranque).toContain('prisma migrate deploy');
  });

  /**
   * Y Node sigue siendo PID 1: `exec` reemplaza el shell en vez de dejarlo de
   * padre. Sin eso, SIGTERM no llega y cada despliegue corta peticiones a la
   * mitad — con pagos en vuelo, eso es plata.
   */
  it('el arranque termina con exec', () => {
    expect(arranque).toMatch(/exec node dist\/main\.js/);
  });
});
