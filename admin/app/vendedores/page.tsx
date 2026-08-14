'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { Estado } from '@/components/ui';
import type { Pagina, Vendedor } from '@/lib/api';
import { fecha } from '@/lib/formato';

function Lista() {
  const params = useSearchParams();
  const [estado, setEstado] = useState(params.get('status') ?? '');

  const { datos, error, cargando } = useCarga<Pagina<Vendedor>>(
    `/api/v1/admin/sellers?limit=50${estado ? `&status=${estado}` : ''}`,
    [estado],
  );

  return (
    <Pantalla titulo="Vendedores">
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ width: 260 }}>
          <option value="">Todos</option>
          <option value="PENDING">Sin revisar</option>
          <option value="ACTIVE">Activos</option>
          <option value="SUSPENDED">Suspendidos</option>
          <option value="BLOCKED">Bloqueados</option>
          <option value="CLOSED">Cerrados</option>
        </select>
      </div>

      <Tabla
        columnas={['ID', 'Nombre', 'Estado', 'Verificación', 'Alta']}
        datos={datos}
        error={error}
        cargando={cargando}
        fila={(s) => (
          <tr key={s.id}>
            <td>
              <Id valor={s.id} href={`/vendedores/${s.id}`} />
            </td>
            <td>{s.nombre}</td>
            <td>
              <Estado valor={s.estado} />
            </td>
            <td>
              <Estado valor={s.verificacion} />
            </td>
            <td className="mono">{fecha(s.creadoEl)}</td>
          </tr>
        )}
      />
    </Pantalla>
  );
}

export default function Vendedores() {
  return (
    <Suspense fallback={<main className="contenido" />}>
      <Lista />
    </Suspense>
  );
}
