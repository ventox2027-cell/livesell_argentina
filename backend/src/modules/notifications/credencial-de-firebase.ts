import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Leer la credencial de Firebase Admin de un archivo, con cuidado.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN ARCHIVO Y NO UNA VARIABLE CON EL JSON ADENTRO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es una clave privada RSA de una cuenta de servicio con permiso para mandarle
 * notificaciones a todos los teléfonos que tengan la app instalada. Metida en
 * una variable de entorno viaja en el `docker inspect`, en el panel del
 * proveedor, en cualquier `printenv` y —lo más común— en el historial del shell
 * de quien la configuró.
 *
 * Un archivo con permisos del sistema operativo, fuera del repositorio, es
 * menos cómodo y bastante más difícil de filtrar sin querer.
 *
 * ⚠️ El contenido de ese archivo NO se registra en ningún log, ni entero ni
 * recortado. Lo único que sale de acá es el `project_id` y el `client_email`,
 * que son identificadores públicos del proyecto: sirven para confirmar que se
 * cargó la credencial correcta sin exponer nada.
 *
 * ─── Módulo puro ───
 *
 * Todo lo que sigue es leer un archivo y validar su forma. Separado del
 * proveedor para poder probar los mensajes de error sin montar Firebase, que
 * es justamente donde importa: un error confuso acá significa un despliegue de
 * producción sin notificaciones y nadie sabiendo por qué.
 */

/** Lo que hace falta de un `service account` de Google. */
export interface CredencialDeFirebase {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export class CredencialDeFirebaseInvalidaError extends Error {
  constructor(motivo: string, ruta: string) {
    /**
     * El mensaje incluye la RUTA, nunca el contenido.
     *
     * Quien lee esto está desplegando y necesita saber qué archivo mirar. La
     * ruta no es un secreto; lo que hay adentro sí.
     */
    super(
      `No se pudo cargar la credencial de Firebase desde ${ruta}: ${motivo}. ` +
        'Revisá FIREBASE_SERVICE_ACCOUNT_PATH.',
    );
    this.name = 'CredencialDeFirebaseInvalidaError';
  }
}

/**
 * Lee y valida el archivo de la cuenta de servicio.
 *
 * Falla ruidosamente y con un motivo distinto para cada caso. La alternativa
 * —devolver `null` y seguir— es la que produce el peor desenlace posible: el
 * proceso arranca, todo parece bien, y las notificaciones no salen durante
 * semanas hasta que alguien pregunta por qué nadie se entera de sus pedidos.
 */
export function leerCredencialDeFirebase(ruta: string): CredencialDeFirebase {
  if (!isAbsolute(ruta)) {
    /**
     * Se exige ruta absoluta.
     *
     * Una relativa se resuelve contra el directorio de trabajo del proceso, que
     * no es el mismo cuando corre desde la consola, desde un contenedor o desde
     * un gestor de procesos. Es la clase de diferencia que hace que funcione en
     * la máquina de quien lo configuró y falle en el servidor.
     */
    throw new CredencialDeFirebaseInvalidaError('la ruta tiene que ser absoluta', ruta);
  }

  let crudo: string;
  try {
    crudo = readFileSync(ruta, 'utf8');
  } catch (err) {
    const codigo = (err as NodeJS.ErrnoException).code;
    const motivo =
      codigo === 'ENOENT'
        ? 'el archivo no existe'
        : codigo === 'EACCES'
          ? 'el proceso no tiene permiso para leerlo'
          : `no se pudo leer (${codigo ?? 'error desconocido'})`;
    throw new CredencialDeFirebaseInvalidaError(motivo, ruta);
  }

  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch {
    // Sin incluir el contenido en el error: un JSON roto igual puede tener la
    // clave privada adentro, y ese error termina en los logs.
    throw new CredencialDeFirebaseInvalidaError('no es un JSON válido', ruta);
  }

  if (typeof json !== 'object' || json === null) {
    throw new CredencialDeFirebaseInvalidaError('el JSON no es un objeto', ruta);
  }

  const o = json as Record<string, unknown>;
  const projectId = typeof o.project_id === 'string' ? o.project_id : '';
  const clientEmail = typeof o.client_email === 'string' ? o.client_email : '';
  const privateKey = typeof o.private_key === 'string' ? o.private_key : '';

  const faltan = [
    projectId ? null : 'project_id',
    clientEmail ? null : 'client_email',
    privateKey ? null : 'private_key',
  ].filter((x): x is string => x !== null);

  if (faltan.length > 0) {
    /**
     * El error nombra los campos que faltan, no los que están.
     *
     * Es la diferencia entre "revisá el archivo" y "descargaste el JSON de
     * configuración web en vez de la clave de la cuenta de servicio", que es
     * el error real que comete la gente: los dos son JSON, los dos vienen de
     * la consola de Firebase, y sólo uno sirve para el Admin SDK.
     */
    throw new CredencialDeFirebaseInvalidaError(
      `faltan campos: ${faltan.join(', ')}. ` +
        'Tiene que ser la clave privada de una cuenta de servicio ' +
        '(Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada), ' +
        'no el archivo de configuración de la app web',
      ruta,
    );
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new CredencialDeFirebaseInvalidaError(
      'private_key no parece una clave PEM',
      ruta,
    );
  }

  return {
    projectId,
    clientEmail,
    /**
     * Los `\n` literales se convierten en saltos de línea reales.
     *
     * En el JSON descargado la clave viene con `\n` escapados, y `JSON.parse`
     * ya los resuelve. Pero si alguien alguna vez pega el contenido a mano o lo
     * pasa por una herramienta que vuelve a escapar, queda `\\n` y el SDK
     * rechaza la clave con un error de OpenSSL que no dice nada útil.
     *
     * Cuesta una línea cubrir los dos casos.
     */
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

/**
 * Cómo hablar de la credencial cargada sin exponerla.
 *
 * `project_id` y `client_email` son identificadores públicos del proyecto: el
 * segundo aparece en la consola de Firebase y en las reglas de IAM. Sirven para
 * confirmar en el arranque que se cargó la credencial correcta.
 *
 * ⛔ La clave privada no aparece acá ni recortada. Una "pista" de una clave RSA
 * no le sirve a nadie para diagnosticar y sí le sirve a quien esté juntando
 * pedazos.
 */
export function descripcionSegura(c: CredencialDeFirebase): {
  projectId: string;
  clientEmail: string;
} {
  return { projectId: c.projectId, clientEmail: c.clientEmail };
}
