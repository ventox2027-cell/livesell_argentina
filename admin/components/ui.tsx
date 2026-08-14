'use client';

import { useState, type ReactNode } from 'react';

import { ErrorApi } from '@/lib/api';
import { tonoDe } from '@/lib/formato';

/**
 * Piezas compartidas del panel.
 *
 * Pocas y sin abstracción de más: son nueve pantallas de tablas y detalle, y un
 * sistema de componentes propio costaría más de lo que ahorra.
 */

/**
 * Indicador de estado.
 *
 * ⚠️ **El texto siempre está.** El color acompaña, no reemplaza. Entre el 5 y
 * el 8 % de los varones tiene alguna deficiencia en la visión del color, y "la
 * fila roja" como única señal de que una devolución falló es una señal que
 * parte del equipo no recibe.
 */
export function Estado({ valor }: { valor: string | null | undefined }) {
  if (!valor) return <span className="mono">—</span>;
  return <span className={`chip chip-${tonoDe(valor)}`}>{valor}</span>;
}

export function Vacio({ children }: { children: ReactNode }) {
  return <div className="vacio">{children}</div>;
}

export function Error({ error }: { error: unknown }) {
  if (!error) return null;
  const mensaje =
    error instanceof ErrorApi
      ? `${error.message}${error.code !== 'ERROR' ? ` (${error.code})` : ''}`
      : error instanceof globalThis.Error
        ? error.message
        : 'Algo salió mal';
  return <div className="error-caja">{mensaje}</div>;
}

/**
 * Diálogo de acción, con motivo obligatorio.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO ES UN "¿ESTÁS SEGURO?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una confirmación de sí/no se aprende a saltear en dos días: la mano ya sabe
 * dónde está el botón antes de que el ojo lea el texto. Deja de proteger de
 * nada y sólo agrega un click.
 *
 * Escribir por qué obliga a detenerse a pensar qué se está por hacer, y de paso
 * produce el dato que hace falta seis meses después, cuando alguien pregunte
 * por qué se suspendió esta cuenta.
 *
 * El backend exige el motivo igual: esto no es la validación, es la interfaz de
 * la validación.
 */
export function DialogoDeAccion({
  titulo,
  descripcion,
  textoBoton,
  peligroso,
  onConfirmar,
  onCerrar,
}: {
  titulo: string;
  descripcion: string;
  textoBoton: string;
  peligroso?: boolean;
  onConfirmar: (motivo: string) => Promise<void>;
  onCerrar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const suficiente = motivo.trim().length >= 10;

  async function confirmar() {
    setEnviando(true);
    setError(null);
    try {
      await onConfirmar(motivo.trim());
      onCerrar();
    } catch (e) {
      setError(e);
      setEnviando(false);
    }
  }

  return (
    <div
      className="fondo-modal"
      onClick={(e) => {
        // Sólo cierra si el click fue en el fondo, no dentro del diálogo.
        if (e.target === e.currentTarget && !enviando) onCerrar();
      }}
    >
      <div className="modal">
        <h3>{titulo}</h3>
        <p>{descripcion}</p>

        <label htmlFor="motivo">Motivo (queda registrado en la auditoría)</label>
        <textarea
          id="motivo"
          rows={3}
          value={motivo}
          autoFocus
          placeholder="Ej: fraude reportado en el ticket #1234"
          onChange={(e) => setMotivo(e.target.value)}
          disabled={enviando}
        />
        {!suficiente && motivo.length > 0 && (
          <p style={{ marginTop: 6, fontSize: 13 }}>
            Faltan {10 - motivo.trim().length} caracteres.
          </p>
        )}

        <Error error={error} />

        <div className="acciones" style={{ marginBottom: 0, justifyContent: 'flex-end' }}>
          <button onClick={onCerrar} disabled={enviando}>
            Cancelar
          </button>
          <button
            className={peligroso ? 'peligro' : 'primario'}
            onClick={() => void confirmar()}
            disabled={!suficiente || enviando}
          >
            {enviando ? 'Procesando…' : textoBoton}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Botón que abre un diálogo con motivo. El patrón de toda acción del panel. */
export function BotonDeAccion({
  etiqueta,
  titulo,
  descripcion,
  textoBoton,
  peligroso,
  onConfirmar,
}: {
  etiqueta: string;
  titulo: string;
  descripcion: string;
  textoBoton: string;
  peligroso?: boolean;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);

  return (
    <>
      <button className={peligroso ? 'peligro' : ''} onClick={() => setAbierto(true)}>
        {etiqueta}
      </button>
      {abierto && (
        <DialogoDeAccion
          titulo={titulo}
          descripcion={descripcion}
          textoBoton={textoBoton}
          peligroso={peligroso}
          onConfirmar={onConfirmar}
          onCerrar={() => setAbierto(false)}
        />
      )}
    </>
  );
}

/**
 * Muestra un dato que puede no estar.
 *
 * ─── Por qué existe algo tan chico ───
 *
 * Porque ya nos pasó en Flutter: un `as String` sobre un campo nulo tumbó la
 * pantalla de productos entera cuando un producto tenía foto. Una orden vieja
 * con un campo que se agregó después, o un dato migrado a medias, no puede
 * dejar en blanco la pantalla que alguien está usando para resolver un
 * problema.
 *
 * "Sin dato" es una respuesta. Una pantalla rota no.
 */
export function Dato({ children }: { children: ReactNode }) {
  const vacio =
    children === null ||
    children === undefined ||
    children === '' ||
    (typeof children === 'string' && children.trim() === '');

  return vacio ? <span className="mono">sin dato</span> : <>{children}</>;
}
