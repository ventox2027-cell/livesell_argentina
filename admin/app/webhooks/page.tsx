'use client';

import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { Dato, Estado } from '@/components/ui';
import type { Pagina, Webhook } from '@/lib/api';
import { fecha, hace } from '@/lib/formato';

/**
 * Webhooks recibidos.
 *
 * ⚠️ No se muestra ni el cuerpo ni las cabeceras. Las cabeceras traen la firma
 * del proveedor; el cuerpo de un webhook de Mercado Pago trae el objeto de pago
 * con datos del pagador. Para operar alcanza con saber si la firma era válida,
 * si se procesó y con qué recurso.
 *
 * Una firma inválida no es un error del sistema: es alguien mandando
 * notificaciones falsas a nuestra URL pública, que es exactamente por lo que
 * verificamos la firma. Se marca en rojo para que se vea, no porque haya algo
 * que arreglar.
 */
export default function Webhooks() {
  const [procesado, setProcesado] = useState('');

  const { datos, error, cargando } = useCarga<Pagina<Webhook>>(
    `/api/v1/admin/webhooks?limit=50${procesado ? `&processed=${procesado}` : ''}`,
    [procesado],
  );

  return (
    <Pantalla
      titulo="Webhooks"
      descripcion="Notificaciones de Mercado Pago. El cuerpo no se muestra: trae datos del pagador."
    >
      <div className="acciones">
        <select
          value={procesado}
          onChange={(e) => setProcesado(e.target.value)}
          style={{ width: 240 }}
        >
          <option value="">Todos</option>
          <option value="false">Sin procesar</option>
          <option value="true">Procesados</option>
        </select>
      </div>

      <Tabla
        columnas={['ID', 'Tema', 'Recurso', 'Firma', 'Procesado', 'Error', 'Recibido']}
        datos={datos}
        error={error}
        cargando={cargando}
        vacio="No llegó ningún webhook todavía."
        fila={(w) => (
          <tr key={w.id}>
            <td>
              <Id valor={w.id} />
            </td>
            <td className="mono">
              {w.tema}
              {w.accion ? `.${w.accion}` : ''}
            </td>
            <td className="mono">
              <Dato>{w.recursoId}</Dato>
            </td>
            <td>
              <Estado valor={w.firmaValida ? 'ACTIVE' : 'FAILED'} />
              <span style={{ marginLeft: 6 }}>{w.firmaValida ? 'válida' : 'inválida'}</span>
            </td>
            <td className="mono">{w.procesadoEl ? fecha(w.procesadoEl) : 'no'}</td>
            <td style={{ color: w.error ? 'var(--error)' : undefined }}>
              <Dato>{w.error}</Dato>
            </td>
            <td className="mono" title={fecha(w.recibidoEl)}>
              {hace(w.recibidoEl)}
            </td>
          </tr>
        )}
      />
    </Pantalla>
  );
}
