'use client';

import { use } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Estado } from '@/components/ui';
import { api, type Orden, type Producto, type Usuario, type Vendedor } from '@/lib/api';
import { fecha, plata } from '@/lib/formato';

interface VendedorCompleto extends Vendedor {
  usuario: Usuario;
  tiendas: Array<{ id: string; nombre: string; slug: string; estado: string; esPrincipal: boolean }>;
  productos: Producto[];
  ordenesRecientes: Orden[];
  volumen: { ordenesConfirmadas: number; brutoCentavos: number; netoCentavos: number };
  devoluciones: number;
}

export default function DetalleDeVendedor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { datos: s, error, recargar } = useCarga<VendedorCompleto>(`/api/v1/admin/sellers/${id}`);

  async function accion(ruta: string, motivo: string) {
    await api.post(`/api/v1/admin/sellers/${id}/${ruta}`, { reason: motivo });
    recargar();
  }

  return (
    <Pantalla
      titulo={s ? s.nombre : 'Vendedor'}
      descripcion={s ? `${s.estado} · verificación ${s.verificacion}` : id}
      acciones={
        s && (
          <>
            {s.estado !== 'SUSPENDED' && s.estado !== 'BLOCKED' && (
              <BotonDeAccion
                etiqueta="Suspender"
                titulo="Suspender vendedor"
                descripcion="Pausa sus tiendas: no puede vender más. NO cancela órdenes ya pagadas ni borra nada — el historial se conserva."
                textoBoton="Suspender"
                peligroso
                onConfirmar={(m) => accion('suspend', m)}
              />
            )}
            {s.estado === 'SUSPENDED' && (
              <BotonDeAccion
                etiqueta="Reactivar"
                titulo="Reactivar vendedor"
                descripcion="Vuelve a estado activo. Las tiendas NO se reabren solas: eso lo decide el vendedor."
                textoBoton="Reactivar"
                onConfirmar={(m) => accion('reactivate', m)}
              />
            )}
            {s.estado !== 'BLOCKED' && (
              <BotonDeAccion
                etiqueta="Bloquear por fraude"
                titulo="Bloquear vendedor"
                descripcion="Bloqueo definitivo por fraude. NO se puede revertir desde el panel: hace falta intervenir la base con alguien mirando."
                textoBoton="Bloquear definitivamente"
                peligroso
                onConfirmar={(m) => accion('block', m)}
              />
            )}
          </>
        )
      }
    >
      {error != null && <Tabla columnas={[]} datos={null} error={error} fila={() => null} />}

      {s && (
        <>
          <div className="tarjetas">
            <div className="tarjeta">
              <div className="n">{s.volumen.ordenesConfirmadas}</div>
              <div className="t">Órdenes confirmadas</div>
            </div>
            <div className="tarjeta">
              <div className="n" style={{ fontSize: 20 }}>
                {plata(s.volumen.brutoCentavos)}
              </div>
              <div className="t">Vendido (bruto)</div>
            </div>
            <div className="tarjeta">
              <div className="n" style={{ fontSize: 20 }}>
                {plata(s.volumen.netoCentavos)}
              </div>
              <div className="t">Neto del vendedor</div>
            </div>
            <div className={`tarjeta ${s.devoluciones > 0 ? 'urgente' : ''}`}>
              <div className="n">{s.devoluciones}</div>
              <div className="t">Devoluciones</div>
            </div>
          </div>

          <h2>Cuenta</h2>
          <div className="panel">
            <dl className="datos">
              <dt>Usuario</dt>
              <dd>
                {s.usuario.nombre} · <span className="mono">{s.usuario.email}</span> ·{' '}
                <Id valor={s.usuario.id} href={`/usuarios/${s.usuario.id}`} />
              </dd>
              <dt>Estado de la cuenta</dt>
              <dd>
                <Estado valor={s.usuario.estado} />
              </dd>
              <dt>Slug</dt>
              <dd className="mono">{s.slug}</dd>
              <dt>Alta</dt>
              <dd className="mono">{fecha(s.creadoEl)}</dd>
            </dl>
          </div>

          <h2>Tiendas</h2>
          <Tabla
            columnas={['ID', 'Nombre', 'Estado', 'Principal']}
            datos={s.tiendas}
            fila={(t) => (
              <tr key={t.id}>
                <td>
                  <Id valor={t.id} />
                </td>
                <td>{t.nombre}</td>
                <td>
                  <Estado valor={t.estado} />
                </td>
                <td>{t.esPrincipal ? 'sí' : '—'}</td>
              </tr>
            )}
          />

          <h2>Productos</h2>
          <Tabla
            columnas={['ID', 'Nombre', 'Estado', 'Precio base']}
            datos={s.productos}
            vacio="Todavía no cargó productos."
            fila={(p) => (
              <tr key={p.id}>
                <td>
                  <Id valor={p.id} href={`/productos/${p.id}`} />
                </td>
                <td>{p.nombre}</td>
                <td>
                  <Estado valor={p.estado} />
                </td>
                <td className="num">{plata(p.precioBaseCentavos)}</td>
              </tr>
            )}
          />

          <h2>Órdenes recientes</h2>
          <Tabla
            columnas={['ID', 'Referencia', 'Estado', 'Total', 'Creada']}
            datos={s.ordenesRecientes}
            vacio="Sin órdenes."
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
        </>
      )}
    </Pantalla>
  );
}
