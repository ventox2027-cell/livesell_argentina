'use client';

import { useState } from 'react';

import { Pantalla, useCarga } from '@/components/pagina';
import { BotonDeAccion, Error as ErrorUI, Vacio } from '@/components/ui';
import { api } from '@/lib/api';
import { fecha } from '@/lib/formato';

/**
 * La cola de moderación.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTA PANTALLA EXISTÍA COMO API Y NO COMO INTERFAZ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET /admin/moderation/queue` y `POST /admin/moderation/resolve` ya estaban.
 * Lo que no había era forma de usarlos sin `curl`, y una cola de moderación que
 * sólo se atiende con `curl` no se atiende.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SE AGRUPA POR CONTENIDO, NO POR REPORTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Quien modera revisa **el producto**, no cada uno de los ocho reportes que
 * recibió. Resolver el grupo cierra todos juntos con la misma decisión y el
 * mismo motivo — que es lo que efectivamente pasó.
 *
 * ⛔ Ninguna decisión es automática. Lo único que el sistema hace solo es
 * ocultar preventivamente un producto cuando varias personas distintas lo
 * reportan por el mismo motivo, y eso es reversible y con aviso. Suspender a
 * alguien se decide acá, con motivo obligatorio y auditoría.
 */

interface GrupoDeReportes {
  targetType: string;
  targetId: string;
  reportes: number;
  primero: string;
  motivos: string[];
  detalles: (string | null)[];
  umbrales: Record<string, number>;
  reporteIds: string[];
}

/**
 * Los motivos, en castellano y ordenados por gravedad.
 *
 * El orden importa: es el que decide qué se muestra primero en un grupo con
 * varios motivos, y quien modera tiene que ver el más grave de un vistazo.
 */
const MOTIVOS: Record<string, { texto: string; grave: boolean }> = {
  PROHIBIDO: { texto: 'Producto prohibido', grave: true },
  CONTENIDO_SEXUAL: { texto: 'Contenido sexual', grave: true },
  VIOLENCIA: { texto: 'Violencia o discriminación', grave: true },
  ESTAFA: { texto: 'Parece una estafa', grave: true },
  FALSIFICADO: { texto: 'Falsificado', grave: false },
  CONTENIDO_AJENO: { texto: 'Contenido robado', grave: false },
  ENGANOSO: { texto: 'No coincide con lo publicado', grave: false },
  SPAM: { texto: 'Spam', grave: false },
  OTRO: { texto: 'Otro', grave: false },
};

const DESTINOS: Record<string, string> = {
  PRODUCT: 'Producto',
  LIVE: 'Vivo',
  SELLER: 'Vendedor',
  REVIEW: 'Reseña',
  CHAT_MESSAGE: 'Mensaje de chat',
  USER: 'Persona',
};

export default function Moderacion() {
  const [tipo, setTipo] = useState('');
  const [soloGraves, setSoloGraves] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const { datos, error, cargando } = useCarga<{ items: GrupoDeReportes[] }>(
    '/api/v1/admin/moderation/queue?limit=100',
    [recarga],
  );

  /**
   * El filtro es del lado del cliente y está bien.
   *
   * La cola trae como mucho cien grupos: filtrarla en el servidor sería otro
   * parámetro, otra consulta y otra cosa que puede quedar desincronizada, para
   * ahorrar un `filter` sobre cien elementos.
   *
   * El día que la cola tenga miles de grupos, el problema no es el filtro.
   */
  const items = (datos?.items ?? []).filter((g) => {
    if (tipo && g.targetType !== tipo) return false;
    if (soloGraves && !g.motivos.some((m) => MOTIVOS[m]?.grave)) return false;
    return true;
  });

  return (
    <Pantalla titulo="Moderación">
      <div className="acciones">
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ width: 220 }}>
          <option value="">Todo</option>
          {Object.entries(DESTINOS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={soloGraves}
            onChange={(e) => setSoloGraves(e.target.checked)}
          />
          Sólo lo grave
        </label>

        <span className="mono" style={{ marginLeft: 'auto', opacity: 0.6 }}>
          {items.length} sin resolver
        </span>
      </div>

      {error ? <ErrorUI error={error} /> : null}
      {cargando ? <p>Cargando…</p> : null}

      {!cargando && items.length === 0 ? (
        <Vacio>
          {tipo || soloGraves
            ? 'Nada con ese filtro.'
            : 'No hay nada para revisar. '}
        </Vacio>
      ) : null}

      <div style={{ display: 'grid', gap: 16 }}>
        {items.map((g) => (
          <Grupo key={`${g.targetType}:${g.targetId}`} grupo={g} onResuelto={() => setRecarga((n) => n + 1)} />
        ))}
      </div>
    </Pantalla>
  );
}

/**
 * Resuelve un grupo entero.
 *
 * Una sola función para los tres botones: la diferencia entre ellos es la
 * decisión y la acción, no el camino. Tres llamadas distintas serían tres
 * lugares donde olvidarse de recargar.
 */
async function resolver(
  grupo: GrupoDeReportes,
  decision: string,
  accion: string,
  motivo: string,
  onResuelto: () => void,
) {
  await api.post('/api/v1/admin/moderation/resolve', {
    targetType: grupo.targetType,
    targetId: grupo.targetId,
    decision,
    resolution: motivo,
    accion,
  });
  onResuelto();
}

function Grupo({ grupo, onResuelto }: { grupo: GrupoDeReportes; onResuelto: () => void }) {
  const grave = grupo.motivos.some((m) => MOTIVOS[m]?.grave);

  /**
   * ¿Ya se pasó el umbral de ocultamiento?
   *
   * Se muestra porque cambia qué está pasando ahora mismo: si ya se ocultó
   * solo, el producto no está a la vista y la urgencia es otra. Sin esto, quien
   * modera no sabe si está corriendo o revisando.
   */
  const yaOculto = grupo.motivos.some(
    (m) => grupo.umbrales[m] !== undefined && grupo.reportes >= grupo.umbrales[m],
  );

  return (
    <section
      style={{
        border: '1px solid var(--borde)',
        borderLeft: `3px solid ${grave ? 'var(--error)' : 'var(--borde)'}`,
        borderRadius: 10,
        padding: 16,
      }}
    >
      <header style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{DESTINOS[grupo.targetType] ?? grupo.targetType}</strong>
        <code className="mono" style={{ fontSize: 12, opacity: 0.7 }}>
          {grupo.targetId}
        </code>
        <span style={{ marginLeft: 'auto', fontSize: 13, opacity: 0.7 }}>
          {grupo.reportes} {grupo.reportes === 1 ? 'reporte' : 'reportes'} · desde{' '}
          {fecha(grupo.primero)}
        </span>
      </header>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {grupo.motivos.map((m) => (
          <span
            key={m}
            style={{
              fontSize: 12,
              padding: '3px 9px',
              borderRadius: 999,
              background: MOTIVOS[m]?.grave ? 'var(--error-suave)' : 'var(--superficie)',
              border: '1px solid var(--borde)',
            }}
          >
            {MOTIVOS[m]?.texto ?? m}
            <span style={{ opacity: 0.55 }}> · umbral {grupo.umbrales[m] ?? '—'}</span>
          </span>
        ))}
        {yaOculto ? (
          <span style={{ fontSize: 12, padding: '3px 9px', color: 'var(--alerta)' }}>
            Ya oculto automáticamente
          </span>
        ) : null}
      </div>

      {/*
        El texto libre de quien reportó es lo MÁS útil para decidir.
        "Vende réplicas de Nike" dice muchísimo más que la categoría sola, y por
        eso va entero y no recortado.
      */}
      {grupo.detalles.length > 0 ? (
        <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.5 }}>
          {grupo.detalles.map((d, i) => (
            <li key={i} style={{ opacity: 0.85 }}>
              {d}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: 13, opacity: 0.6, margin: '0 0 14px' }}>
          Nadie escribió un detalle.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <BotonDeAccion
          etiqueta="Confirmar y ocultar"
          titulo="Confirmar el reporte y ocultar"
          descripcion={
            'El contenido deja de verse y el vendedor recibe un aviso con el motivo. ' +
            'Es reversible.'
          }
          peligroso
          textoBoton="Confirmar"
          onConfirmar={(motivo) => resolver(grupo, 'CONFIRMADO', 'HIDE', motivo, onResuelto)}
        />

        <BotonDeAccion
          etiqueta="Desestimar"
          titulo="Desestimar los reportes"
          descripcion={
            'Se revisó y no había nada. El contenido sigue como está y los reportes ' +
            'se cierran.'
          }
          textoBoton="Confirmar"
          onConfirmar={(motivo) => resolver(grupo, 'DESESTIMADO', 'NADA', motivo, onResuelto)}
        />

        {yaOculto ? (
          <BotonDeAccion
            etiqueta="Desestimar y restaurar"
            titulo="Restaurar el contenido"
            descripcion={
              'Se ocultó solo por el umbral y no correspondía. Vuelve a verse y el ' +
              'vendedor recibe un aviso.'
            }
            textoBoton="Restaurar"
            onConfirmar={(motivo) => resolver(grupo, 'DESESTIMADO', 'UNHIDE', motivo, onResuelto)}
          />
        ) : null}

        <a
          href={`/moderacion/${grupo.targetType}/${grupo.targetId}`}
          style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 13 }}
        >
          Ver historial
        </a>
      </div>
    </section>
  );
}
