'use client';

import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { Estado } from '@/components/ui';
import type { Pagina, Usuario } from '@/lib/api';
import { fecha, hace } from '@/lib/formato';

export default function Usuarios() {
  const [estado, setEstado] = useState('');
  const [rol, setRol] = useState('');

  const { datos, error, cargando } = useCarga<Pagina<Usuario>>(
    `/api/v1/admin/users?limit=50${estado ? `&status=${estado}` : ''}${rol ? `&role=${rol}` : ''}`,
    [estado, rol],
  );

  return (
    <Pantalla
      titulo="Usuarios"
      descripcion="Para encontrar a alguien concreto usá la búsqueda: el email se busca exacto."
    >
      <div className="acciones">
        <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ width: 200 }}>
          <option value="">Cualquier estado</option>
          <option value="active">Activos</option>
          <option value="suspended">Suspendidos</option>
          <option value="deleted">Eliminados</option>
        </select>
        <select value={rol} onChange={(e) => setRol(e.target.value)} style={{ width: 200 }}>
          <option value="">Cualquier rol</option>
          <option value="buyer">Compradores</option>
          <option value="seller">Vendedores</option>
          <option value="moderator">Moderadores</option>
          <option value="admin">Administradores</option>
        </select>
      </div>

      <Tabla
        columnas={['ID', 'Nombre', 'Email', 'Rol', 'Estado', 'Alta', 'Actividad']}
        datos={datos}
        error={error}
        cargando={cargando}
        fila={(u) => (
          <tr key={u.id}>
            <td>
              <Id valor={u.id} href={`/usuarios/${u.id}`} />
            </td>
            <td>{u.nombre}</td>
            <td className="mono">{u.email}</td>
            <td>{u.rol}</td>
            <td>
              <Estado valor={u.estado} />
            </td>
            <td className="mono">{fecha(u.creadoEl)}</td>
            <td className="mono">{hace(u.ultimaActividadEl)}</td>
          </tr>
        )}
      />
    </Pantalla>
  );
}
