'use client';

import Link from 'next/link';

import { Pantalla, useCarga } from '@/components/pagina';
import { Error as CajaError } from '@/components/ui';
import type { Atencion } from '@/lib/api';

/**
 * Inicio: qué necesita atención.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIETE NÚMEROS, NINGÚN GRÁFICO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Esto no es un tablero para mirar cómo va el negocio. Cada número de acá
 * corresponde a **algo que alguien tiene que hacer**, y cuando todos están en
 * cero la pantalla lo dice en una línea y listo.
 *
 * Un gráfico de ventas por hora sería más lindo y no cambiaría ninguna
 * decisión: quien abre esta herramienta ya sabe que algo pasó, y viene a
 * encontrar qué. La pregunta que responde el inicio es "¿hay algo roto?", no
 * "¿cómo venimos?".
 *
 * Los tres primeros son los urgentes —plata de gente real trabada— y se marcan
 * distinto sólo cuando son mayores que cero: un panel donde todo está siempre
 * rojo enseña a ignorar el rojo.
 */

const TARJETAS: Array<{
  clave: keyof Atencion;
  titulo: string;
  href: string;
  urgente?: boolean;
}> = [
  { clave: 'pagosInciertos', titulo: 'Pagos por conciliar', href: '/pagos', urgente: true },
  {
    clave: 'ordenesPorDevolver',
    titulo: 'Órdenes cobradas sin stock',
    href: '/ordenes?status=PAYMENT_REQUIRES_REFUND',
    urgente: true,
  },
  {
    clave: 'devolucionesFallidas',
    titulo: 'Devoluciones fallidas',
    href: '/devoluciones?status=FAILED',
    urgente: true,
  },
  {
    clave: 'devolucionesPendientes',
    titulo: 'Devoluciones en curso',
    href: '/devoluciones?status=PENDING',
  },
  { clave: 'webhooksConError', titulo: 'Webhooks con error', href: '/webhooks' },
  {
    clave: 'vendedoresPendientes',
    titulo: 'Vendedores sin revisar',
    href: '/vendedores?status=PENDING',
  },
  {
    clave: 'vendedoresSuspendidos',
    titulo: 'Vendedores suspendidos',
    href: '/vendedores?status=SUSPENDED',
  },
];

export default function Inicio() {
  const { datos, error, cargando } = useCarga<Atencion>('/api/v1/admin/attention');

  const todoEnCero = datos && Object.values(datos).every((n) => n === 0);

  return (
    <Pantalla titulo="Atención" descripcion="Lo que hay que resolver ahora.">
      <CajaError error={error} />

      {cargando && !datos && <p className="sub">Cargando…</p>}

      {todoEnCero && (
        <div className="panel">
          <strong style={{ color: 'var(--ok)' }}>No hay nada pendiente.</strong>
          <p style={{ margin: '4px 0 0', color: 'var(--texto-2)' }}>
            Ningún pago trabado, ninguna devolución fallida, ningún webhook con error.
          </p>
        </div>
      )}

      {datos && !todoEnCero && (
        <div className="tarjetas">
          {TARJETAS.map((t) => {
            const n = datos[t.clave];
            return (
              <Link
                key={t.clave}
                href={t.href}
                className={`tarjeta ${t.urgente && n > 0 ? 'urgente' : ''}`}
              >
                <div className="n">{n}</div>
                <div className="t">{t.titulo}</div>
              </Link>
            );
          })}
        </div>
      )}

      <h2>Cómo se usa esto</h2>
      <div className="panel">
        <p style={{ margin: 0, color: 'var(--texto-2)' }}>
          Si alguien te escribe con un problema, empezá por{' '}
          <Link href="/buscar">Búsqueda</Link>. Pegá lo que tengas —el mail, el número de
          pedido, el id de Mercado Pago del resumen de la tarjeta— y el panel se da cuenta
          de qué es.
        </p>
        <p style={{ margin: '10px 0 0', color: 'var(--texto-2)' }}>
          Desde la orden, la <strong>cronología</strong> cuenta qué pasó en orden: cuándo
          se creó, qué intentos de cobro hubo, qué respondió Mercado Pago, cuándo llegaron
          los webhooks y si alguien de soporte ya la tocó.
        </p>
      </div>
    </Pantalla>
  );
}
