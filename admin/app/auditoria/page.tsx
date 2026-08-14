'use client';

import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import type { Pagina, RegistroAuditoria } from '@/lib/api';
import { fecha } from '@/lib/formato';

/**
 * La bitácora.
 *
 * Sólo lectura, y no por falta de tiempo: **una bitácora que se puede editar no
 * es una bitácora**. Su único valor es que nadie —ni siquiera quien tiene la
 * cuenta más privilegiada— pueda cambiar lo que dice. El backend no tiene
 * endpoint de modificación ni de borrado, y un test lo comprueba.
 *
 * Se muestran el antes y el después crudos. Es la única pantalla del panel
 * donde eso está bien: quien viene acá está investigando algo puntual y
 * necesita el detalle exacto, no un resumen. El servicio de auditoría ya
 * descarta los campos sensibles antes de guardarlos.
 */
export default function Auditoria() {
  const [accion, setAccion] = useState('');

  const { datos, error, cargando } = useCarga<Pagina<RegistroAuditoria>>(
    `/api/v1/admin/audit?limit=50${accion ? `&action=${accion}` : ''}`,
    [accion],
  );

  return (
    <Pantalla
      titulo="Auditoría"
      descripcion="Quién hizo qué, cuándo y por qué. No se puede modificar ni borrar."
    >
      <div className="acciones">
        <input
          value={accion}
          placeholder="Filtrar por acción exacta: admin.seller_suspended"
          onChange={(e) => setAccion(e.target.value)}
          style={{ maxWidth: 420 }}
        />
      </div>

      <Tabla
        columnas={['Fecha', 'Actor', 'Acción', 'Entidad', 'Motivo', 'Cambio']}
        datos={datos}
        error={error}
        cargando={cargando}
        vacio="Sin registros."
        fila={(a) => (
          <tr key={a.id}>
            <td className="mono">{fecha(a.fecha)}</td>
            <td>
              {a.actorId ? (
                <Id valor={a.actorId} href={`/usuarios/${a.actorId}`} />
              ) : (
                <span className="mono">{a.actorTipo}</span>
              )}
            </td>
            <td className="mono">{a.accion}</td>
            <td>
              <span className="mono">{a.entidad}</span>{' '}
              <Id valor={a.entidadId} href={enlaceA(a.entidad, a.entidadId)} />
            </td>
            <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{a.motivo ?? '—'}</td>
            <td className="mono" style={{ whiteSpace: 'normal', maxWidth: 340 }}>
              {resumirCambio(a.antes, a.despues)}
            </td>
          </tr>
        )}
      />
    </Pantalla>
  );
}

function enlaceA(entidad: string, id: string): string | undefined {
  const mapa: Record<string, string> = {
    user: '/usuarios',
    seller: '/vendedores',
    product: '/productos',
    order: '/ordenes',
  };
  return mapa[entidad] ? `${mapa[entidad]}/${id}` : undefined;
}

/**
 * "status: active → suspended" en vez de dos JSON.
 *
 * El servicio de auditoría ya guarda sólo los campos que cambiaron, así que
 * acá alcanza con emparejarlos. Un volcado de dos objetos obliga a compararlos
 * a ojo, que es exactamente lo que este panel existe para evitar.
 */
function resumirCambio(antes: unknown, despues: unknown): string {
  if (!despues || typeof despues !== 'object') return '—';

  const a = (antes ?? {}) as Record<string, unknown>;
  const d = despues as Record<string, unknown>;

  return (
    Object.keys(d)
      .map((k) => (k in a ? `${k}: ${String(a[k])} → ${String(d[k])}` : `${k}: ${String(d[k])}`))
      .join(' · ') || '—'
  );
}
