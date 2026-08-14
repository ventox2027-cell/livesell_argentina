import { Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, Socket as SocketBase } from 'socket.io';
import { z } from 'zod';

import { JwtService } from '@/modules/auth/jwt.service';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { RedisService } from '@/shared/redis/redis.service';
import { newId } from '@/shared/utils/id';

import { EVENTOS, salaDe, type EventoChat } from './live-events';

/**
 * El `Server` de Socket.IO, venga como venga.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `@WebSocketServer()` NO SIEMPRE INYECTA UN SERVER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este gateway declara `namespace: '/live'`, y con un namespace Nest inyecta un
 * **`Namespace`**, no el `Server`. El tipo declarado dice `Server` —Nest no
 * puede saberlo en tiempo de compilación— así que TypeScript no protege nada.
 *
 * La diferencia importa por una sutileza: en `Server`, `adapter` es un
 * **método**; en `Namespace` es una **propiedad**. Llamarlo revienta con:
 *
 *     TypeError: this.server.adapter is not a function
 *
 * Y como el arranque del adaptador está envuelto en un `try`, el error se
 * registraba como "sin adaptador de Redis" y el proceso seguía andando. En una
 * sola instancia no se nota nada. Con dos, un mensaje emitido desde A no le
 * llega a quien está conectado a B: media sala deja de ver el chat y el
 * producto destacado, sin un solo error en los logs.
 *
 * `Server.adapter(...)` en socket.io 4 vuelve a inicializar el adaptador de los
 * namespaces que ya existen, así que llamarlo acá alcanza para `/live`.
 */
export function servidorDe(server: Server): Server {
  const posibleNamespace = server as Server & { server?: Server };
  return typeof server.adapter === 'function' ? server : (posibleNamespace.server ?? server);
}

/**
 * La capa en tiempo real del vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEPARADA DE LIVEKIT A PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LiveKit transporta audio y video. Todo lo demás —chat, producto destacado,
 * stock, estado— pasa por acá.
 *
 * Se podría meter el chat en el canal de datos de LiveKit y ahorrarse una
 * conexión. Sería un error: ese canal existe mientras la sala existe, y una
 * sala de LiveKit se destruye sola cuando queda vacía. El chat, el estado y el
 * producto destacado tienen que sobrevivir a una reconexión del vendedor y
 * seguir funcionando cuando el video se cortó. Atarlos al ciclo de vida del
 * video los rompe justo cuando más se necesitan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO DECIDE NADA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Transporta avisos. El stock lo decide PostgreSQL, las órdenes las decide el
 * módulo de órdenes, y el producto destacado lo decide el servicio del vivo.
 *
 * Un mensaje se puede perder, duplicar o llegar tarde. Si algo de eso pudiera
 * causar una sobreventa, el diseño estaría mal.
 */

/**
 * Lo que se guarda en cada socket.
 *
 * Se tipa en vez de dejar el `any` que socket.io usa por omisión. Acá vive el
 * id del usuario autenticado: un campo mal escrito en un solo lugar
 * —`socket.data.userID` en vez de `userId`— daría `undefined` en silencio y
 * dejaría pasar mensajes sin sesión.
 */
interface DatosDelSocket {
  userId?: string;
  liveSessionId?: string;
  /** Marcas de tiempo de los últimos mensajes, para el límite por usuario. */
  mensajes?: number[];
}

type Socket = SocketBase<
  Record<string, (...args: never[]) => void>,
  Record<string, (...args: never[]) => void>,
  Record<string, (...args: never[]) => void>,
  DatosDelSocket
>;

const MensajeSchema = z.object({
  liveSessionId: z.string().max(64),
  texto: z.string().trim().min(1).max(200),
});

/**
 * ⚠️ CORS abierto para el socket.
 *
 * La app móvil no manda cabecera `Origin`, así que restringir por origen no la
 * protege de nada; y el panel de administración no usa este socket.
 *
 * **Lo que protege es el token**, que se verifica en cada conexión. Un socket
 * sin sesión válida se cierra antes de unirse a ninguna sala.
 */
@WebSocketGateway({
  namespace: '/live',
  cors: { origin: true },
  // Sin polling: la app móvil habla WebSocket nativo, y permitir el respaldo
  // por long-polling agrega una superficie que nadie va a usar.
  transports: ['websocket'],
})
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown {
  private readonly logger = new Logger(LiveGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Conexiones de Redis para el adaptador. Se cierran al apagar. */
  private publicador?: ReturnType<RedisService['client']['duplicate']>;
  private suscriptor?: ReturnType<RedisService['client']['duplicate']>;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * El adaptador de Redis, para que funcione con más de una instancia.
   *
   * Sin él, un mensaje emitido desde la instancia A no llega a los espectadores
   * conectados a la instancia B. Con una sola máquina no se nota; el día que se
   * escale, la mitad de la sala dejaría de ver el chat y el producto destacado
   * sin ningún error visible.
   *
   * Si Redis no está, se sigue igual: en una sola instancia funciona. Es la
   * misma política que el resto del sistema — Redis es precisión, no una
   * dependencia.
   */
  async afterInit(): Promise<void> {
    try {
      this.publicador = this.redis.client.duplicate();
      this.suscriptor = this.redis.client.duplicate();
      await Promise.all([this.publicador.connect(), this.suscriptor.connect()]);

      servidorDe(this.server).adapter(createAdapter(this.publicador, this.suscriptor));
      this.logger.log('adaptador de Redis activo: el realtime funciona con varias instancias');
    } catch (err) {
      this.logger.error({
        msg: '⚠️ sin adaptador de Redis: el realtime SÓLO funciona con una instancia',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Las conexiones del adaptador se cierran ÚLTIMAS.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ `onApplicationShutdown` Y NO `onModuleDestroy`
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Nest apaga en este orden:
   *
   *     onModuleDestroy  →  beforeApplicationShutdown
   *                      →  CIERRA EL SERVIDOR (y con él, Socket.IO)
   *                      →  onApplicationShutdown
   *
   * Al cerrar Socket.IO, el adaptador de Redis hace `unsubscribe` y
   * `punsubscribe` sobre estas dos conexiones. Si acá las cerráramos en
   * `onModuleDestroy`, esos comandos llegarían a un socket ya cerrado y
   * `ioredis` rechazaría con `Error: Connection is closed.`.
   *
   * Nadie las captura —salen de adentro del `close()` del adaptador— así que
   * son **rechazos no manejados**. En los tests eso hacía que Vitest terminara
   * con código 1 con las 818 pruebas en verde, y en producción son
   * excepciones sueltas durante el apagado, justo cuando el proceso está
   * drenando peticiones y una excepción no manejada lo puede matar antes de
   * tiempo.
   *
   * Cerrarlas después del servidor invierte la dependencia: para cuando esto
   * corre, el adaptador ya se dio de baja y no queda nadie que las use.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.publicador?.quit().catch(() => this.publicador?.disconnect());
    await this.suscriptor?.quit().catch(() => this.suscriptor?.disconnect());
  }

  /**
   * Autenticación en la conexión, no en cada mensaje.
   *
   * El token viaja en el handshake. Verificarlo una vez y guardar el usuario en
   * el socket evita verificar una firma por cada mensaje de chat de cada
   * espectador — que en un vivo con mil personas escribiendo es la diferencia
   * entre un HMAC y mil por segundo.
   *
   * El contrapeso: un usuario suspendido durante el vivo conserva su socket
   * hasta que se reconecte. Se acepta porque el daño posible es escribir en un
   * chat, y suspender además revoca sus sesiones, así que no puede volver.
   */
  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        socket.handshake.headers.authorization?.replace(/^Bearer /, '');

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const payload = await this.jwt.verifyAccessToken(token);
      socket.data.userId = payload.sub;
    } catch {
      // Sin detalle: un mensaje distinto según el motivo le diría a quien
      // prueba si el token existía y venció o si nunca fue válido.
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    const sesion = socket.data.liveSessionId;
    if (sesion) void this.emitirEspectadores(sesion);
  }

  /**
   * Unirse a un vivo.
   *
   * Se comprueba que la sesión exista y esté en un estado que admita
   * espectadores. Sin eso, cualquiera podría unirse a `live:loQueSea` y recibir
   * los eventos de una sala que no existe — o peor, quedarse escuchando la de
   * un vivo que todavía no arrancó.
   */
  @SubscribeMessage('join')
  async unirse(
    @ConnectedSocket() socket: Socket,
    @MessageBody() cuerpo: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const datos = z.object({ liveSessionId: z.string().max(64) }).safeParse(cuerpo);
    if (!datos.success) return { ok: false, error: 'petición inválida' };

    const sesion = await this.prisma.liveSession.findUnique({
      where: { id: datos.data.liveSessionId },
      select: { id: true, state: true },
    });

    if (!sesion || sesion.state === 'SCHEDULED') {
      return { ok: false, error: 'ese vivo no está disponible' };
    }

    // Se sale de la sala anterior: deslizar al vivo siguiente no puede dejar a
    // alguien recibiendo el chat de los dos.
    const anterior = socket.data.liveSessionId;
    if (anterior) {
      await socket.leave(salaDe(anterior));
      void this.emitirEspectadores(anterior);
    }

    await socket.join(salaDe(sesion.id));
    socket.data.liveSessionId = sesion.id;

    void this.emitirEspectadores(sesion.id);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async salir(@ConnectedSocket() socket: Socket): Promise<{ ok: boolean }> {
    const sesion = socket.data.liveSessionId;
    if (sesion) {
      await socket.leave(salaDe(sesion));
      socket.data.liveSessionId = undefined;
      void this.emitirEspectadores(sesion);
    }
    return { ok: true };
  }

  /**
   * Un mensaje de chat.
   *
   * ⚠️ **No se persiste.** El chat de un vivo es efímero por diseño: guardar
   * cada mensaje de cada vivo es una tabla que crece sin techo, con contenido
   * generado por usuarios que después habría que moderar, y que nadie va a
   * leer. Si más adelante hace falta —para moderación o para reclamos— se
   * agrega con retención acotada y sabiendo para qué.
   *
   * Se emite a la sala y se descarta.
   */
  @SubscribeMessage('chat')
  async chatear(
    @ConnectedSocket() socket: Socket,
    @MessageBody() cuerpo: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const datos = MensajeSchema.safeParse(cuerpo);
    if (!datos.success) return { ok: false, error: 'mensaje inválido' };

    const userId = socket.data.userId;
    if (!userId) return { ok: false, error: 'sin sesión' };

    // Sólo se puede escribir en la sala en la que uno está. Sin esto, alguien
    // podría mandar mensajes a cualquier vivo sin estar mirándolo.
    if (socket.data.liveSessionId !== datos.data.liveSessionId) {
      return { ok: false, error: 'no estás en ese vivo' };
    }

    /**
     * Límite por usuario, en memoria del proceso.
     *
     * Es aceptable acá y no lo sería en HTTP: el socket está atado a este
     * proceso, así que su contador también. Alguien que quiera evadirlo tendría
     * que reconectarse, y reconectarse tiene su propio costo.
     */
    const ahora = Date.now();
    const ultimos = socket.data.mensajes ?? [];
    const recientes = ultimos.filter((t) => ahora - t < 10_000);
    if (recientes.length >= 5) return { ok: false, error: 'esperá un momento' };
    socket.data.mensajes = [...recientes, ahora];

    const [usuario, sesion] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, status: true },
      }),
      this.prisma.liveSession.findUnique({
        where: { id: datos.data.liveSessionId },
        select: { state: true, seller: { select: { userId: true } } },
      }),
    ]);

    if (!usuario || usuario.status !== 'active') return { ok: false, error: 'sin permiso' };
    if (!sesion || sesion.state === 'ENDED' || sesion.state === 'FAILED') {
      return { ok: false, error: 'el vivo terminó' };
    }

    const evento: EventoChat = {
      id: newId('msg'),
      userId,
      /**
       * Nombre y la inicial del apellido. El nombre completo de un comprador no
       * tiene por qué quedar visible para toda la sala, y "Juan P." alcanza
       * para que la conversación se entienda.
       */
      nombre: `${usuario.firstName} ${usuario.lastName.charAt(0)}.`.trim(),
      texto: datos.data.texto,
      esVendedor: sesion.seller.userId === userId,
      fecha: new Date().toISOString(),
    };

    this.server.to(salaDe(datos.data.liveSessionId)).emit(EVENTOS.chat, evento);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Emisión desde el dominio
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emite un evento a la sala de un vivo.
   *
   * **Nunca lanza.** Lo llama el servicio del vivo justo después de cometer un
   * cambio en la base. Si avisar fallara y eso propagara, el cambio ya estaría
   * hecho y la operación devolvería un error: el vendedor vería "no se pudo
   * destacar el producto" cuando sí se destacó.
   */
  emitir(liveSessionId: string, evento: string, cuerpo: unknown): void {
    try {
      this.server?.to(salaDe(liveSessionId)).emit(evento, cuerpo);
    } catch (err) {
      this.logger.error({
        msg: 'no se pudo emitir un evento del vivo',
        liveSessionId,
        evento,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cuánta gente está mirando.
   *
   * Con el adaptador de Redis, `fetchSockets` consulta todas las instancias.
   * Es una cuenta aproximada —alguien que se está reconectando puede contarse
   * dos veces por un instante— y está bien que lo sea: es un número para el
   * vendedor, no una métrica de facturación.
   */
  private async emitirEspectadores(liveSessionId: string): Promise<void> {
    try {
      const cantidad = await this.contarEspectadores(liveSessionId);

      this.emitir(liveSessionId, EVENTOS.espectadores, {
        cantidad,
        fecha: new Date().toISOString(),
      });

      /**
       * El pico se PERSISTE acá, no se calcula al cerrar.
       *
       * `peakViewers` existía en el esquema, el resumen final lo leía... y nadie
       * lo escribía nunca. Todos los vivos terminaban informando
       * `espectadoresPico: null`.
       *
       * Al cerrar ya no se puede saber: los sockets se fueron. O se anota
       * mientras pasa, o el dato no existe — y la regla es no inventar métricas.
       *
       * El `updateMany` con la condición adentro evita leer-decidir-escribir:
       * dos instancias emitiendo a la vez no pueden bajarse el pico entre sí.
       */
      await this.prisma.liveSession.updateMany({
        where: { id: liveSessionId, OR: [{ peakViewers: null }, { peakViewers: { lt: cantidad } }] },
        data: { peakViewers: cantidad },
      });
    } catch {
      // Un contador que no se pudo calcular no puede romper nada.
    }
  }

  /**
   * Cuánta gente está mirando, para quien pregunte desde fuera del socket.
   *
   * Lo usa el panel del vendedor. Con el adaptador de Redis la cuenta abarca
   * todas las instancias.
   */
  async contarEspectadores(liveSessionId: string): Promise<number> {
    try {
      const sockets = await this.server.in(salaDe(liveSessionId)).fetchSockets();
      return sockets.length;
    } catch {
      // Sin dato es cero y no una excepción: el panel tiene que abrir igual.
      return 0;
    }
  }
}
