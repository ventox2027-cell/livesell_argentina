import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VISIBILIDAD_POR_DEFECTO } from '@/modules/live/replay';

/**
 * Replay.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTOS TESTS PROTEGEN QUE SIGA APAGADO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `replay.ts` es un archivo de modelos y contratos: no graba nada, no sirve
 * nada, y no hay ningún servicio que lo implemente. Es deliberado — faltan
 * decidir la retención, la visibilidad y qué pasa con los precios viejos.
 *
 * El riesgo real no es que el código esté mal: es que alguien lo prenda «para
 * probar». Estos tests son los que hacen ruido si eso pasa.
 */

const RUTA = join(process.cwd(), 'src/modules/live/replay.ts');
const FUENTE = readFileSync(RUTA, 'utf8');

describe('El replay sigue apagado', () => {
  it('⛔ el archivo no importa NADA', () => {
    /**
     * Un módulo de tipos puros no necesita importar. La primera importación
     * —Prisma, LiveKit, el almacenamiento— es la señal de que dejó de ser un
     * contrato y empezó a hacer algo.
     */
    expect(FUENTE).not.toMatch(/^import /m);
  });

  it('⛔ no hay ninguna clase ni servicio', () => {
    // Un `ReplayService` con métodos que devuelven `null` invita a construir
    // una pantalla encima y descubrir en producción que no hay nada detrás.
    expect(FUENTE).not.toMatch(/\bclass\s+\w/);
    expect(FUENTE).not.toMatch(/@Injectable/);
  });

  it('⛔ ningún módulo de Nest lo registra', () => {
    // Si aparece en un `providers`, alguien lo puede inyectar.
    const modulo = readFileSync(join(process.cwd(), 'src/modules/live/live.module.ts'), 'utf8');
    expect(modulo).not.toMatch(/[Rr]eplay/);
  });
});

describe('La visibilidad por defecto', () => {
  it('⛔ es PRIVADO', () => {
    /**
     * EL TEST QUE IMPORTA.
     *
     * Un vivo es efímero por naturaleza: la gente dice cosas frente a la cámara
     * sabiendo que se van. Un replay que nace público convierte una decisión
     * que el vendedor nunca tomó en algo que ya pasó — y en internet, «ya pasó»
     * no se deshace.
     *
     * Este test se rompe el día que alguien cambie el valor por defecto, que es
     * exactamente cuándo hay que frenar y hablarlo.
     */
    expect(VISIBILIDAD_POR_DEFECTO).toBe('PRIVADO');
  });
});

describe('El modelo', () => {
  it('⛔ no guarda una URL permanente', () => {
    /**
     * Se guarda la CLAVE del objeto; la URL se firma al servir, con vida corta.
     *
     * Una URL permanente en la base es una credencial que se filtra en cada
     * respuesta de la API, en cada log y en cada captura de pantalla de alguien
     * depurando. Es la misma disciplina que ya usan las fotos de producto.
     */
    expect(FUENTE).toMatch(/claveDelArchivo/);
    expect(FUENTE).not.toMatch(/readonly url\b/);
  });

  it('la firma de la URL exige una duración', () => {
    // Sin el parámetro, la implementación más simple es una URL eterna.
    expect(FUENTE).toMatch(/urlFirmada\(claveDelArchivo: string, segundosDeVida: number\)/);
  });

  it('⛔ el producto del replay lleva el precio ACTUAL', () => {
    /**
     * No el del vivo. Mostrar «$18.000» tres semanas después, cuando el
     * producto sale $25.000, es publicidad de un precio que ya no existe — y la
     * ley de defensa del consumidor lo trata como tal.
     */
    expect(FUENTE).toMatch(/precioActualCentavos/);
  });
});
