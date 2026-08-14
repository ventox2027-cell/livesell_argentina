'use client';

import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Dato, Estado } from '@/components/ui';
import { api, type Pagina, type Pago } from '@/lib/api';
import { fecha, hace, plata } from '@/lib/formato';

/**
 * Pagos.
 *
 * Arranca filtrado por los inciertos, que son los únicos que piden acción: un
 * pago aprobado o rechazado ya está resuelto y no hay nada que hacer con él
 * desde acá.
 */
export default function Pagos() {
  const [estado, setEstado] = useState('UNKNOWN_PENDING_RECONCILIATION');

  const { datos, error, cargando, recargar } = useCarga<Pagina<Pago>>(
    `/api/v1/admin/payments?limit=50${estado ? `&status=${estado}` : ''}`,
    [estado],
  );

  return (
    <Pantalla
      titulo="Pagos"
      descripcion="Los inciertos quedaron sin respuesta del proveedor. Conciliar le pregunta el estado real."
    >
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ width: 320 }}>
          <option value="UNKNOWN_PENDING_RECONCILIATION">Inciertos (sin resolver)</option>
          <option value="PROCESSING">En proceso</option>
          <option value="APPROVED">Aprobados</option>
          <option value="REJECTED">Rechazados</option>
          <option value="">Todos</option>
        </select>
      </div>

      <Tabla
        columnas={[
          'ID',
          'Orden',
          'Estado',
          'Monto',
          'Tarjeta',
          'ID proveedor',
          'Consultado',
          'Acción',
        ]}
        datos={datos}
        error={error}
        cargando={cargando}
        vacio="No hay pagos en este estado."
        fila={(p) => (
          <tr key={p.id}>
            <td>
              <Id valor={p.id} />
            </td>
            <td>
              <Id valor={p.orderId} href={`/ordenes/${p.orderId}`} />
            </td>
            <td>
              <Estado valor={p.estado} />
            </td>
            <td className="num">{plata(p.montoCentavos)}</td>
            <td className="mono">
              <Dato>
                {p.tarjeta ? `${p.tarjeta.marca ?? ''} ****${p.tarjeta.ultimos4 ?? ''}` : ''}
              </Dato>
            </td>
            <td className="mono">
              <Dato>{p.providerPaymentId}</Dato>
            </td>
            <td className="mono" title={fecha(p.ultimaConsultaEl)}>
              {hace(p.ultimaConsultaEl)}
            </td>
            <td>
              {['PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION'].includes(p.estado) && (
                <BotonDeAccion
                  etiqueta="Conciliar"
                  titulo="Conciliar contra Mercado Pago"
                  descripcion="Le pregunta al proveedor cuál fue el resultado real y aplica lo que responda. Misma lógica que el worker; se puede repetir sin riesgo."
                  textoBoton="Conciliar ahora"
                  onConfirmar={async (motivo) => {
                    await api.post(`/api/v1/admin/payments/${p.id}/reconcile`, { reason: motivo });
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
