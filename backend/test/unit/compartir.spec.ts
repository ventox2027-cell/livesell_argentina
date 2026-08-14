import { describe, expect, it } from 'vitest';

import { mensajeDeCompartido, urlDe } from '@/modules/social/compartir';

/**
 * Los enlaces que la gente manda por WhatsApp.
 *
 * Un enlace compartido sobrevive a la versión de la app que lo generó: alguien
 * lo manda hoy y lo abren en seis meses. Estos tests fijan el formato, porque
 * cambiarlo rompe todos los que están dando vueltas en chats.
 */
describe('Enlaces para compartir', () => {
  const BASE = 'https://vendox.com.ar';

  it('el formato de cada tipo', () => {
    expect(urlDe(BASE, 'live', 'liv_123')).toBe('https://vendox.com.ar/v/liv_123');
    expect(urlDe(BASE, 'product', 'prd_123')).toBe('https://vendox.com.ar/p/prd_123');
    expect(urlDe(BASE, 'store', 'tejidos-marta')).toBe('https://vendox.com.ar/t/tejidos-marta');
    expect(urlDe(BASE, 'seller', 'marta')).toBe('https://vendox.com.ar/u/marta');
  });

  it('la barra final sobrante no duplica', () => {
    // Funciona igual, pero se ve mal pegado en un chat y algunos
    // previsualizadores lo tratan como una URL distinta.
    expect(urlDe('https://vendox.com.ar/', 'product', 'prd_1')).toBe(
      'https://vendox.com.ar/p/prd_1',
    );
    expect(urlDe('https://vendox.com.ar///', 'product', 'prd_1')).toBe(
      'https://vendox.com.ar/p/prd_1',
    );
  });

  it('el origen viaja como parámetro', () => {
    // Sirve para responder "¿la gente que llega por un enlace compartido
    // compra?", que es lo que dice si vale la pena invertir en compartir.
    expect(urlDe(BASE, 'product', 'prd_1', 'live')).toBe(
      'https://vendox.com.ar/p/prd_1?src=live',
    );
  });

  it('un identificador con caracteres raros se escapa', () => {
    // Un slug no debería tenerlos, pero un id que venga de otro lado sí puede,
    // y una URL rota se comparte igual y no funciona para nadie.
    expect(urlDe(BASE, 'store', 'la tienda/rara')).toBe(
      'https://vendox.com.ar/t/la%20tienda%2Frara',
    );
  });

  describe('El mensaje', () => {
    it('⛔ la URL va ÚLTIMA', () => {
      /**
       * WhatsApp y la mayoría de las apps previsualizan el último enlace del
       * mensaje. Con la URL en el medio, la previsualización a veces no
       * aparece — y un mensaje compartido sin imagen se abre muchísimo menos.
       */
      const m = mensajeDeCompartido({
        baseUrl: BASE,
        cosa: 'product',
        identificador: 'prd_1',
        titulo: 'Buzo oversize',
        precio: '$8.900',
      });

      expect(m.texto.endsWith(m.url)).toBe(true);
    });

    it('el producto lleva el precio', () => {
      const m = mensajeDeCompartido({
        baseUrl: BASE,
        cosa: 'product',
        identificador: 'prd_1',
        titulo: 'Buzo oversize',
        precio: '$8.900',
      });
      expect(m.texto).toContain('Buzo oversize — $8.900 en VendoX');
    });

    it('sin precio no dice "undefined"', () => {
      const m = mensajeDeCompartido({
        baseUrl: BASE,
        cosa: 'product',
        identificador: 'prd_1',
        titulo: 'Buzo oversize',
      });
      expect(m.texto).not.toContain('undefined');
      expect(m.texto).toContain('Buzo oversize en VendoX');
    });

    it('el vivo habla en presente', () => {
      // Un vivo se comparte mientras pasa: "está en vivo ahora" es lo que hace
      // que alguien lo abra en el momento.
      const m = mensajeDeCompartido({
        baseUrl: BASE,
        cosa: 'live',
        identificador: 'liv_1',
        titulo: 'Tejidos Marta',
      });
      expect(m.texto).toContain('está en vivo ahora');
    });

    it('la tienda invita a mirar', () => {
      const m = mensajeDeCompartido({
        baseUrl: BASE,
        cosa: 'store',
        identificador: 'tejidos-marta',
        titulo: 'Tejidos Marta',
      });
      expect(m.texto).toContain('Mirá lo que vende Tejidos Marta');
    });
  });
});
