import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';

import { env } from '@/config/env.schema';
import { DomainError } from '@/shared/errors/domain.error';
import {
  CuentaConOperacionesEnCursoError,
  ESTADOS_QUE_IMPIDEN_CERRAR,
  puedeCerrarCuenta,
} from '@/modules/users/cierre-de-cuenta';
import {
  FechaDeNacimientoInvalidaError,
  FechaDeNacimientoYaDeclaradaError,
  fechaDeNacimientoInvalida,
  mismaFecha,
  parsearFechaDeNacimiento,
} from '@/modules/users/edad';
import { contrasenaCoincide } from '@/shared/crypto/contrasenas';
import { PrismaService } from '@/shared/prisma/prisma.service';
import { newId } from '@/shared/utils/id';

import type { CompleteProfileDto, DeviceDto } from './dto/auth.dto';
import { IdentityService, type VerifiedIdentity } from './identity.service';
import { SessionsService, type IssuedSession, type SessionContext } from './sessions.service';
import { normalizeEmail, normalizePhoneAr } from './tokens';

/**
 * Registro e inicio de sesión.
 *
 * ─── El onboarding que pidió el producto ───
 *
 * Un toque en "Continuar con Google" y adentro. Nada de formularios antes de
 * ver el primer video. Lo que falta se pide **cuando hace falta**: el teléfono
 * antes de comprar, la dirección en la primera compra.
 *
 * Esa decisión tiene una consecuencia técnica que atraviesa el módulo: el
 * usuario existe con datos incompletos, y cada paso posterior tiene que
 * comprobar lo suyo en vez de asumir que ya está todo.
 */

/**
 * Un hash válido contra el que comparar cuando el usuario NO existe.
 *
 * Sin esto, un email inexistente responde en un milisegundo y uno real en cien:
 * la diferencia se mide desde afuera y dice qué cuentas existen en el sistema.
 *
 * El valor no importa —nadie conoce su preimagen y nunca sirve para
 * autenticar— pero tiene que tener la FORMA correcta, para que
 * `contrasenaCoincide` haga el trabajo completo de derivación en vez de salir
 * por el camino corto del formato inválido.
 */
const HASH_DESCARTABLE = [
  'scrypt',
  '1',
  'A'.repeat(22),
  'A'.repeat(86),
].join('$');

export class AccountSuspendedError extends DomainError {
  constructor(status: string) {
    super('ACCOUNT_SUSPENDED', 'Tu cuenta está suspendida', { status });
  }
}

export class InvalidPhoneError extends DomainError {
  constructor(raw: string) {
    super('PHONE_INVALID', 'Ese número de teléfono no parece válido', { recibido: raw });
  }
}

export interface LoginResult extends IssuedSession {
  user: PublicUser;
  /** `true` la primera vez. La app lo usa para mostrar la bienvenida. */
  isNewUser: boolean;
  /** Lo que falta para poder comprar. La app lo usa para saber qué pedir. */
  missing: string[];
}

export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  whatsappOptIn: boolean;
  avatarUrl: string | null;
  role: string;
  /** `AAAA-MM-DD` o `null`. Declarada, no verificada. Ver `users/edad.ts`. */
  birthDate: string | null;
  createdAt: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly sessions: SessionsService,
  ) {}

  async loginWithGoogle(idToken: string, device: DeviceDto, ctx: SessionContext) {
    const verificada = await this.identity.verifyGoogle(idToken);
    return this.loginWithIdentity(verificada, device, ctx);
  }

  async loginWithApple(
    idToken: string,
    nombre: { firstName?: string; lastName?: string },
    device: DeviceDto,
    ctx: SessionContext,
  ) {
    const verificada = await this.identity.verifyApple(idToken, nombre);
    return this.loginWithIdentity(verificada, device, ctx);
  }

  /**
   * Login de desarrollo: emite una sesión sin verificar nada.
   *
   * Existe para poder probar la app antes de tener credenciales de Google, y
   * para que los tests no dependan de un servicio externo. `env.schema` impide
   * que se encienda en producción, y acá se vuelve a comprobar: una salvaguarda
   * que depende de un solo lugar es una salvaguarda que un día se saltea.
   */
  async devLogin(
    params: { email: string; firstName: string; lastName: string; role: string },
    device: DeviceDto,
    ctx: SessionContext,
  ): Promise<LoginResult> {
    if (!env.AUTH_DEV_LOGIN_ENABLED) {
      throw new DomainError('NOT_FOUND', 'No disponible');
    }
    return this.loginWithIdentity(
      {
        provider: 'google',
        subject: `dev:${normalizeEmail(params.email)}`,
        email: params.email,
        emailVerified: true,
        firstName: params.firstName,
        lastName: params.lastName,
        avatarUrl: null,
      },
      device,
      ctx,
      params.role,
    );
  }

  /**
   * Login con contraseña, EXCLUSIVAMENTE para cuentas de demostración.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ EXISTE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Quien revisa la app en Google Play necesita credenciales que pueda tipear.
   * VendoX entra con Google o con Apple, y darle una cuenta de Google real
   * significa depender de que Google no le pida una verificación adicional
   * cuando el revisor entre desde otro país — que es exactamente lo que hace.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POR QUÉ NO ES UN AGUJERO
   * ═══════════════════════════════════════════════════════════════════════
   *
   * El aislamiento **no es un `if`**: está en el WHERE.
   *
   *     where: { email, isDemoAccount: true, ... }
   *
   * Una cuenta sin la marca no se encuentra. No es que se encuentre y se
   * rechace: la consulta no la devuelve. Aunque alguien conozca la contraseña
   * de la cuenta de revisión, no puede usarla para entrar a ninguna otra —no
   * hay ninguna otra con hash, y la base lo garantiza con un CHECK—.
   *
   * Las tres barreras, en orden:
   *
   *   1. `DEMO_LOGIN_ENABLED` apagado → el endpoint no existe;
   *   2. el WHERE exige la marca;
   *   3. un CHECK de la base impide que una cuenta sin la marca tenga hash.
   *
   * Y la marca sólo la pone `scripts/cuenta-de-revision.mjs`. No hay ningún
   * endpoint que la escriba.
   *
   * ⚠️ La contraseña no aparece en ningún log, ni en la bitácora, ni en el
   * mensaje de error. Ver `registrarIntento`.
   */
  async loginDemo(
    params: { email: string; password: string },
    device: DeviceDto,
    ctx: SessionContext,
  ): Promise<LoginResult> {
    if (!env.DEMO_LOGIN_ENABLED) {
      /**
       * El mismo error que una ruta inexistente.
       *
       * Un "login de demo deshabilitado" le confirma a quien prueba que el
       * endpoint existe y que hay cuentas de demostración en este servidor.
       */
      throw new DomainError('NOT_FOUND', 'No disponible');
    }

    const email = normalizeEmail(params.email);

    /**
     * El WHERE es el aislamiento. `isDemoAccount` no es un filtro más.
     *
     * `deletedAt: null` y `status: 'active'` también van acá y no en un `if`
     * posterior, por el mismo motivo de siempre: una condición en la consulta
     * no se puede saltear reordenando el código.
     */
    const usuario = await this.prisma.user.findFirst({
      where: { email, isDemoAccount: true, deletedAt: null, status: 'active' },
    });

    /**
     * Se verifica un hash aunque el usuario no exista.
     *
     * Sin esto, un email inexistente responde en un milisegundo y uno real en
     * cien: la diferencia se mide desde afuera y dice qué cuentas existen.
     * Comparar contra un hash descartable iguala los tiempos.
     */
    const hash = usuario?.passwordHash ?? HASH_DESCARTABLE;
    const coincide = await contrasenaCoincide(params.password, hash);

    if (!usuario || !coincide) {
      await this.registrarIntento({ email, exito: false, ctx });
      // El mismo mensaje para "no existe" y para "contraseña equivocada".
      throw new DomainError('INVALID_CREDENTIALS', 'Email o contraseña incorrectos');
    }

    const dispositivo = await this.registrarDispositivo(usuario.id, device);
    const sesion = await this.sessions.createSession(
      { id: usuario.id, role: usuario.role },
      { ...ctx, deviceId: dispositivo.id },
    );

    await this.registrarIntento({ email, exito: true, ctx, userId: usuario.id });

    return {
      ...sesion,
      user: this.toPublic(usuario),
      isNewUser: false,
      missing: this.faltantes(usuario),
    };
  }

  /**
   * Deja constancia del intento. Con o sin éxito.
   *
   * ⛔ NUNCA la contraseña, ni recortada, ni su largo. Un intento fallido con
   * la contraseña adentro es una contraseña real —la que alguien tipeó mal por
   * un carácter— guardada en texto plano en una tabla de auditoría.
   *
   * El email sí: es el identificador que se está probando y sin él la bitácora
   * no sirve para nada. La IP la aporta el contexto de la petición.
   */
  private async registrarIntento(params: {
    email: string;
    exito: boolean;
    ctx: SessionContext;
    userId?: string;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: newId('aud'),
        actorType: 'user',
        action: params.exito ? 'auth.demo_login_success' : 'auth.demo_login_failed',
        entityType: 'user',
        entityId: params.userId ?? params.email,
        actorId: params.userId ?? null,
        ip: params.ctx.ip ?? null,
        userAgent: params.ctx.userAgent ?? null,
      },
    });

    if (!params.exito) {
      this.logger.warn({
        msg: 'intento fallido de login de demostración',
        email: params.email,
        // ⛔ Sin la contraseña. Ni su largo.
      });
    }
  }

  /**
   * Resuelve la identidad verificada a una cuenta y abre la sesión.
   *
   * ─── Las tres formas de llegar ───
   *
   *   1. La identidad ya existe            → es un login normal.
   *   2. No existe, pero el email sí       → se VINCULA a la cuenta existente.
   *   3. No existe ninguna de las dos      → cuenta nueva.
   *
   * El caso 2 es el que evita el problema más molesto de los logins sociales:
   * alguien que entró con Google, un día toca "Continuar con Apple" y aparece
   * en una cuenta vacía, sin sus compras. Con la vinculación entra a la suya.
   */
  private async loginWithIdentity(
    verificada: VerifiedIdentity,
    device: DeviceDto,
    ctx: SessionContext,
    rolForzado?: string,
  ): Promise<LoginResult> {
    const email = verificada.email ? normalizeEmail(verificada.email) : null;

    const existente = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: verificada.provider, subject: verificada.subject } },
      include: { user: true },
    });

    let user: User;
    let isNewUser = false;

    if (existente) {
      // ── Caso 1 ──
      user = existente.user;
      await this.prisma.userIdentity.update({
        where: { id: existente.id },
        data: { lastUsedAt: new Date() },
      });
    } else if (email && (await this.prisma.user.findUnique({ where: { email } }))) {
      // ── Caso 2: vinculación ──
      //
      // Sólo si el proveedor confirma que verificó el email. Sin esa
      // comprobación, un proveedor que permita declarar cualquier email sería
      // una forma directa de apropiarse de una cuenta ajena.
      if (!verificada.emailVerified) {
        throw new DomainError('IDENTITY_REJECTED', 'No pudimos verificar tu identidad', {
          reason: 'email sin verificar en el proveedor',
        });
      }
      user = await this.prisma.user.findUniqueOrThrow({ where: { email } });
      await this.prisma.userIdentity.create({
        data: {
          id: newId('idn'),
          userId: user.id,
          provider: verificada.provider,
          subject: verificada.subject,
          email,
        },
      });
      this.logger.log({ msg: 'identidad vinculada a cuenta existente', userId: user.id });
    } else {
      // ── Caso 3: cuenta nueva ──
      const resultado = await this.crearCuenta(verificada, email, rolForzado);
      user = resultado;
      isNewUser = true;
    }

    if (user.status !== 'active' || user.deletedAt !== null) {
      throw new AccountSuspendedError(user.status);
    }

    const dispositivo = await this.registrarDispositivo(user.id, device);

    const sesion = await this.sessions.createSession(
      { id: user.id, role: user.role },
      { ...ctx, deviceId: dispositivo.id },
    );

    return {
      ...sesion,
      user: this.toPublic(user),
      isNewUser,
      missing: this.faltantes(user),
    };
  }

  private async crearCuenta(
    verificada: VerifiedIdentity,
    email: string | null,
    rolForzado?: string,
  ): Promise<User> {
    if (!email) {
      /**
       * Sin email no hay cuenta.
       *
       * Pasa con Apple cuando la persona elige "Ocultar mi correo" y el
       * proveedor no lo entrega. Es un caso real, y preferimos frenar con un
       * mensaje claro a crear una cuenta sin forma de contactar a nadie
       * —imposible avisar que el pedido salió, imposible recuperar el acceso—.
       */
      throw new DomainError('IDENTITY_REJECTED', 'Necesitamos tu email para crear la cuenta', {
        reason: 'el proveedor no entregó email',
      });
    }

    try {
      return await this.prisma.user.create({
        data: {
          id: newId('usr'),
          firstName: verificada.firstName ?? 'Sin nombre',
          lastName: verificada.lastName ?? '',
          email,
          emailVerified: verificada.emailVerified,
          avatarUrl: verificada.avatarUrl,
          role: (rolForzado ?? 'buyer') as User['role'],
          identities: {
            create: {
              id: newId('idn'),
              provider: verificada.provider,
              subject: verificada.subject,
              email,
            },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        /**
         * Carrera: dos logins simultáneos del mismo usuario nuevo.
         *
         * Pasa de verdad — la app reintenta, o la persona toca dos veces. El
         * índice UNIQUE resuelve la carrera y acá simplemente se lee la fila
         * que ganó.
         */
        return this.prisma.user.findUniqueOrThrow({ where: { email } });
      }
      throw err;
    }
  }

  /**
   * Registra o actualiza el dispositivo.
   *
   * `installId` es único, así que reabrir la app en el mismo teléfono actualiza
   * la fila en vez de acumular una nueva por sesión.
   */
  private async registrarDispositivo(userId: string, device: DeviceDto) {
    /**
     * Si el token de push venía asociado a OTRA cuenta, se desasocia primero.
     *
     * Es el caso de un teléfono prestado o revendido: sin esto, el dueño
     * anterior seguiría recibiendo las notificaciones del nuevo, incluidas las
     * de sus compras.
     */
    if (device.pushToken) {
      await this.prisma.device.updateMany({
        where: { pushToken: device.pushToken, installId: { not: device.installId } },
        data: { pushToken: null },
      });
    }

    return this.prisma.device.upsert({
      where: { installId: device.installId },
      create: {
        id: newId('dev'),
        userId,
        installId: device.installId,
        platform: device.platform,
        appVersion: device.appVersion,
        osVersion: device.osVersion,
        model: device.model ?? null,
        pushToken: device.pushToken ?? null,
        timezone: device.timezone,
      },
      update: {
        // El userId se actualiza: el mismo teléfono puede cambiar de dueño.
        userId,
        appVersion: device.appVersion,
        osVersion: device.osVersion,
        pushToken: device.pushToken ?? undefined,
        lastSeenAt: new Date(),
        // Un dispositivo que vuelve a aparecer arranca de cero en fallos de
        // envío: los anteriores eran de una instalación que ya no existe.
        failureCount: 0,
      },
    });
  }

  async completeProfile(userId: string, dto: CompleteProfileDto): Promise<PublicUser> {
    const data: Prisma.UserUpdateInput = {};

    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim();
    if (dto.whatsappOptIn !== undefined) data.whatsappOptIn = dto.whatsappOptIn;

    if (dto.phone !== undefined) {
      const e164 = normalizePhoneAr(dto.phone);
      if (!e164) throw new InvalidPhoneError(dto.phone);
      data.phoneE164 = e164;
      /**
       * Cambiar el teléfono INVALIDA la verificación anterior.
       *
       * Sin esto, alguien con un número verificado lo cambiaría por otro y se
       * quedaría con el estado de verificado sobre un número que nadie
       * comprobó. El teléfono verificado es requisito para comprar.
       */
      data.phoneVerified = false;
    }

    if (dto.birthDate !== undefined) {
      /**
       * La fecha de nacimiento se declara UNA vez.
       *
       * ─── Por qué no se puede editar libremente ───
       *
       * Si se pudiera, la regla de 18+ no existiría: alguien pone una fecha
       * cualquiera, la app lo frena, y vuelve a la pantalla a poner otra. Sería
       * un formulario que enseña cuál es la respuesta correcta.
       *
       * Corregir un error genuino —el año tipeado mal— pasa por soporte, que es
       * exactamente lo que hacen las plataformas que tienen esta regla en serio.
       * Es incómodo a propósito y le pasa a poca gente.
       *
       * ⚠️ No se lanza si manda la MISMA fecha: la app reintenta peticiones y
       * un reintento no puede convertirse en un error que no existe.
       */
      const nueva = parsearFechaDeNacimiento(dto.birthDate);
      const invalida = fechaDeNacimientoInvalida(nueva);
      if (invalida) throw new FechaDeNacimientoInvalidaError(invalida);

      const actual = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { birthDate: true },
      });

      if (actual.birthDate && !mismaFecha(actual.birthDate, nueva)) {
        throw new FechaDeNacimientoYaDeclaradaError();
      }

      if (!actual.birthDate) {
        data.birthDate = nueva;
        // La constancia de que se preguntó y de cuándo. Ver `edad.ts`.
        data.birthDateDeclaredAt = new Date();
      }
    }

    const user = await this.prisma.user.update({ where: { id: userId }, data });
    return this.toPublic(user);
  }

  async me(userId: string): Promise<PublicUser & { missing: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { ...this.toPublic(user), missing: this.faltantes(user) };
  }

  async updatePushToken(
    userId: string,
    params: { installId: string; pushToken: string | null; pushEnabled: boolean },
  ): Promise<{ ok: true }> {
    if (params.pushToken) {
      await this.prisma.device.updateMany({
        where: { pushToken: params.pushToken, installId: { not: params.installId } },
        data: { pushToken: null },
      });
    }
    await this.prisma.device.updateMany({
      where: { installId: params.installId, userId },
      data: { pushToken: params.pushToken, pushEnabled: params.pushEnabled, failureCount: 0 },
    });
    return { ok: true };
  }

  /**
   * Cierra la cuenta.
   *
   * Borrado lógico y anonimización de lo que identifica a la persona, no
   * borrado físico: las órdenes tienen que sobrevivir para el historial del
   * vendedor y para la contabilidad.
   *
   * El email se libera con un sufijo para que la dirección pueda volver a
   * usarse —alguien que se va y vuelve— sin chocar con el índice UNIQUE.
   */
  async closeAccount(userId: string): Promise<{ ok: true }> {
    /**
     * Nadie se va con operaciones abiertas.
     *
     * El agujero que esto tapa: un vendedor cobraba diez pedidos, tocaba
     * "eliminar cuenta" y desaparecía. Diez personas con la plata puesta y del
     * otro lado una cuenta anonimizada sin forma de contactar a nadie.
     *
     * El bloqueo es temporal y explicado, no una retención: la Ley 25.326 da el
     * derecho a irse y convertir "tenés un pedido en camino" en "no te podés ir
     * nunca" sería usar una regla legítima para atrapar gente. Ver
     * `users/cierre-de-cuenta.ts`.
     */
    const [comoComprador, comoVendedor] = await Promise.all([
      this.prisma.order.count({
        where: { buyerId: userId, status: { in: [...ESTADOS_QUE_IMPIDEN_CERRAR] } },
      }),
      this.prisma.order.count({
        where: {
          seller: { userId },
          status: { in: [...ESTADOS_QUE_IMPIDEN_CERRAR] },
        },
      }),
    ]);

    const operaciones = { comoComprador, comoVendedor };
    if (!puedeCerrarCuenta(operaciones)) {
      throw new CuentaConOperacionesEnCursoError(operaciones);
    }

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'deleted',
          deletedAt: new Date(),
          email: `borrada+${user.id}@cuenta.invalid`,
          phoneE164: null,
          phoneVerified: false,
          avatarUrl: null,
          firstName: 'Cuenta',
          lastName: 'eliminada',
          /**
           * La fecha de nacimiento también se va.
           *
           * Se olvidaba, y es de los datos más personales que guardamos: sola
           * no identifica a nadie, pero cruzada con las órdenes —que sí
           * sobreviven, con la dirección de entrega adentro— sí.
           *
           * La constancia de que se declaró queda: es el registro de que se
           * preguntó, y no dice nada sobre la persona.
           */
          birthDate: null,
        },
      });
      // Las identidades se borran: si no, volver a entrar con Google
      // reactivaría una cuenta que la persona pidió cerrar.
      await tx.userIdentity.deleteMany({ where: { userId } });
      // Y los tokens de push, para que no siga recibiendo notificaciones.
      await tx.device.updateMany({ where: { userId }, data: { pushToken: null, pushEnabled: false } });
    });

    this.logger.log({ msg: 'cuenta cerrada', userId });
    return { ok: true };
  }

  /**
   * Qué le falta a la cuenta para poder comprar.
   *
   * La app lo usa para pedir lo justo en el momento justo, en lugar de un
   * formulario largo al principio. Es el otro lado del onboarding rápido.
   */
  private faltantes(user: User): string[] {
    const falta: string[] = [];
    if (!user.phoneE164) falta.push('phone');
    if (!user.phoneVerified) falta.push('phoneVerification');
    if (user.firstName === 'Sin nombre' || !user.lastName) falta.push('name');
    // Se pide antes de comprar y antes de crear la tienda, no al registrarse.
    // Ver `edad.ts`.
    if (!user.birthDate) falta.push('birthDate');
    return falta;
  }

  private toPublic(user: User): PublicUser {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      emailVerified: user.emailVerified,
      phone: user.phoneE164,
      phoneVerified: user.phoneVerified,
      whatsappOptIn: user.whatsappOptIn,
      avatarUrl: user.avatarUrl,
      role: user.role,
      /**
       * Sólo la fecha, sin hora. La columna es `DATE`, así que Prisma la
       * devuelve a medianoche UTC; mandar el ISO entero haría que la app en
       * Buenos Aires la muestre como el día anterior.
       */
      birthDate: user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
