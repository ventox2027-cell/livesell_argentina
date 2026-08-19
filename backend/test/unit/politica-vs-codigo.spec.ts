import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sinValoresDeConsulta } from '@/shared/observability/logger.config';

/**
 * Lo que la política promete tiene que ser lo que el código hace.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES UN TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una política de privacidad es un compromiso público. Cuando el código cambia
 * y la página no, no falla nada: la app anda igual, los tests pasan, y la
 * diferencia sólo aparece si alguien la audita — Google Play antes de publicar,
 * o la Agencia de Acceso a la Información Pública después de un reclamo.
 *
 * La auditoría que originó estos tests encontró cuatro afirmaciones publicadas
 * que el código no cumplía. Ninguna era mentira intencional; las cuatro eran
 * cosas que en algún momento fueron ciertas o que se dieron por hechas.
 */
const WEB = join(process.cwd(), 'web');

const privacidad = readFileSync(join(WEB, 'privacidad', 'index.html'), 'utf8');
const eliminar = readFileSync(join(WEB, 'eliminar-cuenta', 'index.html'), 'utf8');

describe('Los plazos legales que se publican son los que corresponden', () => {
  /**
   * ⛔ SUPRESIÓN: CINCO DÍAS HÁBILES, NO DIEZ CORRIDOS.
   *
   * La Ley 25.326 tiene DOS plazos distintos y la página usaba uno solo:
   *
   *   · art. 14 — derecho de ACCESO: 10 días corridos.
   *   · art. 16 — RECTIFICACIÓN, ACTUALIZACIÓN o SUPRESIÓN: 5 días hábiles.
   *
   * Eliminar una cuenta es supresión. La página prometía diez días corridos
   * para algo que la ley resuelve en cinco hábiles: publicar un plazo más
   * largo que el legal es incumplimiento, no prudencia.
   */
  it('⛔ la eliminación por correo promete 5 días hábiles', () => {
    expect(eliminar).toContain('5 días hábiles');
    expect(eliminar).not.toContain('10 días corridos');
  });

  /**
   * ⛔ Y el acceso conserva su plazo, que es otro.
   *
   * Unificar los dos en «5 días hábiles» sería el error simétrico: prometer
   * para el acceso un plazo más corto del que la ley da, y quedar en falta por
   * exceso de optimismo.
   */
  it('⛔ la política distingue el plazo de acceso del de supresión', () => {
    expect(privacidad).toContain('5 días hábiles');
    expect(privacidad).toContain('10 días corridos');
    expect(privacidad).toMatch(/art[íi]culo 16|art\. 16/i);
  });
});

describe('Las búsquedas no quedan registradas', () => {
  /**
   * ⛔ EL HISTORIAL DE BÚSQUEDA QUE NADIE VEÍA.
   *
   * No hay tabla de búsquedas —eso siempre fue cierto— pero el término viaja
   * en la cadena de consulta y el registro de peticiones guardaba la URL
   * entera. Un `grep` sobre los logs de la plataforma devolvía qué buscó cada
   * persona y cuándo.
   */
  it('⛔ el término de búsqueda no llega al registro', () => {
    const url = sinValoresDeConsulta('/api/v1/discover/products?q=regalo+para+mi+novia&limit=20');

    expect(url).not.toContain('regalo');
    expect(url).not.toContain('novia');
  });

  /// Los NOMBRES sí quedan: es lo que sirve para diagnosticar.
  it('conserva la ruta y los nombres de los parámetros', () => {
    expect(sinValoresDeConsulta('/api/v1/discover/products?q=algo&limit=20&cursor=abc')).toBe(
      '/api/v1/discover/products?q&limit&cursor',
    );
  });

  it('una URL sin consulta no se toca', () => {
    expect(sinValoresDeConsulta('/api/v1/categories')).toBe('/api/v1/categories');
  });

  it('aguanta las formas raras sin romperse', () => {
    expect(sinValoresDeConsulta('/x?')).toBe('/x');
    expect(sinValoresDeConsulta('/x?=solo-valor')).toBe('/x');
    expect(sinValoresDeConsulta('/x?bandera')).toBe('/x?bandera');
    expect(sinValoresDeConsulta(undefined)).toBeUndefined();
  });

  /**
   * ⛔ Un valor con `=` adentro no se filtra por el segundo signo.
   *
   * Un término en base64 o una URL como parámetro llevan `=`. Cortar por el
   * último dejaría pasar el principio del valor.
   */
  it('⛔ corta por el primer = y no por el último', () => {
    expect(sinValoresDeConsulta('/x?token=abc=def=ghi')).toBe('/x?token');
  });
});

describe('La política no promete cosas que el código no hace', () => {
  /**
   * ⛔ El correo no se usa para avisar de los pedidos.
   *
   * No hay proveedor de correo instalado, ni canal de correo en las
   * notificaciones: `NotificationPushStatus` es lo único que existe y va por
   * FCM. La página decía que el correo servía «para avisarte de tus pedidos».
   *
   * Este test falla si alguien vuelve a escribirlo sin haber conectado antes
   * un proveedor de correo.
   */
  it('⛔ no dice que el correo sirva para avisar de los pedidos', () => {
    expect(privacidad).not.toMatch(/correo[^<]{0,40}avisarte de tus pedidos/i);
  });

  /**
   * ⛔ Los proveedores que tienen TODOS los datos están nombrados.
   *
   * La tabla de «con quién compartimos» listaba a Mercado Pago, Google,
   * Firebase, LiveKit y Cloudflare, y no a quien hospeda el servidor ni a
   * quien guarda la base. Son los que más datos ven, y están fuera del país.
   */
  it.each(['Railway', 'Neon', 'Upstash'])('⛔ %s está declarado como proveedor', (proveedor) => {
    expect(privacidad).toContain(proveedor);
  });
});
