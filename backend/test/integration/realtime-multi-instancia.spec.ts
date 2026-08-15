import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { io, type Socket as ClienteSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
import type { ChatModeracionService as TipoModeracion } from '@/modules/live/chat-moderacion.service';
import type { LiveGateway } from '@/modules/live/live.gateway';
import type { PrismaService } from '@/shared/prisma/prisma.service';

import { EVENTOS } from '@/modules/live/live-events';

import { crearAppDePrueba } from '../helpers/app';
import { datosDeAdulto } from '../helpers/edad';

/**
 * El realtime con MÁS DE UNA INSTANCIA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL FALLO QUE ESTE ARCHIVO EXISTE PARA IMPEDIR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El gateway declara `namespace: '/live'`. Con un namespace, Nest inyecta un
 * `Namespace` en `@WebSocketServer()`, no un `Server`. En `Server`, `adapter`
 * es un **método**; en `Namespace` es una **propiedad**. Llamarlo tiraba
 * `TypeError: this.server.adapter is not a function`.
 *
 * Y como el arranque del adaptador está envuelto en un `try` —Redis es
 * precisión, no una dependencia— el error se registraba como "sin adaptador" y
 * el proceso seguía andando.
 *
 * **Con una sola instancia no se nota absolutamente nada.** Todos los tests
 * pasaban. El día que haya dos máquinas, un mensaje emitido desde A no le llega
 * a quien está conectado a B: media sala se queda sin chat y sin producto
 * destacado, y no hay ni un error en los logs.
 *
 * Ese es exactamente el tipo de bug que no se encuentra probando: hay que
 * montar las dos instancias. Es lo que hace este archivo.
 *
 * ─── Cómo funciona ───
 *
 * Dos aplicaciones Nest completas, en dos puertos, contra el MISMO Redis y la
 * MISMA base. Un cliente en cada una. Se emite por la primera y se verifica que
 * llegue a la segunda.
 *
 * ⚠️ Es más lento que el resto de la suite —dos arranques y sockets reales— y
 * está bien: es la única forma de probar lo que prueba.
 */

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@localhost:5433/livesell_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380/1',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  JWT_SECRET: 'clave-de-firma-solo-para-tests-no-usar-en-ningun-otro-lado-0123456789',
  AUTH_DEV_LOGIN_ENABLED: 'true',
  LOG_LEVEL: 'error',
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',
  INVENTORY_RECONCILER_ENABLED: 'false',
  INVENTORY_EXPIRATION_QUEUE_ENABLED: 'false',
  ORDERS_RECONCILER_ENABLED: 'false',
};

/** Una instancia completa, escuchando en un puerto de verdad. */
interface Instancia {
  app: INestApplication;
  puerto: number;
  gateway: LiveGateway;
  moderacion: TipoModeracion;
}

let a: Instancia;
let b: Instancia;
let prisma: PrismaService;
let jwt: JwtService;

/** Los sockets abiertos, para cerrarlos pase lo que pase. */
const abiertos: ClienteSocket[] = [];

async function levantar(puerto: number): Promise<Instancia> {
  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { LiveGateway } = await import('@/modules/live/live.gateway');
  const { ChatModeracionService } = await import('@/modules/live/chat-moderacion.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({
      wsUrl: 'wss://test.livekit.cloud',
      ensureRoom: vi.fn().mockResolvedValue(undefined),
      deleteRoom: vi.fn().mockResolvedValue(undefined),
      listParticipants: vi.fn().mockResolvedValue([]),
      verifyWebhook: vi.fn(),
      issueToken: vi.fn().mockResolvedValue({ token: 't', wsUrl: '', roomName: 'r' }),
    })
    .compile();

  const app = await crearAppDePrueba(moduleRef);
  // A diferencia del resto de la suite, acá hace falta escuchar de verdad: los
  // clientes de Socket.IO abren un WebSocket, y `inject()` no sirve para eso.
  await app.listen(puerto, '127.0.0.1');

  return {
    app,
    puerto,
    gateway: app.get(LiveGateway),
    moderacion: app.get(ChatModeracionService),
  };
}

/** Un cliente conectado al namespace del vivo, ya autenticado. */
async function conectar(puerto: number, token: string): Promise<ClienteSocket> {
  const socket = io(`http://127.0.0.1:${puerto}/live`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  abiertos.push(socket);

  await new Promise<void>((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error('no conectó en 5 s')), 5000);
    socket.once('connect', () => {
      clearTimeout(reloj);
      resolver();
    });
    socket.once('connect_error', (e) => {
      clearTimeout(reloj);
      rechazar(e);
    });
  });

  return socket;
}

/** Espera un evento con tope de tiempo. Sin esto, un fallo cuelga la suite. */
function esperarEvento<T>(socket: ClienteSocket, nombre: string, ms = 4000): Promise<T> {
  return new Promise<T>((resolver, rechazar) => {
    const reloj = setTimeout(
      () => rechazar(new Error(`no llegó "${nombre}" en ${ms} ms`)),
      ms,
    );
    socket.once(nombre, (cuerpo: T) => {
      clearTimeout(reloj);
      resolver(cuerpo);
    });
  });
}

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { JwtService } = await import('@/modules/auth/jwt.service');

  a = await levantar(3711);
  b = await levantar(3712);

  prisma = a.app.get(PrismaService);
  jwt = a.app.get(JwtService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Sólo corre contra una base *_test');
  }
}, 60_000);

afterAll(async () => {
  for (const s of abiertos) s.disconnect();
  await a?.app.close();
  await b?.app.close();
});

/**
 * Un sufijo único POR CORRIDA.
 *
 * Los ids eran deterministas —un prefijo más un contador— y la base de tests
 * no se trunca entre corridas: la segunda vez que se corría el archivo, los
 * `user.create` chocaban contra las filas de la vez anterior.
 */
const CORRIDA = Date.now().toString(36).slice(-6);
let n = 0;

const idDe = (prefijo: string): string =>
  `${prefijo}_${CORRIDA}${String(n).padStart(20 - prefijo.length, '0')}`;

/** Un usuario con sesión, directo en la base: acá no se prueba el registro. */
async function nuevoUsuario(): Promise<{ token: string; userId: string }> {
  n += 1;
  const userId = idDe('usr');
  await prisma.user.create({
    data: {
      id: userId,
      firstName: 'Espectador',
      lastName: `${n}`,
      email: `rt-${n}-${Date.now()}@test.com`,
      emailVerified: true,
      role: 'buyer',
      ...datosDeAdulto(),
    },
  });

  const { accessToken } = await jwt.issueAccessToken({
    userId,
    role: 'buyer',
    sessionId: idDe('ses'),
  });
  return { token: accessToken, userId };
}

/** Un vivo al aire, sin pasar por LiveKit. */
async function vivoAlAire(): Promise<string> {
  n += 1;
  const usuario = await nuevoUsuario();

  const seller = await prisma.seller.create({
    data: {
      id: idDe('sel'),
      userId: usuario.userId,
      displayName: `Vendedor rt ${n}`,
      slug: `vendedor-rt-${n}-${Date.now()}`,
    },
  });
  const store = await prisma.store.create({
    data: {
      id: idDe('sto'),
      sellerId: seller.id,
      name: `Tienda rt ${n}`,
      slug: `tienda-rt-${n}-${Date.now()}`,
      isPrimary: true,
    },
  });
  const sesion = await prisma.liveSession.create({
    data: {
      id: idDe('liv'),
      sellerId: seller.id,
      storeId: store.id,
      title: `Vivo rt ${n}`,
      state: 'LIVE',
      // Único por corrida, igual que los ids: `room_name` tiene índice único.
      roomName: `room-rt-${CORRIDA}-${n}`,
    },
  });
  return sesion.id;
}

describe('El adaptador de Redis está realmente puesto', () => {
  it('las dos instancias lo reportan activo', () => {
    /**
     * Es la comprobación barata, y la que habría encontrado el bug original en
     * un segundo: el gateway ahora recuerda si el adaptador arrancó.
     */
    expect(a.gateway.adaptadorDeRedisActivo, 'instancia A').toBe(true);
    expect(b.gateway.adaptadorDeRedisActivo, 'instancia B').toBe(true);
  });

  it('y `/ready` lo dice, para que el monitoreo lo vea', async () => {
    const res = await (a.app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/ready' });

    const cuerpo = JSON.parse(res.body) as {
      checks: { realtime: { status: string } };
    };
    expect(cuerpo.checks.realtime.status).toBe('ok');
  });
});

describe('Un evento emitido en A llega a B', () => {
  it('el chat cruza entre instancias', async () => {
    /**
     * El caso que rompía. Quien escribe está en la instancia A, quien mira está
     * en la B, y sin adaptador el mensaje se queda en A.
     */
    const liveId = await vivoAlAire();
    const escribe = await nuevoUsuario();
    const mira = await nuevoUsuario();

    const enA = await conectar(a.puerto, escribe.token);
    const enB = await conectar(b.puerto, mira.token);

    for (const s of [enA, enB]) {
      const r = await s.emitWithAck('join', { liveSessionId: liveId });
      expect(r).toEqual({ ok: true });
    }

    const llegada = esperarEvento<{ texto: string; nombre: string }>(enB, EVENTOS.chat);
    const enviado = await enA.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'hola desde la otra instancia',
    });
    expect(enviado).toEqual({ ok: true });

    const evento = await llegada;
    expect(evento.texto).toBe('hola desde la otra instancia');
  }, 20_000);

  it('el producto destacado cruza entre instancias', async () => {
    /**
     * El chat molesta cuando falla; el producto destacado hace perder ventas:
     * media sala ve un producto que el vendedor ya dejó de mostrar, y compra
     * otra cosa.
     *
     * Se emite por el mismo camino que usa el dominio —`gateway.emitir`— y no
     * por el socket, porque así es como sale de verdad: lo dispara el servicio
     * después de guardar en la base.
     */
    const liveId = await vivoAlAire();
    const mira = await nuevoUsuario();

    const enB = await conectar(b.puerto, mira.token);
    expect(await enB.emitWithAck('join', { liveSessionId: liveId })).toEqual({ ok: true });

    const llegada = esperarEvento<{ variantId: string }>(enB, EVENTOS.productoDestacado);
    a.gateway.emitir(liveId, EVENTOS.productoDestacado, { variantId: 'var_123' });

    expect((await llegada).variantId).toBe('var_123');
  }, 20_000);

  it('⛔ un evento de OTRO vivo no llega', async () => {
    /**
     * El adaptador reparte por sala. Si repartiera por instancia, alguien
     * mirando un vivo recibiría el chat de todos los demás — que es una fuga de
     * conversaciones ajenas, no sólo un bug de rendimiento.
     */
    const unVivo = await vivoAlAire();
    const otroVivo = await vivoAlAire();
    const escribe = await nuevoUsuario();
    const mira = await nuevoUsuario();

    const enA = await conectar(a.puerto, escribe.token);
    const enB = await conectar(b.puerto, mira.token);

    await enA.emitWithAck('join', { liveSessionId: unVivo });
    await enB.emitWithAck('join', { liveSessionId: otroVivo });

    let recibido = false;
    enB.once(EVENTOS.chat, () => {
      recibido = true;
    });

    await enA.emitWithAck('chat', { liveSessionId: unVivo, texto: 'no me tenés que ver' });
    // Se espera de más a propósito: un "no llegó" tiene que ser porque no llega,
    // no porque se preguntó antes de tiempo.
    await new Promise((r) => setTimeout(r, 1500));

    expect(recibido).toBe(false);
  }, 20_000);
});

describe('El bloqueo corta el chat en los dos sentidos', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * EL BLOQUEO SE DECLARA EN UN SENTIDO Y SILENCIA EN LOS DOS
   * ═══════════════════════════════════════════════════════════════════════
   *
   * De nada le sirve a alguien no leer a quien lo molesta si esa persona puede
   * seguir escribiéndole en cada vivo. Y al revés: si un vendedor bloqueó a
   * alguien que lo acosaba, esa persona no puede seguir apareciendo en su chat.
   *
   * Es la única parte del bloqueo que es simétrica, y es deliberado.
   */

  /** El vendedor de un vivo al aire, y su userId. */
  async function vivoConVendedor() {
    const liveId = await vivoAlAire();
    const sesion = await prisma.liveSession.findUniqueOrThrow({
      where: { id: liveId },
      select: { seller: { select: { userId: true } } },
    });
    return { liveId, vendedorUserId: sesion.seller.userId };
  }

  it('⛔ quien bloqueó al vendedor no puede escribir en su vivo', async () => {
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    await prisma.userBlock.create({
      data: {
        id: `blk_a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        blockerId: espectador.userId,
        blockedId: vendedorUserId,
      },
    });

    const socket = await conectar(a.puerto, espectador.token);
    expect(await socket.emitWithAck('join', { liveSessionId: liveId })).toEqual({ ok: true });

    const r = (await socket.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'hola',
    })) as { ok: boolean; error?: string };

    expect(r.ok).toBe(false);
    /**
     * El mensaje es vago a propósito: "no podés escribir en este vivo" y no
     * "bloqueaste a esta persona". Del otro lado, quien es bloqueado tampoco
     * tiene que enterarse, y usar dos textos distintos según el sentido sería
     * exactamente la señal que no queremos dar.
     */
    expect(r.error).toContain('No podés escribir');
  }, 20_000);

  it('⛔ y el vendedor que bloqueó tampoco recibe a esa persona', async () => {
    // El otro sentido. El bloqueo se declaró al revés que en el test anterior.
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    await prisma.userBlock.create({
      data: {
        id: `blk_b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        blockerId: vendedorUserId,
        blockedId: espectador.userId,
      },
    });

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });

    const r = (await socket.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'hola de nuevo',
    })) as { ok: boolean };

    expect(r.ok).toBe(false);
  }, 20_000);

  it('sin bloqueo, el chat funciona igual que siempre', async () => {
    /**
     * La contracara. Sin esto, "arreglar" el bloqueo cortando el chat de todos
     * pasaría en verde.
     */
    const { liveId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });

    const r = (await socket.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'mensaje normal',
    })) as { ok: boolean };

    expect(r.ok).toBe(true);
  }, 20_000);

  it('⛔ bloquear a un espectador NO afecta al resto de la sala', async () => {
    /**
     * El bloqueo es entre dos personas. Si cortara el chat de la sala entera,
     * bloquear a alguien sería una forma de arruinarle el vivo al vendedor.
     */
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const bloqueado = await nuevoUsuario();
    const otro = await nuevoUsuario();

    await prisma.userBlock.create({
      data: {
        id: `blk_c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        blockerId: vendedorUserId,
        blockedId: bloqueado.userId,
      },
    });

    const socketOtro = await conectar(b.puerto, otro.token);
    await socketOtro.emitWithAck('join', { liveSessionId: liveId });

    const r = (await socketOtro.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'yo no tengo nada que ver',
    })) as { ok: boolean };

    expect(r.ok).toBe(true);
  }, 20_000);
});

describe('Moderación del chat', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ANTES DE ESTO NO SE PODÍA MODERAR NADA
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Los mensajes vivían en el socket y se perdían al terminar el vivo. El
   * backend aceptaba reportes de tipo `CHAT_MESSAGE`, pero como el mensaje no
   * existía en ningún lado, quien moderaba sólo tenía la versión de quien
   * reportaba.
   */

  async function vivoConVendedor() {
    const liveId = await vivoAlAire();
    const sesion = await prisma.liveSession.findUniqueOrThrow({
      where: { id: liveId },
      select: { seller: { select: { userId: true } } },
    });
    return { liveId, vendedorUserId: sesion.seller.userId };
  }

  /** El token del vendedor de un vivo, para llamar a la API. */
  async function tokenDe(userId: string) {
    const { accessToken } = await jwt.issueAccessToken({
      userId,
      role: 'seller',
      sessionId: `ses_mod${Date.now().toString(36)}`,
    });
    return accessToken;
  }

  function http(metodo: string, url: string, opts: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    return (a.app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .inject({ method: metodo as never, url, headers, payload: opts.body as never })
      .then((r) => ({
        status: r.statusCode,
        body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : null,
      }));
  }

  // ─── Se guarda ───────────────────────────────────────────────────────────

  it('un mensaje enviado queda guardado', async () => {
    const { liveId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });
    expect(await socket.emitWithAck('chat', { liveSessionId: liveId, texto: 'hola gente' }))
      .toEqual({ ok: true });

    // Se guarda sin esperar, así que se le da un instante.
    await new Promise((r) => setTimeout(r, 500));

    const guardados = await prisma.liveChatMessage.findMany({
      where: { liveSessionId: liveId },
    });
    expect(guardados).toHaveLength(1);
    expect(guardados[0]!.text).toBe('hola gente');
    expect(guardados[0]!.blockedByFilter).toBeNull();
  }, 20_000);

  // ─── El filtro ───────────────────────────────────────────────────────────

  it('⛔ un teléfono no se publica, pero SÍ se guarda', async () => {
    /**
     * Guardar lo frenado es lo que permite saber si el filtro se está pasando
     * de estricto y silenciando gente que no hizo nada.
     */
    const { liveId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });

    const r = (await socket.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'llamame al 11 2345 6789',
    })) as { ok: boolean; error?: string };

    expect(r.ok).toBe(false);
    // Y le dice POR QUÉ, para que pueda reescribirlo.
    expect(r.error).toContain('datos de contacto');

    await new Promise((res) => setTimeout(res, 500));
    const guardado = await prisma.liveChatMessage.findFirst({
      where: { liveSessionId: liveId },
    });
    expect(guardado?.blockedByFilter).toBe('CONTACTO');
  }, 20_000);

  it('⛔ el mensaje frenado NO le llega a la sala', async () => {
    // Lo importante: guardar no es publicar.
    const { liveId } = await vivoConVendedor();
    const escribe = await nuevoUsuario();
    const mira = await nuevoUsuario();

    const enA = await conectar(a.puerto, escribe.token);
    const enB = await conectar(b.puerto, mira.token);
    await enA.emitWithAck('join', { liveSessionId: liveId });
    await enB.emitWithAck('join', { liveSessionId: liveId });

    let recibido = false;
    enB.once(EVENTOS.chat, () => {
      recibido = true;
    });

    await enA.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'escribime a juan@gmail.com',
    });
    await new Promise((r) => setTimeout(r, 1200));

    expect(recibido).toBe(false);
  }, 20_000);

  it('un mensaje normal sí se publica', async () => {
    // La contracara: sin esto, "arreglar" el filtro frenando todo pasa en verde.
    const { liveId } = await vivoConVendedor();
    const escribe = await nuevoUsuario();
    const mira = await nuevoUsuario();

    const enA = await conectar(a.puerto, escribe.token);
    const enB = await conectar(b.puerto, mira.token);
    await enA.emitWithAck('join', { liveSessionId: liveId });
    await enB.emitWithAck('join', { liveSessionId: liveId });

    const llegada = esperarEvento<{ texto: string }>(enB, EVENTOS.chat);
    await enA.emitWithAck('chat', { liveSessionId: liveId, texto: 'cuanto sale 45000?' });

    expect((await llegada).texto).toBe('cuanto sale 45000?');
  }, 20_000);

  // ─── Silenciar ───────────────────────────────────────────────────────────

  it('el vendedor puede callar a alguien en su vivo', async () => {
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const molesto = await nuevoUsuario();
    const token = await tokenDe(vendedorUserId);

    const socket = await conectar(a.puerto, molesto.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });
    // Antes de callarlo, escribe bien.
    expect(await socket.emitWithAck('chat', { liveSessionId: liveId, texto: 'hola' }))
      .toEqual({ ok: true });

    const mute = await http('POST', `/api/v1/live/${liveId}/chat/mutes`, {
      token,
      body: { userId: molesto.userId, reason: 'insultaba a otros compradores', minutos: 30 },
    });
    expect(mute.status, JSON.stringify(mute.body)).toBe(201);

    const despues = (await socket.emitWithAck('chat', {
      liveSessionId: liveId,
      texto: 'y ahora?',
    })) as { ok: boolean; error?: string };

    expect(despues.ok).toBe(false);
    /**
     * El mensaje es vago a propósito: "no podés escribir" y no "te silenció el
     * vendedor". Decirle contra quién pelear le da algo que hacer; lo que se
     * busca es que se aburra.
     */
    expect(despues.error).toContain('No podés escribir');
  }, 25_000);

  it('y puede devolverle la voz', async () => {
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const molesto = await nuevoUsuario();
    const token = await tokenDe(vendedorUserId);

    const socket = await conectar(a.puerto, molesto.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });

    await http('POST', `/api/v1/live/${liveId}/chat/mutes`, {
      token,
      body: { userId: molesto.userId, reason: 'un malentendido', minutos: 30 },
    });
    await http('DELETE', `/api/v1/live/${liveId}/chat/mutes/${molesto.userId}`, { token });

    expect(await socket.emitWithAck('chat', { liveSessionId: liveId, texto: 'gracias' }))
      .toEqual({ ok: true });
  }, 25_000);

  it('⛔ el silencio del vendedor NO puede pasar de 24 horas', async () => {
    /**
     * Un silencio permanente es una expulsión de la plataforma, y esa la decide
     * VendoX. Lo que el vendedor puede hacer es callar a alguien durante su
     * vivo.
     */
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const molesto = await nuevoUsuario();
    const token = await tokenDe(vendedorUserId);

    const r = await http('POST', `/api/v1/live/${liveId}/chat/mutes`, {
      token,
      body: { userId: molesto.userId, reason: 'para siempre', minutos: 60 * 24 * 365 },
    });

    // El DTO lo rechaza antes de llegar al servicio.
    expect(r.status).toBe(400);
  }, 20_000);

  it('⛔ el motivo es obligatorio', async () => {
    // Un silencio sin motivo no se puede revisar ni defender.
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const molesto = await nuevoUsuario();
    const token = await tokenDe(vendedorUserId);

    const r = await http('POST', `/api/v1/live/${liveId}/chat/mutes`, {
      token,
      body: { userId: molesto.userId, minutos: 15 },
    });
    expect(r.status).toBe(400);
  }, 20_000);

  it('⛔ un vendedor NO puede moderar el vivo de otro', async () => {
    const propio = await vivoConVendedor();
    const ajeno = await vivoConVendedor();
    const molesto = await nuevoUsuario();
    const token = await tokenDe(propio.vendedorUserId);

    const r = await http('POST', `/api/v1/live/${ajeno.liveId}/chat/mutes`, {
      token,
      body: { userId: molesto.userId, reason: 'no es mi vivo', minutos: 15 },
    });

    // 404 y no 403: confirmar que el vivo existe le diría que acertó un id.
    expect(r.status).toBe(404);
  }, 20_000);

  // ─── Borrar ──────────────────────────────────────────────────────────────

  it('el vendedor puede borrar un mensaje, y queda la evidencia', async () => {
    /**
     * Borrado lógico. Un mensaje eliminado es la evidencia de por qué se
     * sancionó a alguien: borrarlo de verdad deja la sanción sin respaldo.
     */
    const { liveId, vendedorUserId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();
    const token = await tokenDe(vendedorUserId);

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });
    await socket.emitWithAck('chat', { liveSessionId: liveId, texto: 'algo feo' });
    await new Promise((r) => setTimeout(r, 500));

    const mensaje = await prisma.liveChatMessage.findFirstOrThrow({
      where: { liveSessionId: liveId },
    });

    const r = await http('DELETE', `/api/v1/live/${liveId}/chat/messages/${mensaje.id}`, {
      token,
    });
    expect(r.status).toBe(200);

    const despues = await prisma.liveChatMessage.findUniqueOrThrow({
      where: { id: mensaje.id },
    });
    // Sigue existiendo, con la marca y con quién lo borró.
    expect(despues.deletedAt).not.toBeNull();
    expect(despues.deletedByUserId).toBe(vendedorUserId);
    expect(despues.text).toBe('algo feo');
  }, 25_000);

  it('⛔ nadie puede borrar un mensaje de un vivo ajeno', async () => {
    const { liveId } = await vivoConVendedor();
    const otro = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    const socket = await conectar(a.puerto, espectador.token);
    await socket.emitWithAck('join', { liveSessionId: liveId });
    await socket.emitWithAck('chat', { liveSessionId: liveId, texto: 'un mensaje' });
    await new Promise((r) => setTimeout(r, 500));

    const mensaje = await prisma.liveChatMessage.findFirstOrThrow({
      where: { liveSessionId: liveId },
    });

    const r = await http('DELETE', `/api/v1/live/${liveId}/chat/messages/${mensaje.id}`, {
      token: await tokenDe(otro.vendedorUserId),
    });

    expect(r.status).toBe(404);
    const sigue = await prisma.liveChatMessage.findUniqueOrThrow({ where: { id: mensaje.id } });
    expect(sigue.deletedAt).toBeNull();
  }, 25_000);

  // ─── Retención ───────────────────────────────────────────────────────────

  it('los mensajes viejos se borran, los nuevos no', async () => {
    /**
     * Treinta días. Es el tiempo en que un reporte se abre, se revisa y se
     * resuelve; más allá de eso, el chat de un vivo no le sirve a nadie y es
     * una base de conversaciones privadas creciendo sin límite.
     */
    const { liveId } = await vivoConVendedor();
    const espectador = await nuevoUsuario();

    const viejo = await prisma.liveChatMessage.create({
      data: {
        id: `msg_v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        liveSessionId: liveId,
        userId: espectador.userId,
        text: 'de hace dos meses',
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
      },
    });
    const nuevo = await prisma.liveChatMessage.create({
      data: {
        id: `msg_n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        liveSessionId: liveId,
        userId: espectador.userId,
        text: 'de recien',
      },
    });

    await a.moderacion.borrarLosViejos();

    expect(await prisma.liveChatMessage.count({ where: { id: viejo.id } })).toBe(0);
    expect(await prisma.liveChatMessage.count({ where: { id: nuevo.id } })).toBe(1);
  }, 20_000);
});
