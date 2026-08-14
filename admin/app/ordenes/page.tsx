'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { Estado } from '@/components/ui';
import type { Orden, Pagina } from '@/lib/api';
import { fecha, plata } from '@/lib/formato';

const ESTADOS = [
  '',
  'PENDING_PAYMENT',
  'PROCESSING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'PREPARING',
  'READY_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
  'PAYMENT_FAILED',
  'PAYMENT_REQUIRES_REFUND',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

function Lista() {
  const params = useSearchParams();
  const [estado, setEstado] = useState(params.get('status') ?? '');

  const { datos, error, cargando } = useCarga<Pagina<Orden>>(
    `/api/v1/admin/orders?limit=50${estado ? `&status=${estado}` : ''}`,
    [estado],
  );

  return (
    <Pantalla titulo="Órdenes">
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ width: 300 }}>
          {ESTADOS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'Todos los estados' : s}
            </option>
          ))}
        </select>
      </div>

      <Tabla
        columnas={['ID', 'Referencia', 'Estado', 'Total', 'Comprador', 'Vendedor', 'Creada']}
        datos={datos}
        error={error}
        cargando={cargando}
        fila={(o) => (
          <tr key={o.id}>
            <td>
              <Id valor={o.id} href={`/ordenes/${o.id}`} />
            </td>
            <td className="mono">{o.referencia}</td>
            <td>
              <Estado valor={o.estado} />
            </td>
            <td className="num">{plata(o.dinero.total)}</td>
            <td>
              <Id valor={o.buyerId} href={`/usuarios/${o.buyerId}`} />
            </td>
            <td>
              <Id valor={o.sellerId} href={`/vendedores/${o.sellerId}`} />
            </td>
            <td className="mono">{fecha(o.creadaEl)}</td>
          </tr>
        )}
      />
    </Pantalla>
  );
}

export default function Ordenes() {
  // `useSearchParams` necesita un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<main className="contenido" />}>
      <Lista />
    </Suspense>
  );
}
