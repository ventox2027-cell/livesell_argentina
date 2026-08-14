import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationType } from '@prisma/client';

import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import { PushProvider } from './push.provider';
import { proximoIntento, seAgoto } from './reintentos';

/**
 * Avisos.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESCRIBIR EL AVISO Y MANDARLO SON DOS COSAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `crear()` escribe una fila y vuelve. No habla con Firebase, no espera a
 * nadie, y se puede llamar desde adentro de la transacción que despacha un
 * pedido sin que un timeout de Google revierta el despacho.
 *
 * `despachar()` es un barrido aparte que lee las filas pendientes y las manda.
 *
 * El peor caso de esta separación es un aviso que llega tarde. El peor caso de
 * mandarlo en línea es un pedido que se revierte porque Google tardó.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CENTRO DE NOTIFICACIONES NO DEPENDE DEL PUSH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La mayoría de la gente tiene los push apagados. La fila existe igual, y la
 * persona ve el aviso al abrir la app. Un sistema que sólo mande push no le
 * avisa nada a la mayoría de sus usuarios.
 */

/** Lo que sale al cliente. Enumerado, no filtrado. */
const NOTIFICACION_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  data: true,
  readAt: true,
  createdAt: true,
  // ⚠️ `pushStatus`, `pushAttempts` y `nextAttemptAt` NO salen: son detalles de
  // nuestra maquinaria y a quien recibe el aviso no le dicen nada.
} satisfies Prisma.NotificationSelect;

export interface EntradaDeAviso {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** A dónde lleva tocarla. Todo se serializa a texto: FCM sólo acepta texto. */
  data?: Record<string, string | number | null | undefined>;
  /**
   * Clave de negocio para no repetir.
   *
   * Cuando existe, un segundo aviso con la misma clave NO crea otra fila. Es
   * la base la que lo garantiza —índice único—, no un `if` que puede perder
   * una carrera con otra instancia.
   */
  dedupeKey?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushProvider,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // ESCRIBIR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Deja un aviso listo para enviar.
   *
   * Devuelve `null` si ya existía uno con la misma `dedupeKey`. No es un error:
   * es la respuesta correcta a "avisale que la tienda abrió" cuando ya se le
   * avisó.
   */
  async crear(entrada: EntradaDeAviso): Promise<{ id: string } | null> {
    try {
      const fila = await this.prisma.notification.create({
        data: {
          id: newId('ntf'),
          userId: entrada.userId,
          type: entrada.type,
          title: entrada.title,
          body: entrada.body,
          data: this.aTexto(entrada.data),
          dedupeKey: entrada.dedupeKey ?? null,
          // Listo para el próximo barrido. Sin fecha, el índice del barrido no
          // lo encontraría.
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      });
      return fila;
    } catch (err) {
      // Ya se le había avisado. La carrera la resolvió el índice único.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  /**
   * Varios avisos de una, para el mismo evento.
   *
   * Ejemplo: una tienda que reabre le avisa a las cuarenta personas que dejaron
   * una intención. Cuarenta INSERT sueltos son cuarenta viajes a la base.
   *
   * `skipDuplicates` hace que los que ya existían no rompan el lote: sin eso,
   * una sola persona a la que ya se le avisó cancelaría los otros treinta y
   * nueve.
   */
  async crearVarios(entradas: EntradaDeAviso[]): Promise<number> {
    if (entradas.length === 0) return 0;

    const ahora = new Date();
    const { count } = await this.prisma.notification.createMany({
      data: entradas.map((e) => ({
        id: newId('ntf'),
        userId: e.userId,
        type: e.type,
        title: e.title,
        body: e.body,
        data: this.aTexto(e.data) ?? Prisma.DbNull,
        dedupeKey: e.dedupeKey ?? null,
        nextAttemptAt: ahora,
      })),
      skipDuplicates: true,
    });

    return count;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LEER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * El centro de notificaciones.
   *
   * Paginado por cursor y no por número de página: llegan avisos mientras
   * alguien está leyendo, y con `skip`/`take` cada aviso nuevo empuja la lista
   * y hace que la página 2 repita lo que ya se vio en la 1.
   */
  async listar(userId: string, params: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

    const filas = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      select: NOTIFICACION_SELECT,
    });

    const hayMas = filas.length > limit;
    const items = hayMas ? filas.slice(0, limit) : filas;

    return {
      items,
      nextCursor: hayMas ? (items[items.length - 1]?.id ?? null) : null,
      sinLeer: await this.contarSinLeer(userId),
    };
  }

  /** Para el globito rojo. Consulta propia porque se pide sola, sin la lista. */
  async contarSinLeer(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * Marca una como leída.
   *
   * La pertenencia va en el WHERE, no en un `if`: un id ajeno no actualiza
   * nada y responde lo mismo que uno inexistente.
   */
  async marcarLeida(userId: string, id: string): Promise<{ ok: true }> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async marcarTodasLeidas(userId: string): Promise<{ ok: true; marcadas: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true, marcadas: count };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENVIAR
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Manda los avisos pendientes.
   *
   * Lo llama el barrido periódico. Devuelve el resumen para poder verlo en las
   * métricas y en los tests, que lo invocan a mano en vez de esperar al reloj.
   *
   * ─── Por qué un lote acotado ───
   *
   * Si se acumularon diez mil avisos —porque Firebase estuvo caído toda la
   * noche— mandarlos todos en una corrida agota la cuota y bloquea el proceso.
   * De a cien por vuelta, y el barrido vuelve a pasar enseguida.
   */
  async despachar(lote = 100, ahora = new Date()): Promise<{
    procesados: number;
    enviados: number;
    omitidos: number;
    fallidos: number;
  }> {
    const pendientes = await this.prisma.notification.findMany({
      where: {
        pushStatus: 'PENDING',
        nextAttemptAt: { lte: ahora },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: lote,
      select: {
        id: true,
        userId: true,
        type: true,
        title: true,
        body: true,
        data: true,
        pushAttempts: true,
      },
    });

    let enviados = 0;
    let omitidos = 0;
    let fallidos = 0;

    for (const aviso of pendientes) {
      const resultado = await this.enviarUno(aviso, ahora);
      if (resultado === 'enviado') enviados += 1;
      else if (resultado === 'omitido') omitidos += 1;
      else fallidos += 1;
    }

    return { procesados: pendientes.length, enviados, omitidos, fallidos };
  }

  private async enviarUno(
    aviso: {
      id: string;
      userId: string;
      type: NotificationType;
      title: string;
      body: string;
      data: Prisma.JsonValue;
      pushAttempts: number;
    },
    ahora: Date,
  ): Promise<'enviado' | 'omitido' | 'fallido'> {
    /**
     * Sólo dispositivos vivos.
     *
     * `pushEnabled` es la decisión de la persona; `failureCount` es lo que dice
     * el proveedor. Mandarle a un token que ya falló diez veces gasta cuota
     * para nada, y FCM penaliza a quien insiste con tokens muertos.
     */
    const dispositivos = await this.prisma.device.findMany({
      where: {
        userId: aviso.userId,
        pushEnabled: true,
        pushToken: { not: null },
        failureCount: { lt: 10 },
      },
      select: { id: true, pushToken: true },
    });

    const tokens = dispositivos
      .map((d) => d.pushToken)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);

    // Sin dispositivos, o sin Firebase configurado: no es un fallo. El aviso
    // ya está en el centro de notificaciones, que es donde se ve igual.
    if (tokens.length === 0 || !this.push.disponible) {
      await this.prisma.notification.update({
        where: { id: aviso.id },
        data: { pushStatus: 'SKIPPED', nextAttemptAt: null },
      });
      return 'omitido';
    }

    try {
      const resultado = await this.push.enviar({
        tokens,
        title: aviso.title,
        body: aviso.body,
        data: {
          ...this.deTexto(aviso.data),
          // Siempre presentes: la app los usa para navegar al tocar.
          notificationId: aviso.id,
          type: aviso.type,
        },
      });

      /**
       * Los tokens que el proveedor declaró muertos se borran.
       *
       * Es una app desinstalada o un token reciclado. Guardarlo hace que cada
       * aviso futuro gaste un envío que nunca va a llegar, y que las métricas
       * de entrega mientan hacia abajo para siempre.
       */
      if (resultado.tokensMuertos.length > 0) {
        await this.prisma.device.updateMany({
          where: { pushToken: { in: resultado.tokensMuertos } },
          data: { pushToken: null, failureCount: 0 },
        });
      }

      await this.prisma.notification.update({
        where: { id: aviso.id },
        data: {
          pushStatus: 'SENT',
          pushedAt: ahora,
          pushAttempts: aviso.pushAttempts + 1,
          nextAttemptAt: null,
        },
      });
      return 'enviado';
    } catch (err) {
      const intentos = aviso.pushAttempts + 1;
      const siguiente = proximoIntento(intentos, ahora);

      await this.prisma.notification.update({
        where: { id: aviso.id },
        data: {
          pushAttempts: intentos,
          ...(seAgoto(intentos)
            ? { pushStatus: 'FAILED' as const, nextAttemptAt: null }
            : { nextAttemptAt: siguiente }),
        },
      });

      this.logger.warn({
        msg: 'fallo al enviar un aviso',
        notificationId: aviso.id,
        intentos,
        seRindio: seAgoto(intentos),
        error: err instanceof Error ? err.message : String(err),
      });

      return 'fallido';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUXILIARES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * FCM sólo acepta texto en `data`.
   *
   * Un número mandado tal cual hace que el envío entero falle con un error que
   * no dice cuál de los campos era. Se convierte acá, una vez, en vez de que
   * cada sitio que crea un aviso se acuerde de poner comillas.
   */
  private aTexto(
    data: Record<string, string | number | null | undefined> | undefined,
  ): Prisma.InputJsonValue | undefined {
    if (!data) return undefined;

    const salida: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(data)) {
      if (valor === null || valor === undefined) continue;
      salida[clave] = String(valor);
    }
    return salida;
  }

  /**
   * Lee el `data` guardado y lo devuelve como texto plano.
   *
   * Se descarta lo que no sea un valor simple. `aTexto` ya garantiza que
   * adentro sólo haya cadenas, pero esta fila pudo escribirla una versión
   * anterior del código o una migración: un objeto anidado que llegara acá se
   * convertiría en la cadena `"[object Object]"` y viajaría al teléfono como
   * un destino de navegación inválido.
   */
  private deTexto(data: Prisma.JsonValue): Record<string, string> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

    const salida: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(data)) {
      if (typeof valor === 'string') salida[clave] = valor;
      else if (typeof valor === 'number' || typeof valor === 'boolean') salida[clave] = String(valor);
    }
    return salida;
  }
}
