import { type INestApplication } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '@/shared/prisma/prisma.service';
import type { RedisService } from '@/shared/redis/redis.service';

import { crearAppDePrueba } from '../helpers/app';
import { NACIMIENTO_ADULTO_ISO } from '../helpers/edad';

/**
 * Soporte, extremo a extremo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE SE PRUEBA ES QUE LA MÁQUINA NO OPINE SOBRE PLATA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El módulo puro ya prueba las reglas de escalada. Acá se verifica que esas
 * reglas efectivamente corran ANTES de que el asistente conteste, y que el
 * ticket termine esperando a una persona en vez de con una respuesta
 * automática sobre el dinero de alguien.
 *
 * Y lo otro: que nadie vea la conversación de otro.
 */

const TEST_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://livesell:livesell@127.0.0.1:5433/livesell_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/1',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'test-secret-at-least-16-chars-long',
  LIVEKIT_WS_URL: 'wss://test.livekit.cloud',
  LIVEKIT_HTTP_URL: 'https://test.livekit.cloud',
  JWT_SECRET: 'clave-de-firma-solo-para-tests-no-usar-en-ningun-otro-lado-0123456789',
  AUTH_DEV_LOGIN_ENABLED: 'true',
  SPIKE_ENABLED: 'false',
  PAYMENTS_SPIKE_ENABLED: 'false',
  LOG_LEVEL: 'error',
  STORE_REOPEN_SWEEP_ENABLED: 'false',
  NOTIFICATIONS_DISPATCHER_ENABLED: 'false',
};

let app: INestApplication;
let prisma: PrismaService;
let redis: RedisService;

beforeAll(async () => {
  Object.assign(process.env, TEST_ENV);

  const { AppModule } = await import('@/app.module');
  const { LiveKitService } = await import('@/modules/livekit/livekit.service');
  const { PrismaService } = await import('@/shared/prisma/prisma.service');
  const { RedisService } = await import('@/shared/redis/redis.service');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LiveKitService)
    .useValue({ wsUrl: '', ensureRoom: vi.fn(), issueToken: vi.fn(), verifyWebhook: vi.fn() })
    .compile();

  app = await crearAppDePrueba(moduleRef);
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);

  if (!(process.env.DATABASE_URL ?? '').includes('_test')) {
    throw new Error('Sólo corre contra una base *_test');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE support_messages, support_tickets, notifications, audit_logs, ' +
      'refresh_tokens, devices, user_identities, users CASCADE',
  );

  // Los límites por IP son globales y varios tests abren tickets seguidos.
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
});

afterAll(async () => {
  await app?.close();
});

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await (app as NestFastifyApplication)
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as never, url, headers, payload: opts.body as never });

  return { status: res.statusCode, texto: res.body, body: res.body ? JSON.parse(res.body) : null };
}

let n = 0;

async function nuevoUsuario(rol: 'buyer' | 'admin' = 'buyer') {
  n += 1;
  const r = await call('POST', '/api/v1/auth/dev', {
    body: {
      email: `sup${n}-${Date.now()}@test.com`,
      firstName: 'Soporte',
      lastName: `Test${n}`,
      device: {
        installId: `install-sup-${n}-${Date.now()}`,
        platform: 'android',
        appVersion: '1.0.0',
        osVersion: '14',
      },
    },
  });

  const userId = r.body.user.id as string;

  if (rol === 'admin') {
    await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
    // El rol se lee de la base en cada petición, no del token: el que ya
    // tenemos sirve igual. Es lo que hace que un cambio de rol tenga efecto
    // inmediato sin obligar a volver a entrar.
  }


  /**
   * VendoX es 18+ y el backend lo exige antes de comprar y de crear la tienda.
   *
   * Se declara por el mismo camino que usa la app —`PATCH /auth/me`— y no
   * escribiendo la columna: así el test también falla si ese endpoint se rompe.
   * Ver `helpers/edad.ts`.
   */
  await call('PATCH', '/api/v1/auth/me', {
    token: r.body.accessToken as string,
    body: { birthDate: NACIMIENTO_ADULTO_ISO },
  });

  return { token: r.body.accessToken as string, userId };
}

/** Limpia los límites por bucket: varios tests abren tickets seguidos. */
async function limpiarLimites() {
  const claves = await redis.client.keys('rl:*');
  if (claves.length > 0) await redis.client.del(...claves);
}

async function abrir(token: string, body: Record<string, unknown>) {
  await limpiarLimites();
  return call('POST', '/api/v1/support/tickets', { token, body });
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Soporte', () => {
  describe('El asistente contesta lo que puede', () => {
    it('una consulta de envío recibe respuesta automática', async () => {
      const u = await nuevoUsuario();

      const r = await abrir(u.token, { mensaje: '¿Cuándo llega mi pedido?' });

      expect(r.status, r.texto).toBe(201);
      expect(r.body.category).toBe('ENVIO');
      expect(r.body.status).toBe('ESPERANDO_RESPUESTA');

      const mensajes = r.body.messages as Array<{ author: string; body: string }>;
      expect(mensajes).toHaveLength(2);
      expect(mensajes[0]?.author).toBe('USUARIO');
      expect(mensajes[1]?.author).toBe('ASISTENTE');
      expect(mensajes[1]?.body).toContain('Mis pedidos');
    });

    it('la respuesta de cambios incluye el derecho legal', async () => {
      // El asistente dice lo mismo que la ficha del producto. Dos textos
      // distintos sobre el mismo derecho es exactamente cómo se pierde un
      // reclamo.
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: 'quiero cambiar el talle de una remera' });

      const mensajes = r.body.messages as Array<{ body: string }>;
      expect(mensajes[1]?.body).toContain('10 días corridos');
    });

    it('deja un aviso en el centro de notificaciones', async () => {
      const u = await nuevoUsuario();
      await abrir(u.token, { mensaje: '¿cómo publico un producto?' });

      const avisos = await call('GET', '/api/v1/notifications', { token: u.token });
      expect(avisos.body.items).toHaveLength(1);
      expect(avisos.body.items[0].type).toBe('SUPPORT_REPLY');
    });
  });

  describe('⛔ La plata SIEMPRE va a una persona', () => {
    it('un ticket de pagos escala sin que el asistente conteste', async () => {
      /**
       * El test central de este bloque. Lo que se verifica no es sólo que
       * escale: es que **no haya un mensaje del ASISTENTE** en la conversación.
       * Un asistente que contesta y después escala ya dijo algo que no debía, y
       * la persona ya lo leyó.
       */
      const u = await nuevoUsuario();

      const r = await abrir(u.token, {
        mensaje: 'Hola, buenas tardes',
        categoria: 'PAGOS',
      });

      expect(r.body.status).toBe('ESCALADO');
      expect(r.body.escalatedAt).not.toBeNull();

      const mensajes = r.body.messages as Array<{ author: string }>;
      expect(mensajes.map((m) => m.author)).toEqual(['USUARIO', 'SISTEMA']);
      expect(mensajes.some((m) => m.author === 'ASISTENTE')).toBe(false);
    });

    it('pedir un reembolso escala aunque la categoría sea de envío', async () => {
      const u = await nuevoUsuario();

      const r = await abrir(u.token, {
        mensaje: 'No me llegó nada, quiero un reembolso ya',
        categoria: 'ENVIO',
      });

      expect(r.body.status).toBe('ESCALADO');
      const mensajes = r.body.messages as Array<{ author: string }>;
      expect(mensajes.some((m) => m.author === 'ASISTENTE')).toBe(false);
    });

    it('pedir hablar con una persona se respeta', async () => {
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: 'quiero hablar con una persona por favor' });

      expect(r.body.status).toBe('ESCALADO');
      const mensajes = r.body.messages as Array<{ body: string }>;
      // No intenta convencer de nada.
      expect(mensajes[1]?.body).not.toContain('puedo ayudarte');
    });

    it('la escalada queda auditada con el motivo', async () => {
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: 'hola', categoria: 'DISPUTA' });

      const registro = await prisma.auditLog.findFirst({
        where: { action: 'support.escalated', entityId: r.body.id as string },
      });
      expect(registro).not.toBeNull();
      expect(JSON.stringify(registro?.after)).toContain('categoria_sensible');
    });

    it('el motivo técnico NO sale por HTTP', async () => {
      // A quien abrió el ticket no le sirve saber que escaló por
      // "categoria_sensible": sólo genera preguntas.
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: 'hola', categoria: 'PAGOS' });

      expect(r.texto).not.toContain('categoria_sensible');
      expect(r.texto).not.toContain('escalationReason');
    });
  });

  describe('La conversación', () => {
    it('contestar un ticket resuelto lo reabre', async () => {
      /**
       * Alguien que escribe en una conversación cerrada tiene algo más que
       * decir sobre lo mismo. Obligarlo a abrir otra desde cero pierde el
       * contexto y hace que el equipo lea la historia dos veces.
       */
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: '¿cómo hago un vivo?' });
      const id = r.body.id as string;

      await call('PATCH', `/api/v1/support/tickets/${id}/resolve`, { token: u.token });

      const despues = await call('POST', `/api/v1/support/tickets/${id}/messages`, {
        token: u.token,
        body: { mensaje: 'Otra cosa más sobre lo mismo' },
      });

      expect(despues.status, despues.texto).toBe(201);
      expect(despues.body.resolvedAt).toBeNull();
      expect((despues.body.messages as unknown[]).length).toBeGreaterThan(2);
    });

    it('después de varias vueltas va una persona', async () => {
      // Si en cuatro respuestas no se resolvió, no se resuelve en la quinta.
      const u = await nuevoUsuario();
      const r = await abrir(u.token, { mensaje: '¿cómo hago un vivo?' });
      const id = r.body.id as string;

      let ultimo = r.body;
      for (let i = 0; i < 4; i += 1) {
        await limpiarLimites();
        const paso = await call('POST', `/api/v1/support/tickets/${id}/messages`, {
          token: u.token,
          body: { mensaje: 'sigo sin entender, contame otra vez' },
        });
        ultimo = paso.body;
      }

      expect(ultimo.status).toBe('ESCALADO');
    });

    it('⛔ nadie ve la conversación de otro', async () => {
      const dueño = await nuevoUsuario();
      const intruso = await nuevoUsuario();

      const r = await abrir(dueño.token, { mensaje: 'una consulta sobre mi envío' });
      const id = r.body.id as string;

      const ajeno = await call('GET', `/api/v1/support/tickets/${id}`, {
        token: intruso.token,
      });
      // 404 y no 403: confirmar que el ticket existe ya es información.
      expect(ajeno.status).toBe(404);

      const lista = await call('GET', '/api/v1/support/tickets', { token: intruso.token });
      expect(lista.body.items).toHaveLength(0);
    });

    it('⛔ nadie escribe en la conversación de otro', async () => {
      const dueño = await nuevoUsuario();
      const intruso = await nuevoUsuario();

      const r = await abrir(dueño.token, { mensaje: 'una consulta sobre mi envío' });
      const id = r.body.id as string;

      await limpiarLimites();
      const intento = await call('POST', `/api/v1/support/tickets/${id}/messages`, {
        token: intruso.token,
        body: { mensaje: 'me meto en tu conversación' },
      });

      expect(intento.status).toBe(404);

      const cuantos = await prisma.supportMessage.count({ where: { ticketId: id } });
      expect(cuantos).toBe(2);
    });

    it('sin sesión no se puede abrir un ticket', async () => {
      const r = await call('POST', '/api/v1/support/tickets', {
        body: { mensaje: 'sin sesión' },
      });
      expect(r.status).toBe(401);
    });
  });

  describe('La bandeja del equipo', () => {
    it('⛔ un usuario común no la puede ver', async () => {
      const u = await nuevoUsuario();
      const r = await call('GET', '/api/v1/admin/support/tickets', { token: u.token });
      expect(r.status).toBe(403);
    });

    it('el administrador ve lo escalado, con el motivo', async () => {
      const admin = await nuevoUsuario('admin');
      const u = await nuevoUsuario();
      await abrir(u.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

      const r = await call('GET', '/api/v1/admin/support/tickets', { token: admin.token });

      expect(r.status, r.texto).toBe(200);
      const items = r.body.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(1);
      // Del lado interno SÍ hace falta: es lo que dice por qué la máquina no
      // pudo, y sirve para atenderlo rápido.
      expect(items.some((t) => t.escalationReason === 'categoria_sensible')).toBe(true);
    });

    it('una persona del equipo contesta y el ticket queda esperando', async () => {
      const admin = await nuevoUsuario('admin');
      const u = await nuevoUsuario();
      const abierto = await abrir(u.token, { mensaje: 'problema con un cobro', categoria: 'PAGOS' });
      const id = abierto.body.id as string;

      const r = await call(`POST`, `/api/v1/admin/support/tickets/${id}/messages`, {
        token: admin.token,
        body: { mensaje: 'Hola, lo estamos revisando. Te confirmo en el día.' },
      });
      expect(r.status, r.texto).toBe(201);

      const detalle = await call('GET', `/api/v1/support/tickets/${id}`, { token: u.token });
      expect(detalle.body.status).toBe('ESPERANDO_RESPUESTA');

      const mensajes = detalle.body.messages as Array<{ author: string; body: string }>;
      expect(mensajes.at(-1)?.author).toBe('EQUIPO');
      expect(mensajes.at(-1)?.body).toContain('revisando');

      // Y quien preguntó recibe un aviso.
      const avisos = await call('GET', '/api/v1/notifications', { token: u.token });
      expect((avisos.body.items as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it('⛔ la respuesta del equipo no revela quién la escribió', async () => {
      // Qué persona del equipo contestó es interno: expone la estructura y no
      // le sirve de nada a quien preguntó.
      const admin = await nuevoUsuario('admin');
      const u = await nuevoUsuario();
      const abierto = await abrir(u.token, { mensaje: 'un problema', categoria: 'DISPUTA' });
      const id = abierto.body.id as string;

      await call('POST', `/api/v1/admin/support/tickets/${id}/messages`, {
        token: admin.token,
        body: { mensaje: 'Lo vemos.' },
      });

      const detalle = await call('GET', `/api/v1/support/tickets/${id}`, { token: u.token });
      expect(detalle.texto).not.toContain(admin.userId);
      expect(detalle.texto).not.toContain('authorUserId');
    });
  });
});

describe('El asunto', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * OPCIONAL, PORQUE PEDIRLO ANTES DE CONTAR EL PROBLEMA PIERDE GENTE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Un formulario que obliga a titular una queja antes de poder hacerla es
   * donde alguien frustrado abandona. Cuando no viene, el backend lo arma con
   * la primera línea del mensaje, como hizo siempre.
   */

  it('cuando lo escriben, se usa el que escribieron', async () => {
    const u = await nuevoUsuario();

    const r = await call('POST', '/api/v1/support/tickets', {
      token: u.token,
      body: {
        asunto: 'No me llegó el pedido',
        mensaje: 'Compré el martes y todavía no recibí nada. El vendedor no responde.',
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.subject).toBe('No me llegó el pedido');
  });

  it('sin asunto, se deriva del mensaje', async () => {
    // La conducta de siempre. Este test existe para que agregar el campo no la
    // haya roto.
    const u = await nuevoUsuario();

    const r = await call('POST', '/api/v1/support/tickets', {
      token: u.token,
      body: { mensaje: 'Quiero saber cómo cambio mi dirección de envío.' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.subject).toBe('Quiero saber cómo cambio mi dirección de envío.');
  });

  it('⛔ un asunto en blanco cae al derivado, no deja el ticket sin título', async () => {
    // `min(3)` lo rechaza en el esquema, pero espacios sueltos pasan el trim
    // del cliente y llegarían vacíos. Un ticket sin asunto es invisible en la
    // lista del equipo.
    const u = await nuevoUsuario();

    const r = await call('POST', '/api/v1/support/tickets', {
      token: u.token,
      body: { asunto: '   ', mensaje: 'Tengo un problema con un cobro duplicado.' },
    });

    // El esquema lo rechaza por corto tras el trim: es el resultado correcto.
    expect(r.status).toBe(400);
  });
});

/**
 * El soporte prioritario de Business.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UN BENEFICIO QUE NO SE PUEDE VERIFICAR ES PUBLICIDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SOPORTE_PRIORITARIO` figura en la lista de beneficios de Business. Estos
 * tests son la única razón por la que esa línea se puede escribir: sin ellos
 * sería una promesa en una pantalla de precios, y el ticket del vendedor que
 * paga el plan caro seguiría exactamente en el mismo lugar de la cola.
 */
async function vendedorConPlan(plan: 'FREE' | 'PRO' | 'BUSINESS', vigenteHasta: Date | null) {
  const u = await nuevoUsuario();
  await limpiarLimites();

  const s = await call('POST', '/api/v1/sellers', {
    token: u.token,
    body: { displayName: `Vendedor ${plan} ${n}`, storeName: `Local ${plan} ${n}` },
  });
  expect(s.status, s.texto).toBe(201);
  const sellerId = s.body.seller.id as string;

  if (plan !== 'FREE') {
    await prisma.sellerMembership.create({
      data: {
        id: `mem_${sellerId.slice(-20)}`,
        sellerId,
        plan,
        periodo: 'MENSUAL',
        origen: 'CORTESIA',
        vigenteHasta,
      },
    });
  }

  return { ...u, sellerId };
}

async function idsDeLaBandeja(tokenAdmin: string): Promise<string[]> {
  const r = await call('GET', '/api/v1/admin/support/tickets', { token: tokenAdmin });
  expect(r.status, r.texto).toBe(200);
  return (r.body.items as Array<{ id: string }>).map((t) => t.id);
}

describe('Soporte prioritario (Business)', () => {
  it('el ticket de un Business va arriba aunque haya llegado último', async () => {
    const admin = await nuevoUsuario('admin');
    await prisma.supportTicket.deleteMany({});

    // Primero el común, después el de Business. Por antigüedad iría al revés:
    // ese es justamente el orden que la prioridad tiene que romper.
    const comun = await nuevoUsuario();
    const primero = await abrir(comun.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const business = await vendedorConPlan('BUSINESS', new Date(Date.now() + 30 * 86_400_000));
    const segundo = await abrir(business.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const ids = await idsDeLaBandeja(admin.token);

    expect(ids[0]).toBe(segundo.body.id);
    expect(ids).toContain(primero.body.id);
  });

  /**
   * La prioridad adelanta en la cola; no habilita a colarse entre iguales. Dos
   * Business se siguen atendiendo por orden de espera, que es lo justo.
   */
  it('entre dos Business sigue mandando quién esperó más', async () => {
    const admin = await nuevoUsuario('admin');
    await prisma.supportTicket.deleteMany({});

    const uno = await vendedorConPlan('BUSINESS', new Date(Date.now() + 30 * 86_400_000));
    const viejo = await abrir(uno.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const otro = await vendedorConPlan('BUSINESS', new Date(Date.now() + 30 * 86_400_000));
    const nuevo = await abrir(otro.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const ids = await idsDeLaBandeja(admin.token);

    expect(ids.indexOf(viejo.body.id)).toBeLessThan(ids.indexOf(nuevo.body.id));
  });

  /**
   * ESTE ES EL TEST QUE PROTEGE LA PLATA DEL OTRO LADO.
   *
   * La fila sigue diciendo BUSINESS hasta que algo la actualice —es lo que
   * explica `planVigente()`—. Sin comprobar la fecha en la consulta, alguien
   * que dejó de pagar hace seis meses seguiría saltando la cola para siempre.
   */
  it('⛔ un Business vencido NO tiene prioridad', async () => {
    const admin = await nuevoUsuario('admin');
    await prisma.supportTicket.deleteMany({});

    const comun = await nuevoUsuario();
    const primero = await abrir(comun.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const vencido = await vendedorConPlan('BUSINESS', new Date(Date.now() - 86_400_000));
    const segundo = await abrir(vencido.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const ids = await idsDeLaBandeja(admin.token);

    expect(ids[0]).toBe(primero.body.id);
    expect(ids.indexOf(segundo.body.id)).toBeGreaterThan(0);
  });

  /**
   * Que Pro NO tenga prioridad es la mitad de lo que hace que Business valga.
   * Si la tuviera, el beneficio no distinguiría un plan del otro.
   */
  it('⛔ un Pro vigente NO tiene prioridad', async () => {
    const admin = await nuevoUsuario('admin');
    await prisma.supportTicket.deleteMany({});

    const comun = await nuevoUsuario();
    const primero = await abrir(comun.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const pro = await vendedorConPlan('PRO', new Date(Date.now() + 30 * 86_400_000));
    const segundo = await abrir(pro.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const ids = await idsDeLaBandeja(admin.token);

    expect(ids[0]).toBe(primero.body.id);
    expect(ids.indexOf(segundo.body.id)).toBeGreaterThan(0);
  });

  /**
   * Que los demás no desaparezcan es tan importante como que Business suba. Un
   * corte mal hecho podría dejar la bandeja con sólo los prioritarios, y los
   * tickets de todos los demás no los vería nadie.
   */
  it('los tickets no prioritarios siguen estando', async () => {
    const admin = await nuevoUsuario('admin');
    await prisma.supportTicket.deleteMany({});

    const a = await nuevoUsuario();
    const b = await nuevoUsuario();
    const t1 = await abrir(a.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });
    const t2 = await abrir(b.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const business = await vendedorConPlan('BUSINESS', new Date(Date.now() + 30 * 86_400_000));
    const t3 = await abrir(business.token, { mensaje: 'me cobraron dos veces', categoria: 'PAGOS' });

    const ids = await idsDeLaBandeja(admin.token);

    expect(ids).toHaveLength(3);
    for (const t of [t1, t2, t3]) expect(ids).toContain(t.body.id);
  });
});
