'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { Estado } from '@/components/ui';
import type { Busqueda } from '@/lib/api';
import { fecha, plata } from '@/lib/formato';

/**
 * Búsqueda global.
 *
 * ─── Una caja, y se busca al apretar Enter ───
 *
 * Sin búsqueda mientras se escribe. Es tentador —se siente moderno— y acá sería
 * peor: cada tecla dispara una consulta que toca hasta cuatro tablas, y la
 * mayoría de esas consultas son de cadenas a medio escribir que no le importan
 * a nadie.
 *
 * Quien usa esto pega un dato completo desde otro lado —un mail, un id copiado
 * de un correo— y aprieta Enter. Buscar por cada letra de algo pegado es
 * trabajo para la base sin ningún beneficio.
 */
export default function Buscar() {
  const [texto, setTexto] = useState('');
  const [consulta, setConsulta] = useState<string | null>(null);

  const { datos, error, cargando } = useCarga<Busqueda>(
    consulta ? `/api/v1/admin/search?q=${encodeURIComponent(consulta)}` : null,
  );

  const nada =
    datos &&
    datos.usuarios.length === 0 &&
    datos.vendedores.length === 0 &&
    datos.productos.length === 0 &&
    datos.ordenes.length === 0 &&
    datos.pagos.length === 0 &&
    datos.devoluciones.length === 0;

  return (
    <Pantalla
      titulo="Búsqueda"
      descripcion="Email, teléfono, o cualquier id: de usuario, vendedor, producto, orden, pago, devolución, o el id de Mercado Pago."
    >
      <div className="buscador">
        <input
          value={texto}
          autoFocus
          placeholder="prueba@ejemplo.com · ord_01ABC · 1350331981"
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && texto.trim().length >= 3) setConsulta(texto.trim());
          }}
        />
        <button
          className="primario"
          disabled={texto.trim().length < 3}
          onClick={() => setConsulta(texto.trim())}
        >
          Buscar
        </button>
      </div>

      {cargando && consulta && <p className="sub">Buscando…</p>}
      {error != null && <Tabla columnas={[]} datos={null} error={error} fila={() => null} />}

      {datos && (
        <p className="sub">
          Interpretado como: <strong>{datos.interpretadoComo}</strong>
        </p>
      )}

      {nada && (
        <div className="vacio">
          <p style={{ margin: 0 }}>No se encontró nada con ese dato.</p>
          <p style={{ margin: '8px 0 0', fontSize: 13 }}>
            El email y el teléfono se buscan exactos: no hay búsqueda parcial sobre datos
            personales, a propósito.
          </p>
        </div>
      )}

      {datos && datos.usuarios.length > 0 && (
        <>
          <h2>Usuarios</h2>
          <Tabla
            columnas={['ID', 'Nombre', 'Email', 'Rol', 'Estado', 'Alta']}
            datos={datos.usuarios}
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
              </tr>
            )}
          />
        </>
      )}

      {datos && datos.vendedores.length > 0 && (
        <>
          <h2>Vendedores</h2>
          <Tabla
            columnas={['ID', 'Nombre', 'Estado', 'Verificación']}
            datos={datos.vendedores}
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
              </tr>
            )}
          />
        </>
      )}

      {datos && datos.ordenes.length > 0 && (
        <>
          <h2>Órdenes</h2>
          <Tabla
            columnas={['ID', 'Referencia', 'Estado', 'Total', 'Creada', '']}
            datos={datos.ordenes}
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
                <td>
                  <Link href={`/ordenes/${o.id}`}>ver cronología →</Link>
                </td>
              </tr>
            )}
          />
        </>
      )}

      {datos && datos.pagos.length > 0 && (
        <>
          <h2>Pagos</h2>
          <Tabla
            columnas={['ID', 'Orden', 'Estado', 'Monto', 'Tarjeta', 'ID proveedor']}
            datos={datos.pagos}
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
                  {p.tarjeta ? `${p.tarjeta.marca ?? ''} ****${p.tarjeta.ultimos4 ?? ''}` : '—'}
                </td>
                <td className="mono">{p.providerPaymentId ?? '—'}</td>
              </tr>
            )}
          />
        </>
      )}

      {datos && datos.devoluciones.length > 0 && (
        <>
          <h2>Devoluciones</h2>
          <Tabla
            columnas={['ID', 'Orden', 'Estado', 'Monto', 'Intentos']}
            datos={datos.devoluciones}
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
                <td className="num">{d.intentos}</td>
              </tr>
            )}
          />
        </>
      )}

      {datos && datos.productos.length > 0 && (
        <>
          <h2>Productos</h2>
          <Tabla
            columnas={['ID', 'Nombre', 'Estado', 'Precio base']}
            datos={datos.productos}
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
        </>
      )}
    </Pantalla>
  );
}
