import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'nestjs-pino';

/**
 * Apagado ordenado ante SIGTERM/SIGINT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ NO ALCANZA CON DEJAR QUE EL PROCESO MUERA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Toda plataforma de contenedores manda SIGTERM y espera un rato antes de
 * mandar SIGKILL. Lo que pase en ese rato decide si un despliegue es invisible
 * o si corta peticiones a la mitad.
 *
 * Sin apagado ordenado, en cada despliegue:
 *
 *   · Las peticiones en vuelo mueren. Para el comprador es un error de red en
 *     medio de un pago, y el resultado real de ese pago queda indeterminado —
 *     el caso más caro que maneja este sistema.
 *   · Las conexiones a PostgreSQL quedan abiertas del lado del servidor hasta
 *     que vencen. Con el pooler de Neon, eso consume cupo del que viene.
 *   · Los jobs de BullMQ que el worker tenía tomados quedan bloqueados hasta
 *     que vence su lock.
 *
 * ─── Las dos fases y por qué el orden importa ───
 *
 * **1. Drenaje.** No se cierra nada todavía: se espera. El balanceador tarda
 * en enterarse de que esta instancia se está yendo, y durante esos segundos
 * sigue mandando tráfico. Cerrar de una convierte cada petición de esa ventana
 * en un error. Esperar primero hace que las reciba y las conteste normalmente.
 *
 * **2. Cierre.** `app.close()` deja de aceptar conexiones nuevas, termina las
 * que están en curso y dispara `onModuleDestroy` en toda la aplicación: Prisma
 * se desconecta, Redis cierra, los temporizadores de los reconciliadores se
 * limpian y el worker de BullMQ devuelve los jobs que tenía tomados.
 *
 * ─── Los presupuestos ───
 *
 * Cada plataforma da un plazo distinto antes del SIGKILL: Fly da 30 s, Code
 * Engine y Render dan menos por omisión. El drenaje es configurable
 * (`SHUTDOWN_DRAIN_MS`) para poder ajustarlo sin recompilar, y el apagado
 * entero tiene un tope propio: si algo se cuelga cerrando —una consulta
 * eterna, un socket que no responde— es preferible salir por las nuestras que
 * esperar el SIGKILL, que no ejecuta ningún cierre.
 */

export interface OpcionesDeApagado {
  /** Cuánto esperar antes de cerrar, para que el balanceador nos saque. */
  drenajeMs: number;
  /** Tope total. Pasado esto se sale igual: el SIGKILL sería peor. */
  topeMs: number;
}

export function registrarApagadoOrdenado(
  app: INestApplicationContext,
  logger: Logger,
  opciones: OpcionesDeApagado,
): void {
  let apagando = false;

  const apagar = async (senal: string): Promise<void> => {
    // Una segunda señal no reinicia el proceso de apagado. Sin esta guarda, un
    // Ctrl+C repetido —o un SIGTERM seguido de SIGINT, que algunos
    // orquestadores mandan— arranca dos cierres en paralelo sobre las mismas
    // conexiones.
    if (apagando) {
      logger.warn(`${senal} recibido: ya se está apagando`);
      return;
    }
    apagando = true;

    logger.log({ senal, drenajeMs: opciones.drenajeMs }, 'apagado ordenado iniciado');

    /**
     * El tope corre en paralelo, no después.
     *
     * Si se pusiera un timeout alrededor de cada paso, un cierre lento en el
     * primero se comería el presupuesto de los demás. Así el reloj es uno solo
     * para todo el apagado, que es como lo mide la plataforma.
     */
    const tope = new Promise<'tope'>((resolver) => {
      const t = setTimeout(() => resolver('tope'), opciones.topeMs);
      // `unref` para que este temporizador no sea lo que mantiene vivo al
      // proceso si todo lo demás ya cerró.
      t.unref();
    });

    const cierre = (async (): Promise<'listo'> => {
      if (opciones.drenajeMs > 0) {
        await new Promise((r) => setTimeout(r, opciones.drenajeMs));
      }
      await app.close();
      return 'listo';
    })();

    const resultado = await Promise.race([cierre, tope]);

    if (resultado === 'tope') {
      logger.error(
        { topeMs: opciones.topeMs },
        'el apagado excedió su tope: se sale igual (algo quedó colgado cerrando)',
      );
      process.exit(1);
      // `process.exit` no vuelve, pero el compilador no lo sabe y los tests
      // que lo simulan tampoco: sin el return, seguirían hasta el `exit(0)` de
      // abajo y un apagado fallido se registraría como exitoso.
      return;
    }

    logger.log('apagado completo');
    process.exit(0);
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}
