import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser, Roles, type AuthenticatedUser } from '@/modules/auth/auth.guard';
import { ipDelCliente } from '@/shared/http/client-ip';
import { RateLimit } from '@/shared/http/rate-limit.guard';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';

import { AdminSearchService } from './admin-search.service';
import { AdminTimelineService } from './admin-timeline.service';
import { RiskService } from '@/modules/sellers/risk.service';
 import { VerificationService } from '@/modules/sellers/verification.service';

import { AdminService, type ActorAdmin } from './admin.service';
import {
  AccionAdminSchema,
  BusquedaSchema,
  ListaAuditoriaSchema,
  ListaDevolucionesSchema,
  ListaOrdenesSchema,
  ListaPagosSchema,
  ListaUsuariosSchema,
  ListaVendedoresSchema,
  ListaWebhooksSchema,
  PaginaSchema,
  type AccionAdminDto,
  type BusquedaDto,
  type ListaAuditoriaDto,
  type ListaDevolucionesDto,
  type ListaOrdenesDto,
  type ListaPagosDto,
  type ListaUsuariosDto,
  type ListaVendedoresDto,
  type ListaWebhooksDto,
  type PaginaDto,
} from './dto/admin.dto';

/**
 * `/api/v1/admin/...`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TODO EL CONTROLADOR EXIGE ROL ADMIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El `@Roles('admin')` está a nivel de CLASE, no de método. Es deliberado: con
 * el decorador por método, agregar un endpoint nuevo y olvidarse de anotarlo lo
 * deja accesible a cualquier usuario autenticado — y lo que falta es una línea
 * que no está, así que no se ve al revisar el código.
 *
 * A nivel de clase, el olvido tiene el signo contrario: no hay forma de agregar
 * un endpoint desprotegido acá adentro sin escribir explícitamente un
 * `@Public()`, que sí se ve.
 *
 * El rol lo lee `AuthGuard` **de la base en cada petición**, no del token. Un
 * admin degradado a comprador pierde el acceso en la petición siguiente, no
 * cuando expire su token.
 *
 * ─── Por qué los endpoints administrativos están separados ───
 *
 * Nada de `/api/v1/orders/:id?admin=true`. Un endpoint que cambia de
 * comportamiento según quién llama tiene dos conjuntos de reglas de
 * autorización en el mismo lugar, y el día que se agregue una tercera variante
 * alguien se va a equivocar de rama. Rutas separadas: una entrada, un permiso.
 */
@Roles('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly search: AdminSearchService,
    private readonly timeline: AdminTimelineService,
    private readonly verificacion: VerificationService,
    private readonly riesgo: RiskService,
  ) {}

  // ─── Inicio y búsqueda ─────────────────────────────────────────────────────

  @Get('attention')
  atencion() {
    return this.admin.atencion();
  }

  /**
   * La búsqueda global.
   *
   * Con límite de peticiones **por admin, no por IP**: es una consulta cara
   * —hasta cuatro tablas en paralelo— y el límite existe para que una pantalla
   * con búsqueda en cada tecla no castigue la base. Se identifica por usuario
   * porque todo el equipo de soporte puede compartir la salida a internet, y
   * limitarlos por IP los pondría a todos en el mismo contador.
   */
  @RateLimit({ limit: 120, windowSec: 60, bucket: 'admin:search' })
  @Get('search')
  buscar(@Query(new ZodValidationPipe(BusquedaSchema)) q: BusquedaDto) {
    return this.search.buscar(q.q);
  }

  // ─── Usuarios ──────────────────────────────────────────────────────────────

  @Get('users')
  listarUsuarios(@Query(new ZodValidationPipe(ListaUsuariosSchema)) q: ListaUsuariosDto) {
    return this.admin.listarUsuarios(q);
  }

  @Get('users/:id')
  verUsuario(@Param('id') id: string) {
    return this.admin.verUsuarioCompleto(id);
  }

  @Post('users/:id/suspend')
  suspenderUsuario(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.suspenderUsuario(this.actor(req, actor), id, dto.reason);
  }

  @Post('users/:id/reactivate')
  reactivarUsuario(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.reactivarUsuario(this.actor(req, actor), id, dto.reason);
  }

  @Post('users/:id/revoke-sessions')
  revocarSesiones(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.revocarSesiones(this.actor(req, actor), id, dto.reason);
  }

  // ─── Vendedores ────────────────────────────────────────────────────────────

  @Get('sellers')
  listarVendedores(@Query(new ZodValidationPipe(ListaVendedoresSchema)) q: ListaVendedoresDto) {
    return this.admin.listarVendedores(q);
  }

  @Get('sellers/:id')
  verVendedor(@Param('id') id: string) {
    return this.admin.verVendedorCompleto(id);
  }

  @Post('sellers/:id/suspend')
  suspenderVendedor(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.cambiarEstadoVendedor(this.actor(req, actor), id, 'SUSPENDED', dto.reason);
  }

  @Post('sellers/:id/reactivate')
  reactivarVendedor(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.cambiarEstadoVendedor(this.actor(req, actor), id, 'ACTIVE', dto.reason);
  }

  @Post('sellers/:id/block')
  bloquearVendedor(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.cambiarEstadoVendedor(this.actor(req, actor), id, 'BLOCKED', dto.reason);
  }

  /**
   * Toma una verificación para revisarla.
   *
   * Sin motivo: no es una acción sobre el vendedor, es marcar que uno la está
   * mirando para que otro admin no la revise en paralelo. Exigir un motivo para
   * eso enseñaría a escribir "reviso" y devaluaría el campo donde sí importa.
   */
  @Post('sellers/:id/verification/take')
  tomarVerificacion(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.verificacion.tomarParaRevisar(actor.id, id);
  }

  @Post('sellers/:id/verification/approve')
  aprobarVerificacion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.verificacion.resolver(actor.id, id, 'VERIFIED', dto.reason);
  }

  @Post('sellers/:id/verification/reject')
  rechazarVerificacion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.verificacion.resolver(actor.id, id, 'REJECTED', dto.reason);
  }

  /** Recalcula el riesgo a mano. Útil cuando se corrigió algo fuera del flujo. */
  @Post('sellers/:id/risk/recompute')
  recalcularRiesgo(@Param('id') id: string) {
    return this.riesgo.recalcular(id);
  }

  // ─── Productos ─────────────────────────────────────────────────────────────

  @Get('products/:id')
  verProducto(@Param('id') id: string) {
    return this.admin.verProductoCompleto(id);
  }

  @Post('products/:id/pause')
  pausarProducto(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.cambiarEstadoProducto(this.actor(req, actor), id, 'PAUSED', dto.reason);
  }

  @Post('products/:id/reactivate')
  reactivarProducto(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.cambiarEstadoProducto(this.actor(req, actor), id, 'ACTIVE', dto.reason);
  }

  // ─── Órdenes ───────────────────────────────────────────────────────────────

  @Get('orders')
  listarOrdenes(@Query(new ZodValidationPipe(ListaOrdenesSchema)) q: ListaOrdenesDto) {
    return this.admin.listarOrdenes(q);
  }

  @Get('orders/:id')
  verOrden(@Param('id') id: string) {
    return this.admin.verOrdenCompleta(id);
  }

  /** La cronología. La pantalla que justifica el panel entero. */
  @Get('orders/:id/timeline')
  async timelineDeOrden(@Param('id') id: string) {
    return { eventos: await this.timeline.de(id) };
  }

  // ─── Pagos ─────────────────────────────────────────────────────────────────

  @Get('payments')
  listarPagos(@Query(new ZodValidationPipe(ListaPagosSchema)) q: ListaPagosDto) {
    return this.admin.listarPagos(q);
  }

  /**
   * Conciliación manual, con límite bajo.
   *
   * Cada llamada golpea la API de Mercado Pago. Diez por minuto alcanzan de
   * sobra para trabajar un caso y evitan que un click nervioso sobre un pago
   * trabado dispare cien consultas contra el proveedor.
   */
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'admin:reconcile' })
  @Post('payments/:id/reconcile')
  conciliarPago(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.conciliarPago(this.actor(req, actor), id, dto.reason);
  }

  // ─── Devoluciones ──────────────────────────────────────────────────────────

  @Get('refunds')
  listarDevoluciones(
    @Query(new ZodValidationPipe(ListaDevolucionesSchema)) q: ListaDevolucionesDto,
  ) {
    return this.admin.listarDevoluciones(q);
  }

  @RateLimit({ limit: 10, windowSec: 60, bucket: 'admin:refund-retry' })
  @Post('refunds/:id/retry')
  reintentarDevolucion(
    @Req() req: FastifyRequest,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AccionAdminSchema)) dto: AccionAdminDto,
  ) {
    return this.admin.reintentarDevolucion(this.actor(req, actor), id, dto.reason);
  }

  // ─── Webhooks y auditoría ──────────────────────────────────────────────────

  @Get('webhooks')
  listarWebhooks(@Query(new ZodValidationPipe(ListaWebhooksSchema)) q: ListaWebhooksDto) {
    return this.admin.listarWebhooks(q);
  }

  @Get('audit')
  listarAuditoria(@Query(new ZodValidationPipe(ListaAuditoriaSchema)) q: ListaAuditoriaDto) {
    return this.admin.listarAuditoria(q);
  }

  @Get('audit/:entityType/:entityId')
  auditoriaDe(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query(new ZodValidationPipe(PaginaSchema)) q: PaginaDto,
  ) {
    return this.admin.auditoriaDe(entityType, entityId, q);
  }

  /**
   * Quién ejecuta y desde dónde.
   *
   * La IP sale de `ipDelCliente` y no de `req.ip`: detrás de un proxy mal
   * configurado, `req.ip` es el valor que eligió quien llama. Una bitácora con
   * IPs falsificables es peor que una sin IPs — lleva a la conclusión
   * equivocada con confianza.
   */
  private actor(req: FastifyRequest, user: AuthenticatedUser): ActorAdmin {
    return {
      id: user.id,
      ip: ipDelCliente(req),
      userAgent: req.headers['user-agent'] ?? null,
    };
  }
}
