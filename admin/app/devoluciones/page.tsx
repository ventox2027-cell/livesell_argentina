'use client';

import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Dato, Estado } from '@/components/ui';
import { api, type Devolucion, type Pagina } from '@/lib/api';
import { fecha, plata } from '@/lib/formato';

export default function Devoluciones() {
  const [estado, setEstado] = useState('FAILED');

  const { datos, error, cargando, recargar } = useCarga<Pagina<Devolucion>>(
    `/api/v1/admin/refunds?limit=50${estado ? `&status=${estado}` : ''}`,
    [estado],
  );

  return (
    <Pantalla
      titulo="Devoluciones"
      descripcion="El monto lo determinó el sistema al crear la devolución. Desde acá sólo se reintenta."
    >
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ width: 280 }}>
          <option value="FAILED">Fallidas</option>
          <option value="PENDING">Pendientes</option>
          <option value="PROCESSING">En proceso</option>
          <option value="COMPLETED">Completadas</option>
          <option value="">Todas</option>
        </select>
      </div>

      <Tabla
        columnas={[
          'ID',
          'Orden',
          'Estado',
          'Monto',
          'Motivo',
          'Intentos',
          'Último error',
          'Creada',
          'Acción',
        ]}
        datos={datos}
        error={error}
        cargando={cargando}
        vacio="No hay devoluciones en este estado."
        fila={(d) => (
          <tr key={d.id}>
            <td>
              <Id valor={d.id} />
            </td>
            <td>
              <Id valor={d.orderId} href={`/ordenes/${d.orderId}`} />
            </td>
            <td>
              <Estado valor={d.estado} />
            </td>
            <td className="num">{plata(d.montoCentavos)}</td>
            <td>{d.motivo}</td>
            <td className="num">{d.intentos}</td>
            <td>
              <Dato>{d.ultimoError}</Dato>
            </td>
            <td className="mono">{fecha(d.creadaEl)}</td>
            <td>
              {d.estado !== 'COMPLETED' && (
                <BotonDeAccion
                  etiqueta="Reintentar"
                  titulo="Reintentar la devolución"
                  descripcion="Vuelve a pedirle a Mercado Pago que devuelva el monto ya determinado. No se puede cambiar el importe, y repetirlo no devuelve dos veces."
                  textoBoton="Reintentar"
                  onConfirmar={async (motivo) => {
                    await api.post(`/api/v1/admin/refunds/${d.id}/retry`, { reason: motivo });
                    recargar();
                  }}
                />
              )}
            </td>
          </tr>
        )}
      />
    </Pantalla>
  );
}
