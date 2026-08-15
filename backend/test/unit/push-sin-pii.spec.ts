import { describe, expect, it } from 'vitest';

import { PushDeConsola } from '@/modules/notifications/push.provider';

/**
 * Lo que aparece en la pantalla bloqueada de un teléfono.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNA NOTIFICACIÓN SE LEE SIN DESBLOQUEAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la única parte del sistema que se muestra a quien tenga el teléfono a la
 * vista: arriba de la mesa, en el colectivo, en manos de otra persona. Todo lo
 * demás está detrás de una sesión.
 *
 * Por eso hay cosas que no pueden ir en un push aunque sean del dueño del
 * teléfono:
 *
 *   · el **código de entrega** — es el secreto que impide que el vendedor
 *     marque entregado sin entregar. En la pantalla bloqueada lo lee
 *     cualquiera que levante el teléfono;
 *   · la **dirección** — quien mira la notificación se entera de dónde vive
 *     quien compró;
 *   · el **documento** y el **teléfono** completos.
 *
 * "Tu pedido cambió de estado" no le sirve a nadie que no sea el dueño, y al
 * dueño le alcanza para saber que tiene que abrir la app.
 */

/** Lo que el proveedor de consola registra cuando "manda" un aviso. */
function loQueSeRegistra(mensaje: {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}) {
  const registrado: unknown[] = [];
  const proveedor = new PushDeConsola();
  // El logger de Nest escribe por consola; se intercepta para inspeccionar.
  (proveedor as unknown as { logger: { log: (x: unknown) => void } }).logger = {
    log: (x) => registrado.push(x),
  };
  void proveedor.enviar(mensaje);
  return JSON.stringify(registrado);
}

describe('El proveedor de consola', () => {
  const mensaje = {
    tokens: ['token-secretisimo-de-un-telefono-real', 'otro-token'],
    title: 'Tu pedido cambió de estado',
    body: 'Entrá para verlo.',
    data: { notificationId: 'ntf_1', type: 'ORDER_SHIPPED' },
  };

  it('⛔ NUNCA registra los tokens', () => {
    /**
     * Un token de push es lo que hace falta para mandarle notificaciones a un
     * teléfono concreto. En un log agregado —que se comparte, se exporta y a
     * veces se pega en un ticket— es la diferencia entre una traza y un canal
     * directo al usuario.
     */
    const salida = loQueSeRegistra(mensaje);

    expect(salida).not.toContain('token-secretisimo');
    expect(salida).not.toContain('otro-token');
    // Pero sí la cantidad, que es lo que sirve para diagnosticar.
    expect(salida).toContain('2');
  });

  it('no dice que envió nada', () => {
    /**
     * `disponible` es `false` a propósito: las filas quedan en `SKIPPED`, no en
     * `SENT`. Marcarlas como enviadas sería mentirle a la base — y después, al
     * conectar Firebase de verdad, nadie sabría cuáles salieron.
     */
    expect(new PushDeConsola().disponible).toBe(false);
  });

  it('devuelve cero entregados y ningún token muerto', async () => {
    const r = await new PushDeConsola().enviar(mensaje);

    expect(r.entregados).toBe(0);
    expect(r.tokensMuertos).toEqual([]);
  });
});

describe('Qué se puede escribir en un push', () => {
  /**
   * Estas comprobaciones son sobre los TEXTOS, no sobre el transporte.
   *
   * Viven acá y no en un test de integración porque la regla es de redacción:
   * quien escriba un aviso nuevo tiene que poder ver, en un archivo corto, qué
   * no puede poner y por qué.
   */

  /** Lo que jamás puede aparecer en el título ni en el cuerpo de un push. */
  const PROHIBIDO: Array<{ nombre: string; ejemplo: RegExp }> = [
    { nombre: 'un código de entrega', ejemplo: /\b\d{6}\b/ },
    { nombre: 'una calle con altura', ejemplo: /\b(av\.?|avenida|calle)\s+\S+\s+\d+/i },
    { nombre: 'un DNI', ejemplo: /\b\d{7,8}\b/ },
    { nombre: 'un teléfono', ejemplo: /\+54\s?9?\s?\d{6,}/ },
  ];

  /**
   * Los avisos que el sistema manda hoy.
   *
   * ⚠️ Escritos a mano y copiados de los servicios que los crean. Si se agrega
   * un aviso nuevo, va acá: es la forma de que la regla se revise cuando se
   * escribe el texto y no seis meses después.
   */
  const AVISOS = [
    { title: 'Ocultamos "Vela aromática"', body: 'Recibimos reportes y lo estamos revisando.' },
    {
      title: '"Vela aromática" volvió a estar visible',
      body: 'Revisamos los reportes y no encontramos problemas. Disculpá la molestia.',
    },
    { title: 'Tejidos Marta volvió a abrir', body: 'Vela aromática está disponible otra vez.' },
    { title: 'Te respondimos tu consulta', body: 'Entrá para ver la respuesta.' },
    { title: 'Tu pedido cambió de estado', body: 'Entrá para verlo.' },
  ];

  for (const { nombre, ejemplo } of PROHIBIDO) {
    it(`⛔ ningún aviso lleva ${nombre}`, () => {
      for (const aviso of AVISOS) {
        const texto = `${aviso.title} ${aviso.body}`;
        expect(ejemplo.test(texto), `"${texto}"`).toBe(false);
      }
    });
  }

  it('todos dicen algo útil sin contar el contenido', () => {
    // Un aviso que no se entiende sin abrir la app está bien; uno que no se
    // entiende ni abriendo la app, no.
    for (const aviso of AVISOS) {
      expect(aviso.title.length, aviso.title).toBeGreaterThan(10);
      expect(aviso.body.length, aviso.body).toBeGreaterThan(10);
    }
  });
});
