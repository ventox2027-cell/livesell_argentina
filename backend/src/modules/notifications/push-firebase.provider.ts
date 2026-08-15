import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import { env } from '@/config/env.schema';

import {
  descripcionSegura,
  leerCredencialDeFirebase,
} from './credencial-de-firebase';
import { PushProvider, type MensajePush, type ResultadoPush } from './push.provider';

/**
 * Push de verdad, por Firebase Cloud Messaging.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES FCM HTTP v1, AUNQUE NO SE VEA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El Admin SDK habla HTTP v1 por debajo desde hace varias versiones: la API
 * *legacy* con clave de servidor está discontinuada y Google ya la apagó. Se
 * usa el SDK y no HTTP a mano porque el SDK resuelve la parte molesta —firmar
 * un JWT con la clave de servicio, canjearlo por un token de acceso y
 * renovarlo— y esa es exactamente la parte donde un error propio se paga con
 * notificaciones que no salen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA CREDENCIAL NUNCA ESTÁ EN EL REPOSITORIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Se lee de un archivo fuera del proyecto, cuya ruta viene en
 * `FIREBASE_SERVICE_ACCOUNT_PATH`. Ver `credencial-de-firebase.ts`, que explica
 * por qué un archivo y no una variable con el JSON adentro.
 *
 * ⚠️ El contenido de ese archivo no aparece en ningún log. Lo único que se
 * registra al arrancar es el `project_id` y el `client_email`, que son
 * identificadores públicos y sirven para confirmar que se cargó la credencial
 * correcta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PASA SI FALTA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Depende del entorno, y la diferencia es deliberada:
 *
 *   · en **producción**, el proceso no arranca. Un servidor productivo que
 *     levanta sin poder mandar avisos es un servidor que parece sano mientras
 *     nadie se entera de que le pagaron un pedido;
 *   · en **desarrollo**, se degrada: los avisos quedan en `SKIPPED` y todo lo
 *     demás sigue andando. Nadie tiene que conseguir una clave de Google para
 *     trabajar en el catálogo.
 *
 * La comprobación de producción vive en `env.schema.ts`, que es donde se falla
 * al arrancar. Acá sólo se implementa la degradación.
 */
@Injectable()
export class PushDeFirebase extends PushProvider implements OnModuleDestroy {
  private readonly logger = new Logger(PushDeFirebase.name);

  private app?: App;
  private mensajeria?: Messaging;

  get disponible(): boolean {
    return this.mensajeria !== undefined;
  }

  /**
   * La credencial se lee en el CONSTRUCTOR, no en `onModuleInit`.
   *
   * Nest instancia todos los proveedores antes de llamar a ningún
   * `onModuleInit`, y el módulo elige entre este proveedor y el de consola
   * preguntando `disponible` en una fábrica. Con la carga en `onModuleInit`,
   * esa pregunta se respondía siempre `false` y nunca se usaba Firebase.
   *
   * Leer un archivo de forma síncrona en un constructor no es elegante, pero
   * pasa una sola vez por proceso y es lo que permite fallar en el arranque en
   * vez de con el primer aviso.
   */
  constructor() {
    super();
    this.iniciar();
  }

  private iniciar(): void {
    if (!env.PUSH_ENABLED) {
      this.logger.warn('push apagado por configuración: los avisos quedan en SKIPPED');
      return;
    }

    const ruta = env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!ruta) {
      // En producción no se llega acá: `env.schema` ya falló al arrancar.
      this.logger.warn(
        'sin FIREBASE_SERVICE_ACCOUNT_PATH: los avisos quedan en SKIPPED (sólo desarrollo)',
      );
      return;
    }

    try {
      const credencial = leerCredencialDeFirebase(ruta);

      /**
       * La aplicación se nombra a propósito.
       *
       * `initializeApp()` sin nombre usa la instancia por defecto y falla si ya
       * existe. En los tests se levantan dos aplicaciones Nest en el mismo
       * proceso, y con la instancia por defecto la segunda reventaría con un
       * error que no tiene nada que ver con lo que se está probando.
       */
      this.app = initializeApp(
        {
          credential: cert({
            projectId: credencial.projectId,
            clientEmail: credencial.clientEmail,
            privateKey: credencial.privateKey,
          }),
        },
        `vendox-${process.pid}-${Date.now()}`,
      );
      this.mensajeria = getMessaging(this.app);

      this.logger.log({
        msg: 'Firebase Cloud Messaging listo',
        // ⚠️ Sólo identificadores públicos. Nunca la clave.
        ...descripcionSegura(credencial),
      });
    } catch (err) {
      /**
       * En desarrollo se avisa y se sigue; en producción esto no debería pasar
       * porque `env.schema` ya validó que la credencial se puede leer.
       *
       * Si igual pasara —permisos que cambian entre el arranque y este
       * momento— es mejor un backend que funciona sin push que uno que no
       * levanta: las ventas no dependen de las notificaciones.
       */
      this.logger.error({
        msg: '⚠️ no se pudo iniciar Firebase: los avisos quedan en SKIPPED',
        // El mensaje del error incluye la ruta, no el contenido. Ver
        // `CredencialDeFirebaseInvalidaError`.
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    /**
     * Sin esto el proceso no termina: el SDK deja vivo el cliente de red que
     * renueva el token de acceso.
     *
     * ⚠️ Envuelto en `try` y no sólo con `.catch`: `deleteApp` puede lanzar de
     * forma SÍNCRONA si la aplicación ya se borró —pasa cuando el módulo se
     * destruye dos veces, que es lo normal en una suite de tests— y un
     * `.catch` no atrapa eso. La excepción salía del apagado y hacía fallar el
     * archivo entero con todos sus tests en verde.
     */
    const app = this.app;
    this.app = undefined;
    this.mensajeria = undefined;
    if (!app) return;

    try {
      await deleteApp(app);
    } catch {
      // Ya estaba cerrada. No hay nada que hacer ni nada que reportar.
    }
  }

  /**
   * Manda un aviso a todos los dispositivos de una persona.
   *
   * ─── Por qué se distingue el token muerto del fallo de red ───
   *
   * Un token muerto —app desinstalada, token reciclado— falla para siempre:
   * reintentarlo es gastar envíos y ensuciar las métricas de entrega. Un fallo
   * de red se resuelve solo en el próximo intento.
   *
   * Tratarlos igual lleva a una de dos cosas malas: borrar dispositivos buenos
   * por un corte de dos minutos, o reintentar eternamente apps desinstaladas.
   * FCM los distingue con códigos específicos y acá se respeta esa distinción.
   */
  async enviar(mensaje: MensajePush): Promise<ResultadoPush> {
    const mensajeria = this.mensajeria;
    if (!mensajeria || mensaje.tokens.length === 0) {
      return { entregados: 0, tokensMuertos: [] };
    }

    const respuesta = await mensajeria.sendEachForMulticast({
      tokens: mensaje.tokens,
      notification: { title: mensaje.title, body: mensaje.body },
      data: mensaje.data,
      android: {
        priority: 'high',
        notification: {
          /**
           * Los avisos del mismo pedido se reemplazan entre sí.
           *
           * Sin esto, alguien que compra a la mañana y recibe el pedido a la
           * tarde termina con cinco notificaciones apiladas contando la
           * historia completa. Con `tag`, la última pisa a la anterior y en la
           * barra queda el estado actual.
           */
          tag: mensaje.data.notificationId ?? undefined,
          // Sonido normal. Nada de canales de urgencia para "tu pedido salió".
          channelId: 'vendox_general',
        },
      },
      apns: {
        payload: {
          aps: {
            /**
             * ⚠️ Sin `content-available`: no se despierta la app en segundo
             * plano. Un aviso de VendoX no tiene nada que sincronizar en
             * silencio, y pedir ese permiso gasta batería ajena sin motivo.
             */
            sound: 'default',
            threadId: mensaje.data.type,
          },
        },
      },
    });

    const tokensMuertos: string[] = [];
    respuesta.responses.forEach((r, i) => {
      if (r.success) return;

      const codigo = r.error?.code ?? '';
      /**
       * Los dos códigos que significan "este token ya no existe".
       *
       * `registration-token-not-registered` es la app desinstalada.
       * `invalid-argument` en un envío por token es un token con forma
       * inválida, que tampoco va a funcionar nunca.
       *
       * Cualquier otro —cuota, indisponibilidad, red— es transitorio y el
       * despachador lo reintenta con espera creciente.
       */
      if (
        codigo === 'messaging/registration-token-not-registered' ||
        codigo === 'messaging/invalid-registration-token' ||
        codigo === 'messaging/invalid-argument'
      ) {
        const token = mensaje.tokens[i];
        if (token) tokensMuertos.push(token);
      }
    });

    if (respuesta.failureCount > 0) {
      this.logger.warn({
        msg: 'algunos envíos fallaron',
        // ⚠️ Cantidades y códigos. Nunca los tokens: son la llave para
        // mandarle notificaciones a un teléfono concreto.
        entregados: respuesta.successCount,
        fallidos: respuesta.failureCount,
        muertos: tokensMuertos.length,
        codigos: [
          ...new Set(
            respuesta.responses.filter((r) => !r.success).map((r) => r.error?.code ?? 'sin-codigo'),
          ),
        ],
      });
    }

    return { entregados: respuesta.successCount, tokensMuertos };
  }
}
