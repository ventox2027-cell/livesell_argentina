'use client';

import { use } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Estado } from '@/components/ui';
import { api, type Orden, type Usuario, type Vendedor } from '@/lib/api';
import { fecha, hace, plata } from '@/lib/formato';

interface UsuarioCompleto extends Usuario {
  vendedor: Vendedor | null;
  sesionesActivas: number;
  ordenes: Orden[];
  totalOrdenes: number;
}

export default function DetalleDeUsuario({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { datos: u, error, recargar } = useCarga<UsuarioCompleto>(`/api/v1/admin/users/${id}`);

  async function accion(ruta: string, motivo: string) {
    await api.post(`/api/v1/admin/users/${id}/${ruta}`, { reason: motivo });
    recargar();
  }

  return (
    <Pantalla
      titulo={u ? u.nombre : 'Usuario'}
      descripcion={u ? `${u.rol} · ${u.estado}` : id}
      acciones={
        u && (
          <>
            {u.estado === 'active' && (
              <BotonDeAccion
                etiqueta="Suspender"
                titulo="Suspender cuenta"
                descripcion="La persona pierde el acceso de inmediato y se le cierran todas las sesiones abiertas."
                textoBoton="Suspender"
                peligroso
                onConfirmar={(m) => accion('suspend', m)}
              />
            )}
            {u.estado === 'suspended' && (
              <BotonDeAccion
                etiqueta="Reactivar"
                titulo="Reactivar cuenta"
                descripcion="Devuelve el acceso. Va a tener que volver a iniciar sesión."
                textoBoton="Reactivar"
                onConfirmar={(m) => accion('reactivate', m)}
              />
            )}
            {u.estado !== 'deleted' && (
              <BotonDeAccion
                etiqueta="Cerrar sesiones"
                titulo="Cerrar todas las sesiones"
                descripcion="Cierra la sesión en todos sus dispositivos sin suspender la cuenta. Para cuando alguien reporta un teléfono perdido."
                textoBoton="Cerrar sesiones"
                onConfirmar={(m) => accion('revoke-sessions', m)}
              />
            )}
          </>
        )
      }
    >
      {error != null && <Tabla columnas={[]} datos={null} error={error} fila={() => null} />}

      {u && (
        <>
          <div className="panel">
            <dl className="datos">
              <dt>ID</dt>
              <dd className="mono">{u.id}</dd>
              <dt>Email</dt>
              <dd className="mono">{u.email}</dd>
              <dt>Teléfono</dt>
              <dd className="mono">{u.telefono ?? '—'}</dd>
              <dt>Estado</dt>
              <dd>
                <Estado valor={u.estado} />
              </dd>
              <dt>Sesiones activas</dt>
              <dd>{u.sesionesActivas}</dd>
              <dt>Alta</dt>
              <dd className="mono">{fecha(u.creadoEl)}</dd>
              <dt>Última actividad</dt>
              <dd className="mono">{hace(u.ultimaActividadEl)}</dd>
              {u.vendedor && (
                <>
                  <dt>Vendedor</dt>
                  <dd>
                    {u.vendedor.nombre} · <Estado valor={u.vendedor.estado} /> ·{' '}
                    <Id valor={u.vendedor.id} href={`/vendedores/${u.vendedor.id}`} />
                  </dd>
                </>
              )}
            </dl>
          </div>

          <h2>Compras</h2>
          <Tabla
            columnas={['ID', 'Referencia', 'Estado', 'Total', 'Creada']}
            datos={u.ordenes}
            vacio="Todavía no compró nada."
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
                <td className="mono">{fecha(o.creadaEl)}</td>
              </tr>
            )}
          />

          <h2>Historial administrativo</h2>
          <Auditoria entidad="user" entidadId={u.id} />
        </>
      )}
    </Pantalla>
  );
}

/** Qué le hizo el equipo a esta entidad. Reutilizado en varias pantallas. */
export function Auditoria({ entidad, entidadId }: { entidad: string; entidadId: string }) {
  const { datos, error, cargando } = useCarga<{
    items: Array<{
      id: string;
      accion: string;
      actorId: string | null;
      motivo: string | null;
      fecha: string;
    }>;
  }>(`/api/v1/admin/audit/${entidad}/${entidadId}?limit=25`);

  return (
    <Tabla
      columnas={['Fecha', 'Acción', 'Admin', 'Motivo']}
      datos={datos?.items ?? null}
      error={error}
      cargando={cargando}
      vacio="Nadie del equipo tocó esta cuenta."
      fila={(a) => (
        <tr key={a.id}>
          <td className="mono">{fecha(a.fecha)}</td>
          <td className="mono">{a.accion}</td>
          <td>
            {a.actorId ? <Id valor={a.actorId} href={`/usuarios/${a.actorId}`} /> : 'sistema'}
          </td>
          <td>{a.motivo ?? '—'}</td>
        </tr>
      )}
    />
  );
}
