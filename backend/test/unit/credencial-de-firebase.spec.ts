import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CredencialDeFirebaseInvalidaError,
  descripcionSegura,
  leerCredencialDeFirebase,
} from '@/modules/notifications/credencial-de-firebase';

/**
 * Cargar la clave de Firebase Admin desde un archivo externo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE ESTÁ PROTEGIENDO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dos cosas distintas:
 *
 *   · **que la clave no se filtre.** Es una clave privada RSA con permiso para
 *     notificar a todos los teléfonos que tengan la app. Ningún mensaje de
 *     error, ni siquiera uno de "JSON roto", puede llevar el contenido adentro:
 *     los errores terminan en los logs;
 *   · **que un despliegue mal configurado se entere.** Un motivo vago —"no se
 *     pudo cargar"— significa media hora buscando, con producción sin avisos.
 */

let carpeta: string;

/**
 * Un `service account` con la forma que descarga la consola de Firebase.
 *
 * Los bytes son basura y no descifran nada. Tiene forma de PEM porque lo que
 * se prueba es justamente que el lector distinga un PEM de algo que no lo es.
 */
// escaner:ok fixture con forma de PEM, contenido inventado
const CLAVE_FALSA =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';

function archivo(nombre: string, contenido: string): string {
  const ruta = join(carpeta, nombre);
  writeFileSync(ruta, contenido, 'utf8');
  return ruta;
}

function serviceAccount(cambios: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'vendox-pruebas',
    private_key_id: 'abc123',
    private_key: CLAVE_FALSA,
    client_email: 'firebase-adminsdk@vendox-pruebas.iam.gserviceaccount.com',
    client_id: '1234567890',
    ...cambios,
  });
}

beforeAll(() => {
  carpeta = mkdtempSync(join(tmpdir(), 'vendox-fcm-'));
});

afterAll(() => {
  rmSync(carpeta, { recursive: true, force: true });
});

describe('Leer la credencial', () => {
  it('lee un service account correcto', () => {
    const c = leerCredencialDeFirebase(archivo('ok.json', serviceAccount()));

    expect(c.projectId).toBe('vendox-pruebas');
    expect(c.clientEmail).toContain('gserviceaccount.com');
    expect(c.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('convierte los saltos de línea escapados', () => {
    /**
     * En el JSON descargado la clave viene con `\n` escapados y `JSON.parse` ya
     * los resuelve. Pero si alguien la pega a mano o la pasa por una
     * herramienta que vuelve a escapar, queda `\\n` y el SDK la rechaza con un
     * error de OpenSSL que no dice nada útil.
     */
    const conEscapes = serviceAccount({
      // escaner:ok el mismo PEM inventado, con los saltos escapados
      private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n',
    });

    const c = leerCredencialDeFirebase(archivo('escapada.json', conEscapes));

    expect(c.privateKey).toContain('\n');
    expect(c.privateKey).not.toContain('\\n');
  });

  it('⛔ exige ruta absoluta', () => {
    /**
     * Una relativa se resuelve contra el directorio de trabajo del proceso, que
     * no es el mismo desde la consola, desde un contenedor o desde un gestor de
     * procesos. Es la clase de diferencia que funciona en la máquina de quien
     * lo configuró y falla en el servidor.
     */
    expect(() => leerCredencialDeFirebase('./firebase-admin.json')).toThrow(
      CredencialDeFirebaseInvalidaError,
    );
  });

  it('⛔ dice que el archivo no existe, no "error desconocido"', () => {
    const ruta = join(carpeta, 'no-esta.json');

    expect(() => leerCredencialDeFirebase(ruta)).toThrow(/no existe/);
    // Y nombra el archivo: quien despliega necesita saber cuál mirar.
    expect(() => leerCredencialDeFirebase(ruta)).toThrow(ruta.replace(/\\/g, '\\'));
  });

  it('⛔ un JSON roto se rechaza SIN mostrar el contenido', () => {
    /**
     * El test que más importa de este archivo.
     *
     * Un JSON con un carácter de más sigue teniendo la clave privada adentro.
     * Si el error la incluyera "para ayudar a diagnosticar", esa clave termina
     * en el log de arranque, que es de los archivos que más gente ve.
     */
    const ruta = archivo('roto.json', `{"private_key": "${CLAVE_FALSA}",,,}`);

    let mensaje = '';
    try {
      leerCredencialDeFirebase(ruta);
    } catch (e) {
      mensaje = (e as Error).message;
    }

    expect(mensaje).toContain('no es un JSON válido');
    expect(mensaje).not.toContain('BEGIN PRIVATE KEY');
    expect(mensaje).not.toContain('MIIEvQ');
  });

  it('⛔ el archivo de configuración web se distingue del service account', () => {
    /**
     * El error real que comete la gente: los dos son JSON, los dos vienen de la
     * consola de Firebase, y sólo uno sirve para el Admin SDK. Un "faltan
     * campos" a secas manda a alguien a revisar la ruta cuando el problema es
     * que descargó el archivo equivocado.
     */
    const configWeb = JSON.stringify({
      apiKey: 'AIzaSyFalsa',
      authDomain: 'vendox.firebaseapp.com',
      projectId: 'vendox-pruebas',
      appId: '1:123:android:abc',
    });

    let mensaje = '';
    try {
      leerCredencialDeFirebase(archivo('config-web.json', configWeb));
    } catch (e) {
      mensaje = (e as Error).message;
    }

    expect(mensaje).toContain('client_email');
    expect(mensaje).toContain('private_key');
    expect(mensaje).toContain('Cuentas de servicio');
  });

  it('⛔ una clave que no es PEM se rechaza', () => {
    const ruta = archivo('sin-pem.json', serviceAccount({ private_key: 'una-cadena-cualquiera' }));

    expect(() => leerCredencialDeFirebase(ruta)).toThrow(/no parece una clave PEM/);
  });

  it('⛔ ningún mensaje de error lleva la clave adentro', () => {
    /**
     * Se recorre cada forma de fallar con un archivo que SÍ tiene la clave.
     * Es la garantía general, no caso por caso: cualquier rama nueva que
     * alguien agregue mañana tiene que seguir cumpliendo.
     */
    const casos = [
      archivo('c1.json', serviceAccount({ project_id: '' })),
      archivo('c2.json', serviceAccount({ client_email: '' })),
      archivo('c3.json', `[${serviceAccount()}]`),
      archivo('c4.json', serviceAccount({ private_key: 'no-pem' })),
    ];

    for (const ruta of casos) {
      let mensaje = '';
      try {
        leerCredencialDeFirebase(ruta);
      } catch (e) {
        mensaje = (e as Error).message;
      }
      expect(mensaje, ruta).not.toContain('BEGIN PRIVATE KEY');
      expect(mensaje, ruta).not.toContain('MIIEvQ');
    }
  });
});

describe('Cómo se habla de la credencial', () => {
  it('sólo salen identificadores públicos', () => {
    /**
     * `project_id` y `client_email` aparecen en la consola de Firebase y en las
     * reglas de IAM: no son secretos y sirven para confirmar en el arranque que
     * se cargó la credencial correcta.
     *
     * La clave privada no aparece **ni recortada**. Una "pista" de una clave
     * RSA no le sirve a nadie para diagnosticar y sí le sirve a quien esté
     * juntando pedazos.
     */
    const c = leerCredencialDeFirebase(archivo('publico.json', serviceAccount()));
    const d = descripcionSegura(c);

    expect(Object.keys(d).sort()).toEqual(['clientEmail', 'projectId']);
    expect(JSON.stringify(d)).not.toContain('PRIVATE KEY');
  });
});
