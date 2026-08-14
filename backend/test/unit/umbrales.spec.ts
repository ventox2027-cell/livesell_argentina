import { describe, expect, it } from 'vitest';

import {
  avisoDeOcultamiento,
  motivoQueOculta,
  umbralDe,
} from '@/modules/moderation/umbrales';

/**
 * Cuándo un reporte deja de ser una opinión y pasa a ser una señal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS DOS ERRORES NO CUESTAN LO MISMO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · **Ocultar de más:** un vendedor legítimo pierde su publicación por una
 *     campaña de un competidor. Cuesta una venta y mucha confianza.
 *   · **Ocultar de menos:** algo que no se puede vender sigue publicado. Cuesta
 *     la credibilidad de la plataforma, y a veces plata de alguien.
 *
 * Por eso el umbral depende del motivo, y estos tests fijan esa asimetría.
 */
describe('Umbrales de ocultamiento', () => {
  describe('⛔ Lo grave no espera', () => {
    it('un solo reporte de contenido prohibido alcanza', () => {
      // Vender lo que no se puede vender no admite "esperemos a ver si llegan
      // más".
      expect(motivoQueOculta([{ reason: 'PROHIBIDO', cantidad: 1 }])).toBe('PROHIBIDO');
      expect(motivoQueOculta([{ reason: 'CONTENIDO_SEXUAL', cantidad: 1 }])).toBe(
        'CONTENIDO_SEXUAL',
      );
    });

    it('la violencia necesita dos', () => {
      // Una amenaza la puede reportar quien la recibió; esperar a un tercero
      // sería pedirle que aguante. Pero uno solo también puede ser una pelea.
      expect(motivoQueOculta([{ reason: 'VIOLENCIA', cantidad: 1 }])).toBeNull();
      expect(motivoQueOculta([{ reason: 'VIOLENCIA', cantidad: 2 }])).toBe('VIOLENCIA');
    });
  });

  describe('⛔ Lo dudoso espera a una persona', () => {
    it('un solo reporte de estafa NO baja nada', () => {
      /**
       * "Me pareció sospechoso" es de las cosas que más se reportan mal, y
       * bajarle la publicación a alguien acusándolo de estafa es de lo peor que
       * le podés hacer a un vendedor honesto.
       */
      expect(motivoQueOculta([{ reason: 'ESTAFA', cantidad: 1 }])).toBeNull();
      expect(motivoQueOculta([{ reason: 'ESTAFA', cantidad: 2 }])).toBeNull();
      expect(motivoQueOculta([{ reason: 'ESTAFA', cantidad: 3 }])).toBe('ESTAFA');
    });

    it('la falsificación tampoco: suele venir de un competidor', () => {
      expect(motivoQueOculta([{ reason: 'FALSIFICADO', cantidad: 2 }])).toBeNull();
    });

    it('el spam necesita muchos: molesta, no daña', () => {
      expect(motivoQueOculta([{ reason: 'SPAM', cantidad: 4 }])).toBeNull();
      expect(motivoQueOculta([{ reason: 'SPAM', cantidad: 5 }])).toBe('SPAM');
    });

    it('⛔ "otro" NUNCA oculta automáticamente', () => {
      // Si nadie supo en qué categoría ponerlo, una máquina tampoco.
      expect(motivoQueOculta([{ reason: 'OTRO', cantidad: 100 }])).toBeNull();
      expect(umbralDe('OTRO')).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('⛔ Se evalúa por motivo, no sobre el total', () => {
    it('cinco reportes de cinco motivos distintos NO ocultan nada', () => {
      /**
       * Es la diferencia entre ruido y señal. Cinco personas que reportaron por
       * cinco cosas distintas probablemente no coinciden en nada; cinco que
       * reportaron lo mismo, sí.
       */
      expect(
        motivoQueOculta([
          { reason: 'SPAM', cantidad: 1 },
          { reason: 'ENGANOSO', cantidad: 1 },
          { reason: 'FALSIFICADO', cantidad: 1 },
          { reason: 'ESTAFA', cantidad: 1 },
          { reason: 'OTRO', cantidad: 1 },
        ]),
      ).toBeNull();
    });

    it('pero si uno de ellos llega a su umbral, sí', () => {
      expect(
        motivoQueOculta([
          { reason: 'SPAM', cantidad: 2 },
          { reason: 'PROHIBIDO', cantidad: 1 },
        ]),
      ).toBe('PROHIBIDO');
    });

    it('sin reportes no pasa nada', () => {
      expect(motivoQueOculta([])).toBeNull();
    });
  });

  describe('El aviso al vendedor', () => {
    it('⛔ nunca dice quién reportó', () => {
      /**
       * Un vendedor que sabe quién lo reportó puede represaliar: una reseña
       * negativa, un mensaje, cancelarle un pedido. Nadie reportaría dos veces.
       */
      for (const motivo of ['PROHIBIDO', 'ESTAFA', 'SPAM', 'VIOLENCIA'] as const) {
        const texto = avisoDeOcultamiento(motivo);
        expect(texto, motivo).not.toContain('usuario');
        expect(texto, motivo).not.toContain('comprador');
        expect(texto, motivo).not.toContain('reportó');
      }
    });

    it('dice qué pasó y que alguien lo está mirando', () => {
      // Enterarse de que algo desapareció sin explicación es peor que la
      // sanción: el vendedor no sabe qué corregir y vuelve a publicar lo mismo.
      for (const motivo of ['PROHIBIDO', 'CONTENIDO_SEXUAL', 'SPAM', 'OTRO'] as const) {
        const texto = avisoDeOcultamiento(motivo);
        expect(texto, motivo).toContain('Ocultamos');
        expect(texto.toLowerCase(), motivo).toContain('revis');
      }
    });

    it('el motivo grave se nombra; el dudoso, no', () => {
      // "Ocultamos por contenido prohibido" es información accionable.
      // "Ocultamos por reportes de estafa" es una acusación antes de revisar.
      expect(avisoDeOcultamiento('PROHIBIDO')).toContain('no se puede vender');
      expect(avisoDeOcultamiento('ESTAFA')).not.toContain('estafa');
    });
  });
});
