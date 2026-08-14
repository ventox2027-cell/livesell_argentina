'use client';

import { use } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Dato, Estado } from '@/components/ui';
import { api, type Orden, type Producto, type Vendedor } from '@/lib/api';
import { fecha, plata } from '@/lib/formato';

interface ProductoCompleto extends Producto {
  tienda: { id: string; nombre: string; estado: string };
  vendedor: Vendedor;
  imagenes: Array<{ id: string; url: string; posicion: number }>;
  variantes: Array<{
    id: string;
    titulo: string;
    sku: string | null;
    precioCentavos: number | null;
    inventario: {
      onHand: number;
      reservado: number;
      disponible: number;
      umbralBajo: number | null;
    } | null;
  }>;
  reservasActivas: Array<{
    id: string;
    variantId: string;
    userId: string;
    cantidad: number;
    venceEl: string;
    creadaEl: string;
  }>;
  ordenesRecientes: Orden[];
}

/**
 * Producto, con su inventario y reservas.
 *
 * ⚠️ **El stock no se edita desde acá.** El inventario es del vendedor, y una
 * corrección manual desde el panel se saltearía el UPDATE condicional que hace
 * imposible la sobreventa. Se muestra para entender qué está pasando —"¿por qué
 * dice agotado si el vendedor cargó diez?"— y esa pregunta se responde mirando
 * `reservado`, no cambiando `onHand`.
 */
export default function DetalleDeProducto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { datos: p, error, recargar } = useCarga<ProductoCompleto>(`/api/v1/admin/products/${id}`);

  async function accion(ruta: string, motivo: string) {
    await api.post(`/api/v1/admin/products/${id}/${ruta}`, { reason: motivo });
    recargar();
  }

  return (
    <Pantalla
      titulo={p ? p.nombre : 'Producto'}
      descripcion={p ? `${p.estado} · ${p.tienda.nombre}` : id}
      acciones={
        p && (
          <>
            {p.estado === 'ACTIVE' && (
              <BotonDeAccion
                etiqueta="Pausar"
                titulo="Pausar producto"
                descripcion="Deja de mostrarse y de venderse. Las órdenes ya hechas no se tocan."
                textoBoton="Pausar"
                peligroso
                onConfirmar={(m) => accion('pause', m)}
              />
            )}
            {p.estado === 'PAUSED' && (
              <BotonDeAccion
                etiqueta="Reactivar"
                titulo="Reactivar producto"
                descripcion="Vuelve a estar disponible."
                textoBoton="Reactivar"
                onConfirmar={(m) => accion('reactivate', m)}
              />
            )}
          </>
        )
      }
    >
      {error != null && <Tabla columnas={[]} datos={null} error={error} fila={() => null} />}

      {p && (
        <>
          <div className="panel">
            <dl className="datos">
              <dt>ID</dt>
              <dd className="mono">{p.id}</dd>
              <dt>Vendedor</dt>
              <dd>
                {p.vendedor.nombre} · <Estado valor={p.vendedor.estado} /> ·{' '}
                <Id valor={p.vendedor.id} href={`/vendedores/${p.vendedor.id}`} />
              </dd>
              <dt>Tienda</dt>
              <dd>
                {p.tienda.nombre} · <Estado valor={p.tienda.estado} />
              </dd>
              <dt>Precio base</dt>
              <dd className="num">{plata(p.precioBaseCentavos)}</dd>
              <dt>Imágenes</dt>
              <dd>{p.imagenes.length}</dd>
              <dt>Alta</dt>
              <dd className="mono">{fecha(p.creadoEl)}</dd>
            </dl>
          </div>

          <h2>Variantes e inventario</h2>
          <Tabla
            columnas={['ID', 'Variante', 'SKU', 'Precio', 'En depósito', 'Reservado', 'Disponible']}
            datos={p.variantes}
            fila={(v) => (
              <tr key={v.id}>
                <td>
                  <Id valor={v.id} />
                </td>
                <td>{v.titulo}</td>
                <td className="mono">
                  <Dato>{v.sku}</Dato>
                </td>
                <td className="num">
                  {v.precioCentavos !== null ? plata(v.precioCentavos) : plata(p.precioBaseCentavos)}
                </td>
                <td className="num">{v.inventario?.onHand ?? '—'}</td>
                <td className="num">{v.inventario?.reservado ?? '—'}</td>
                <td className="num">
                  {v.inventario ? (
                    <strong
                      style={{ color: v.inventario.disponible === 0 ? 'var(--error)' : undefined }}
                    >
                      {v.inventario.disponible}
                    </strong>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            )}
          />

          <h2>Reservas activas</h2>
          <Tabla
            columnas={['ID', 'Variante', 'Comprador', 'Cant.', 'Vence', 'Creada']}
            datos={p.reservasActivas}
            vacio="No hay stock reservado en este momento."
            fila={(r) => (
              <tr key={r.id}>
                <td>
                  <Id valor={r.id} />
                </td>
                <td>
                  <Id valor={r.variantId} />
                </td>
                <td>
                  <Id valor={r.userId} href={`/usuarios/${r.userId}`} />
                </td>
                <td className="num">{r.cantidad}</td>
                <td className="mono">{fecha(r.venceEl)}</td>
                <td className="mono">{fecha(r.creadaEl)}</td>
              </tr>
            )}
          />

          <h2>Órdenes con este producto</h2>
          <Tabla
            columnas={['ID', 'Referencia', 'Estado', 'Total', 'Creada']}
            datos={p.ordenesRecientes}
            vacio="Todavía no se vendió."
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
