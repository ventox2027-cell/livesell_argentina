import { describe, expect, it } from 'vitest';

import {
  CATEGORIAS_QUE_SIEMPRE_ESCALAN,
  MAX_VUELTAS_AUTOMATICAS,
  decidirEscalada,
  normalizar,
  respuestaProhibida,
  sugerirCategoria,
} from '@/modules/support/escalada';

/**
 * Cuándo el asistente automático se calla y llama a una persona.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL COSTO DE LOS DOS ERRORES NO ES EL MISMO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Escalar de más cuesta unos minutos del equipo. No escalar cuando hacía falta
 * puede costar una promesa que después hay que romper, o una respuesta
 * automática sobre plata de alguien.
 *
 * Todos estos tests están escritos con esa asimetría en la cabeza: lo que se
 * verifica no es que acierte siempre, es que **cuando duda, escale**.
 */
describe('Escalada a una persona', () => {
  const base = { categoria: 'ENVIO' as const, mensaje: 'hola', vueltasPrevias: 0 };

  describe('⛔ La plata siempre va a una persona', () => {
    it('las categorías sensibles escalan aunque el mensaje sea inofensivo', () => {
      for (const categoria of CATEGORIAS_QUE_SIEMPRE_ESCALAN) {
        const d = decidirEscalada({ ...base, categoria, mensaje: 'hola, buenas tardes' });
        expect(d.escalar, categoria).toBe(true);
        expect(d.motivo).toBe('categoria_sensible');
      }
    });

    it('pagos y disputa están en la lista', () => {
      // El test que rompe si alguien "optimiza" la lista para que la IA
      // conteste más. Sacar PAGOS de acá es una decisión de negocio, no una
      // mejora de cobertura.
      expect(CATEGORIAS_QUE_SIEMPRE_ESCALAN).toContain('PAGOS');
      expect(CATEGORIAS_QUE_SIEMPRE_ESCALAN).toContain('DISPUTA');
    });

    it('una palabra de plata escala aunque la categoría no lo exija', () => {
      const d = decidirEscalada({
        ...base,
        categoria: 'ENVIO',
        mensaje: 'no me llegó y quiero un reembolso',
      });
      expect(d.escalar).toBe(true);
      expect(d.motivo).toBe('palabra_sensible');
    });

    it('las vías formales escalan', () => {
      for (const mensaje of [
        'voy a ir a defensa del consumidor',
        'esto lo ve mi abogado',
        'quiero hacer una denuncia',
      ]) {
        expect(decidirEscalada({ ...base, mensaje }).escalar, mensaje).toBe(true);
      }
    });

    it('funciona sin acentos y en mayúsculas', () => {
      // Alguien escribiendo desde el teléfono no usa acentos. Que la escalada
      // dependa del teclado sería absurdo.
      for (const mensaje of ['quiero mi REEMBOLSO', 'quiero mi reembolso', 'Quiero mi Reembolso']) {
        expect(decidirEscalada({ ...base, mensaje }).escalar, mensaje).toBe(true);
      }
    });
  });

  describe('Pedir una persona siempre se respeta', () => {
    it('sin excepciones y sin insistir', () => {
      /**
       * Un asistente que insiste después de que le pidieron un humano es la
       * peor experiencia de soporte que existe, y encima suele terminar en el
       * humano igual, con la persona ya enojada.
       */
      for (const mensaje of [
        'quiero hablar con una persona',
        'necesito hablar con alguien',
        'atencion humana por favor',
        'dame un humano',
        'quiero una persona real',
      ]) {
        const d = decidirEscalada({ ...base, mensaje });
        expect(d.escalar, mensaje).toBe(true);
        expect(d.motivo).toBe('lo_pidio_la_persona');
      }
    });

    it('el aviso no intenta convencer de nada', () => {
      const d = decidirEscalada({ ...base, mensaje: 'quiero hablar con una persona' });
      expect(d.aviso).not.toContain('puedo ayudarte');
      expect(d.aviso).not.toContain('¿estás seguro');
    });
  });

  describe('Demasiadas vueltas', () => {
    it('después del límite va una persona', () => {
      // Si en cuatro respuestas no se resolvió, no se resuelve en la quinta:
      // lo que hay es alguien cada vez más frustrado hablándole a una máquina.
      const d = decidirEscalada({ ...base, vueltasPrevias: MAX_VUELTAS_AUTOMATICAS });
      expect(d.escalar).toBe(true);
      expect(d.motivo).toBe('demasiadas_vueltas');
    });

    it('antes del límite, no', () => {
      for (let v = 0; v < MAX_VUELTAS_AUTOMATICAS; v += 1) {
        expect(decidirEscalada({ ...base, vueltasPrevias: v }).escalar, `vuelta ${v}`).toBe(false);
      }
    });
  });

  describe('Lo que sí puede contestar', () => {
    it('una consulta común de envío no escala', () => {
      expect(
        decidirEscalada({ ...base, categoria: 'ENVIO', mensaje: '¿cuándo llega mi pedido?' })
          .escalar,
      ).toBe(false);
    });

    it('una consulta de cómo vender tampoco', () => {
      expect(
        decidirEscalada({ ...base, categoria: 'VENDEDOR', mensaje: '¿cómo hago un vivo?' })
          .escalar,
      ).toBe(false);
    });
  });

  describe('⛔ Respuestas prohibidas', () => {
    it('el asistente no puede prometer plata', () => {
      /**
       * Es la red, no la defensa principal. Si dispara, la respuesta NO se
       * manda y el ticket escala: es preferible que alguien espere veinte
       * minutos a que reciba una promesa que después hay que romper.
       */
      for (const respuesta of [
        'Ya te devolvemos el dinero.',
        'Te vamos a devolver todo.',
        'Te doy un cupón por la molestia.',
        'Garantizo que llega mañana.',
        'Te aseguro que se soluciona hoy.',
      ]) {
        expect(respuestaProhibida(respuesta), respuesta).toBe(true);
      }
    });

    it('no puede decir que hizo algo que no puede hacer', () => {
      expect(respuestaProhibida('Ya cancelé tu pedido.')).toBe(true);
    });

    it('una respuesta normal no dispara', () => {
      for (const respuesta of [
        'Tu pedido está en camino. Podés ver el estado en Mis pedidos.',
        'El vendedor tiene 30 días para cambios. Te dejo cómo pedirlo.',
        'Para hacer un vivo, entrá a Mi tienda y tocá Iniciar LIVE.',
      ]) {
        expect(respuestaProhibida(respuesta), respuesta).toBe(false);
      }
    });
  });

  describe('Sugerir categoría', () => {
    it('ante la duda, elige la que escala', () => {
      // Un mensaje que habla de un envío Y de un cobro tiene que caer del lado
      // seguro: mejor que lo mire una persona.
      expect(sugerirCategoria('no me llegó el pedido y me cobraron igual')).toBe('PAGOS');
    });

    it('reconoce las consultas comunes', () => {
      expect(sugerirCategoria('¿cuándo llega mi paquete?')).toBe('ENVIO');
      expect(sugerirCategoria('quiero cambiar el talle')).toBe('CAMBIOS');
      expect(sugerirCategoria('no puedo entrar a mi cuenta')).toBe('CUENTA');
      expect(sugerirCategoria('cómo publico un producto')).toBe('VENDEDOR');
      expect(sugerirCategoria('la app se cierra sola')).toBe('PROBLEMA_TECNICO');
    });

    it('lo que no reconoce cae en OTRO, no en una categoría inventada', () => {
      expect(sugerirCategoria('hola qué tal')).toBe('OTRO');
    });
  });

  describe('Normalizar', () => {
    it('saca acentos y baja a minúsculas', () => {
      expect(normalizar('DEVOLUCIÓN')).toBe('devolucion');
      expect(normalizar('Envío Ñandú')).toBe('envio nandu');
    });
  });
});
