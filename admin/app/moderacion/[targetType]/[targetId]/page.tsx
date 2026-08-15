'use client';

import { use } from 'react';

import { Pantalla, Tabla, useCarga } from '@/components/pagina';
import { fecha } from '@/lib/formato';

/**
 * La historia de moderación de una cosa.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ES LO QUE SE MIRA ANTE UN RECLAMO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "¿Por qué me ocultaron el producto?" se responde acá: quién lo ocultó, cuándo,
 * por qué, y si alguien lo restauró después.
 *
 * Por eso las acciones de moderación son una tabla y no un booleano en el
 * producto. Con un booleano, un producto oculto y restaurado no tiene historia
 * — y cuando el vendedor reclame, no hay nada que mirar.
 */

interface AccionDeModeracion {
  id: string;
  action: string;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
}

const ACCIONES: Record<string, string> = {
  HIDE: 'Ocultado',
  UNHIDE: 'Restaurado',
  SUSPEND: 'Suspendido',
  UNSUSPEND: 'Reactivado',
  WARN: 'Advertido',
};

export default function Historial({
  params,
}: {
  params: Promise<{ targetType: string; targetId: string }>;
}) {
  const { targetType, targetId } = use(params);

  const { datos, error, cargando } = useCarga<AccionDeModeracion[]>(
    `/api/v1/admin/moderation/history/${targetType}/${targetId}`,
  );

  return (
    <Pantalla titulo="Historial de moderación" descripcion={`${targetType} · ${targetId}`}>
      <Tabla
        columnas={['Cuándo', 'Acción', 'Quién', 'Motivo']}
        datos={datos}
        error={error}
        cargando={cargando}
        fila={(a) => (
          <tr key={a.id}>
            <td className="mono">{fecha(a.createdAt)}</td>
            <td>{ACCIONES[a.action] ?? a.action}</td>
            <td className="mono">
              {/*
                Sin actor = lo hizo el sistema por el umbral de reportes. Es una
                distinción que importa: una acción automática y una decidida por
                una persona no se defienden igual.
              */}
              {a.actorUserId ?? 'automático'}
            </td>
            <td>{a.reason ?? '—'}</td>
          </tr>
        )}
      />
    </Pantalla>
  );
}
