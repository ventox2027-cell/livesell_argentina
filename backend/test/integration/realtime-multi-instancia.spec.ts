import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { io, type Socket as ClienteSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { JwtService } from '@/modules/auth/jwt.service';
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

  return { app, puerto, gateway: app.get(LiveGateway) };
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

let n = 0;

/** Un usuario con sesión, directo en la base: acá no se prueba el registro. */
async function nuevoUsuario(): Promise<{ token: string; userId: string }> {
  n += 1;
  const userId = `usr_rt${String(n).padStart(22, '0')}`;
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
    sessionId: `ses_rt${String(n).padStart(21, '0')}`,
  });
  return { token: accessToken, userId };
}

/** Un vivo al aire, sin pasar por LiveKit. */
async function vivoAlAire(): Promise<string> {
  n += 1;
  const usuario = await nuevoUsuario();

  const seller = await prisma.seller.create({
    data: {
      id: `sel_rt${String(n).padStart(21, '0')}`,
      userId: usuario.userId,
      displayName: `Vendedor rt ${n}`,
      slug: `vendedor-rt-${n}-${Date.now()}`,
    },
  });
  const store = await prisma.store.create({
    data: {
      id: `sto_rt${String(n).padStart(21, '0')}`,
      sellerId: seller.id,
      name: `Tienda rt ${n}`,
      slug: `tienda-rt-${n}-${Date.now()}`,
      isPrimary: true,
    },
  });
  const sesion = await prisma.liveSession.create({
    data: {
      id: `liv_rt${String(n).padStart(21, '0')}`,
      sellerId: seller.id,
      storeId: store.id,
      title: `Vivo rt ${n}`,
      state: 'LIVE',
      roomName: `room-rt-${n}`,
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
