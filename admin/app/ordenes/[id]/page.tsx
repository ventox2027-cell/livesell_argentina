'use client';

import { use } from 'react';

import { Id, Pantalla, Tabla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Dato, Estado } from '@/components/ui';
import { api, type Devolucion, type EventoTimeline, type Orden, type Pago } from '@/lib/api';
import { fecha, hora, plata } from '@/lib/formato';

interface OrdenCompleta extends Orden {
  comprador: { id: string; nombre: string; email: string | null; telefono: string | null };
  vendedor: { id: string; nombre: string; estado: string };
  tienda: { id: string; nombre: string };
  direccionEnvio: unknown;
  items: Array<{
    id: string;
    productId: string;
    nombre: string;
    variante: string | null;
    sku: string | null;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
  pagos: Pago[];
  devoluciones: Devolucion[];
}

/**
 * La orden, con su cronología.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PANTALLA QUE JUSTIFICA EL PANEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cuando alguien escribe "pagué y no me llegó", la respuesta está repartida en
 * cinco tablas y ninguna cuenta la historia completa. Acá está en orden, en
 * castellano, sin que nadie tenga que leer JSON ni cruzar timestamps a ojo.
 *
 * La cronología va PRIMERO, arriba del detalle. El detalle es de consulta; la
 * cronología es la que responde la pregunta.
 */
export default function DetalleDeOrden({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const orden = useCarga<OrdenCompleta>(`/api/v1/admin/orders/${id}`);
  const cronologia = useCarga<{ eventos: EventoTimeline[] }>(
    `/api/v1/admin/orders/${id}/timeline`,
  );

  const o = orden.datos;

  return (
    <Pantalla
      titulo={o ? `Orden ${o.referencia}` : 'Orden'}
      descripcion={o ? `${o.estado}${o.motivoEstado ? ` · ${o.motivoEstado}` : ''}` : id}
    >
      {orden.error != null && <Tabla columnas={[]} datos={null} error={orden.error} fila={() => null} />}

      <h2>Qué pasó</h2>
      {cronologia.cargando && !cronologia.datos && <p className="sub">Cargando…</p>}
      {cronologia.datos && cronologia.datos.eventos.length === 0 && (
        <div className="vacio">No hay eventos registrados para esta orden.</div>
      )}
      {cronologia.datos && cronologia.datos.eventos.length > 0 && (
        <ul className="timeline">
          {cronologia.datos.eventos.map((e, i) => (
            <li key={`${e.tipo}-${i}`} className={e.nivel}>
              <div className="t-hora" title={fecha(e.fecha)}>
                {fecha(e.fecha).slice(0, 10)} · {hora(e.fecha)}
              </div>
              <div className="t-titulo">{e.titulo}</div>
              {e.detalle && <div className="t-detalle">{e.detalle}</div>}
            </li>
          ))}
        </ul>
      )}

      {o && (
        <>
          <h2>Dinero</h2>
          <div className="panel">
            <dl className="datos">
              <dt>Subtotal</dt>
              <dd className="num">{plata(o.dinero.subtotal)}</dd>
              <dt>Envío</dt>
              <dd className="num">{plata(o.dinero.envio)}</dd>
              <dt>Descuento</dt>
              <dd className="num">{plata(o.dinero.descuento)}</dd>
              <dt>
                <strong>Total cobrado</strong>
              </dt>
              <dd className="num">
                <strong>{plata(o.dinero.total)}</strong>
              </dd>
              <dt>Comisión VendoX</dt>
              <dd className="num">{plata(o.dinero.comisionPlataforma)}</dd>
              <dt>Comisión del procesador</dt>
              <dd className="num">{plata(o.dinero.comisionProcesador)}</dd>
              <dt>Neto del vendedor</dt>
              <dd className="num">{plata(o.dinero.netoVendedor)}</dd>
            </dl>
          </div>

          <h2>Partes</h2>
          <div className="panel">
            <dl className="datos">
              <dt>Comprador</dt>
              <dd>
                {o.comprador.nombre} · <span className="mono">{o.comprador.email}</span> ·{' '}
                <Id valor={o.comprador.id} href={`/usuarios/${o.comprador.id}`} />
              </dd>
              <dt>Vendedor</dt>
              <dd>
                {o.vendedor.nombre} · <Estado valor={o.vendedor.estado} /> ·{' '}
                <Id valor={o.vendedor.id} href={`/vendedores/${o.vendedor.id}`} />
              </dd>
              <dt>Tienda</dt>
              <dd>{o.tienda.nombre}</dd>
              <dt>Envío a</dt>
              <dd className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                <Dato>{direccionLegible(o.direccionEnvio)}</Dato>
              </dd>
            </dl>
          </div>

          <h2>Artículos</h2>
          <Tabla
            columnas={['Producto', 'Variante', 'SKU', 'Cant.', 'Unitario', 'Subtotal']}
            datos={o.items}
            fila={(i) => (
              <tr key={i.id}>
                <td>
                  <Id valor={i.nombre} href={`/productos/${i.productId}`} />
                </td>
                <td>
                  <Dato>{i.variante}</Dato>
                </td>
                <td className="mono">
                  <Dato>{i.sku}</Dato>
                </td>
                <td className="num">{i.cantidad}</td>
                <td className="num">{plata(i.precioUnitario)}</td>
                <td className="num">{plata(i.subtotal)}</td>
              </tr>
            )}
          />

          <h2>Intentos de cobro</h2>
          <Tabla
            columnas={['ID', 'Estado', 'Monto', 'Tarjeta', 'ID proveedor', 'Fallo', 'Acción']}
            datos={o.pagos}
            vacio="Todavía no hubo ningún intento de cobro."
            fila={(p) => (
              <tr key={p.id}>
                <td>
                  <Id valor={p.id} />
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
                <td>
                  <Dato>{p.fallo?.mensaje}</Dato>
                </td>
                <td>
                  {/*
                    Conciliar sólo tiene sentido en los estados inciertos: en
                    los demás ya sabemos qué pasó, y el botón sólo generaría
                    una consulta al proveedor para confirmar lo que la base ya
                    dice.
                  */}
                  {['PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION'].includes(p.estado) && (
                    <BotonDeAccion
                      etiqueta="Conciliar"
                      titulo="Conciliar contra Mercado Pago"
                      descripcion="Le pregunta al proveedor cuál fue el resultado real de este cobro y aplica lo que responda. Es la misma lógica que corre automáticamente en el worker; se puede repetir sin riesgo."
                      textoBoton="Conciliar ahora"
                      onConfirmar={async (motivo) => {
                        await api.post(`/api/v1/admin/payments/${p.id}/reconcile`, {
                          reason: motivo,
                        });
                        orden.recargar();
                        cronologia.recargar();
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
          />

          {o.devoluciones.length > 0 && (
            <>
              <h2>Devoluciones</h2>
              <Tabla
                columnas={['ID', 'Estado', 'Monto', 'Motivo', 'Intentos', 'Último error', 'Acción']}
                datos={o.devoluciones}
                fila={(d) => (
                  <tr key={d.id}>
                    <td>
                      <Id valor={d.id} />
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
                    <td>
                      {d.estado !== 'COMPLETED' && (
                        <BotonDeAccion
                          etiqueta="Reintentar"
                          titulo="Reintentar la devolución"
                          descripcion="Vuelve a pedirle a Mercado Pago que devuelva el monto que el sistema ya determinó. No se puede cambiar el importe desde acá, y repetirlo no devuelve dos veces."
                          textoBoton="Reintentar"
                          onConfirmar={async (motivo) => {
                            await api.post(`/api/v1/admin/refunds/${d.id}/retry`, {
                              reason: motivo,
                            });
                            orden.recargar();
                            cronologia.recargar();
                          }}
                        />
                      )}
                    </td>
                  </tr>
                )}
              />
            </>
          )}
        </>
      )}
    </Pantalla>
  );
}

/**
 * La dirección de envío es un snapshot en JSON.
 *
 * Se arma un texto legible en vez de volcar el objeto: quien está resolviendo
 * "no me llegó el pedido" necesita leer una dirección, no interpretar un JSON.
 * Y si el snapshot viene de una versión vieja con otros campos, no revienta —
 * muestra lo que encuentre.
 */
function direccionLegible(dir: unknown): string {
  if (!dir || typeof dir !== 'object') return '';
  const d = dir as Record<string, unknown>;
  const partes = [
    [d.street, d.number].filter(Boolean).join(' '),
    d.apartment,
    d.city,
    d.province,
    d.zipCode,
  ]
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .join(', ');
  return partes;
}
