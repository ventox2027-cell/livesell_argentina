import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, RoomServiceClient, WebhookReceiver, type VideoGrant } from 'livekit-server-sdk';

import { env } from '@/config/env.schema';
import { LiveKitUnavailableError } from '@/shared/errors/domain.error';
import { MetricsService } from '@/shared/observability/metrics.service';

export type LiveKitRole = 'broadcaster' | 'viewer';

export interface IssuedToken {
  token: string;
  wsUrl: string;
  roomName: string;
  identity: string;
  role: LiveKitRole;
  expiresAt: string;
  ttlSeconds: number;
}

/**
 * Único punto del sistema que conoce LIVEKIT_API_SECRET.
 *
 * Regla absoluta: el secreto jamás sale del backend. La app Flutter recibe
 * tokens ya firmados, con permisos acotados y vencimiento. Poner las claves en
 * el cliente permitiría a cualquiera crear salas y publicar en las nuestras.
 */
@Injectable()
export class LiveKitService {
  private readonly logger = new Logger(LiveKitService.name);
  private readonly roomService: RoomServiceClient;
  private readonly webhookReceiver: WebhookReceiver;

  constructor(private readonly metrics: MetricsService) {
    this.roomService = new RoomServiceClient(
      env.LIVEKIT_HTTP_URL,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
    this.webhookReceiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  /** URL de señalización que debe usar el cliente. Nunca se hardcodea en Flutter. */
  get wsUrl(): string {
    return env.LIVEKIT_WS_URL;
  }

  /**
   * Emite un token con permisos según el rol.
   *
   * La diferencia entre broadcaster y viewer NO es cosmética: es la garantía de
   * que un espectador no pueda publicar audio ni video en el live de un
   * vendedor. Se aplica en el servidor de LiveKit, así que no depende de que la
   * app se comporte bien.
   */
  async issueToken(params: {
    roomName: string;
    identity: string;
    role: LiveKitRole;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IssuedToken> {
    const { roomName, identity, role, displayName, metadata } = params;

    const ttlSeconds =
      role === 'broadcaster' ? env.LIVEKIT_BROADCASTER_TOKEN_TTL_S : env.LIVEKIT_VIEWER_TOKEN_TTL_S;

    const grant: VideoGrant =
      role === 'broadcaster'
        ? {
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true, // sonda de latencia
            roomCreate: false,    // las salas las crea el backend, no el cliente
            roomAdmin: false,
          }
        : {
            roomJoin: true,
            room: roomName,
            // ⛔ Un viewer NUNCA publica audio ni video.
            canPublish: false,
            canPublishData: false,
            canSubscribe: true,
            roomCreate: false,
            roomAdmin: false,
            hidden: false,
          };

    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity,
      name: displayName ?? identity,
      ttl: ttlSeconds,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    });
    at.addGrant(grant);

    // toJwt() es asíncrono desde livekit-server-sdk v2. Sin el await, lo que
    // viajaría al cliente sería la cadena "[object Promise]".
    const token = await at.toJwt();
    this.metrics.livekitTokenIssued.inc({ role, result: 'ok' });

    // Se registra la EMISIÓN, jamás el token.
    this.logger.log({ roomName, identity, role, ttlSeconds }, 'token de LiveKit emitido');

    return {
      token,
      wsUrl: env.LIVEKIT_WS_URL,
      roomName,
      identity,
      role,
      ttlSeconds,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Crea la sala si no existe. Idempotente: LiveKit devuelve la existente.
   *
   * Se crea desde el backend y no con `roomCreate` en el token para que la
   * configuración (timeouts, máximo de participantes) sea nuestra y no de quien
   * se conecte primero.
   */
  async ensureRoom(roomName: string, opts?: { emptyTimeoutS?: number; maxParticipants?: number }) {
    const stop = this.metrics.livekitApiDuration.startTimer({ operation: 'createRoom' });
    try {
      const room = await this.roomService.createRoom({
        name: roomName,
        // La sala sobrevive un rato sin nadie: cubre la ventana de reconexión
        // del broadcaster sin destruir el estado.
        emptyTimeout: opts?.emptyTimeoutS ?? 300,
        maxParticipants: opts?.maxParticipants ?? 0, // 0 = sin límite propio
      });
      stop({ result: 'ok' });
      return room;
    } catch (err) {
      stop({ result: 'error' });
      this.logger.error({ err, roomName }, 'fallo al crear la sala en LiveKit');
      throw new LiveKitUnavailableError('createRoom', err);
    }
  }

  async listParticipants(roomName: string) {
    const stop = this.metrics.livekitApiDuration.startTimer({ operation: 'listParticipants' });
    try {
      const participants = await this.roomService.listParticipants(roomName);
      stop({ result: 'ok' });
      return participants;
    } catch (err) {
      stop({ result: 'error' });
      throw new LiveKitUnavailableError('listParticipants', err);
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    const stop = this.metrics.livekitApiDuration.startTimer({ operation: 'deleteRoom' });
    try {
      await this.roomService.deleteRoom(roomName);
      stop({ result: 'ok' });
    } catch (err) {
      stop({ result: 'error' });
      // Borrar una sala que ya no existe no es un error que deba propagarse.
      this.logger.warn({ err, roomName }, 'no se pudo borrar la sala (puede que ya no exista)');
    }
  }

  /**
   * Verifica la firma del webhook y devuelve el evento.
   * Lanza si la firma no valida: nunca se procesa un webhook sin verificar.
   */
  async verifyWebhook(rawBody: string, authHeader: string) {
    return this.webhookReceiver.receive(rawBody, authHeader);
  }
}
