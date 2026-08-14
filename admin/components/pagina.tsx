'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { api, haySesion, type Pagina } from '@/lib/api';

import { Error as CajaError, Vacio } from './ui';

/**
 * El armazón de toda pantalla del panel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ LA PROTECCIÓN DE RUTA ES SÓLO COMODIDAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este componente redirige a `/login` si no hay sesión. Eso **no es seguridad**
 * y no hay que confundirlo con seguridad: cualquiera puede abrir las
 * herramientas del navegador y saltear una redirección de React.
 *
 * Lo que protege de verdad es el backend, que exige rol `admin` leído de la
 * base en cada petición. Sin ese rol, todas las llamadas responden 403 y esta
 * pantalla queda vacía por más que se muestre.
 *
 * La redirección existe para que quien no tiene sesión vea un formulario en vez
 * de nueve tablas fallando en 401.
 */
/**
 * ¿Hay sesión?
 *
 * ─── Por qué `useSyncExternalStore` y no `useState` + `useEffect` ───
 *
 * `localStorage` no existe durante el renderizado del servidor, así que leerlo
 * directo rompe la hidratación: el servidor dice una cosa y el cliente otra.
 *
 * La solución habitual —un `useState(false)` que un efecto corrige— provoca un
 * render extra en cada montaje y, sobre todo, es exactamente el patrón que este
 * hook existe para reemplazar: `localStorage` ES un almacén externo a React.
 *
 * El `snapshot` del servidor es `false`, así que en SSR nunca hay sesión y no
 * hay desajuste. Y como se suscribe al evento `storage`, cerrar sesión en una
 * pestaña cierra las demás — que es lo correcto para una herramienta con
 * permisos de administrador.
 */
function useHaySesion(): boolean {
  return useSyncExternalStore(
    (avisar) => {
      window.addEventListener('storage', avisar);
      return () => window.removeEventListener('storage', avisar);
    },
    () => haySesion(),
    () => false,
  );
}

export function Pantalla({
  titulo,
  descripcion,
  acciones,
  children,
}: {
  titulo: string;
  descripcion?: string;
  acciones?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const conSesion = useHaySesion();

  useEffect(() => {
    if (!conSesion) router.replace('/login');
  }, [conSesion, router]);

  if (!conSesion) return <main className="contenido" />;

  return (
    <main className="contenido">
      <h1>{titulo}</h1>
      {descripcion && <p className="sub">{descripcion}</p>}
      {acciones && <div className="acciones">{acciones}</div>}
      {children}
    </main>
  );
}

/**
 * Carga datos de un endpoint y maneja los tres estados que siempre existen.
 *
 * Cargando, error y vacío. Los tres son el mismo trabajo repetido en cada
 * pantalla, y el que más se olvida es el de error: sin él, un 500 deja la
 * tabla en blanco y quien la mira no sabe si no hay datos o si el panel está
 * roto — que es una diferencia importante cuando estás intentando resolverle
 * el problema a alguien.
 */
export function useCarga<T>(ruta: string | null, deps: unknown[] = []) {
  /**
   * Un solo estado con la clave de a qué petición pertenece.
   *
   * ─── Por qué no tres `useState` sueltos ───
   *
   * Lo natural sería `datos`, `error` y `cargando` por separado, poniendo
   * `setCargando(true)` al principio del efecto. Eso dispara un render extra en
   * cada cambio de ruta —React avisa de ello— y, peor, deja una ventana en la
   * que `datos` todavía tiene lo anterior mientras `cargando` ya es `true`: la
   * pantalla muestra los datos de la búsqueda previa como si fueran los nuevos.
   *
   * Guardando junto a los datos **de qué petición son**, "cargando" deja de ser
   * un estado que hay que recordar actualizar y pasa a ser una comparación: si
   * lo que tengo no es de la ruta que estoy pidiendo, estoy cargando.
   */
  const [estado, setEstado] = useState<{
    clave: string | null;
    datos: T | null;
    error: unknown;
  }>({ clave: null, datos: null, error: null });

  const [recarga, setRecarga] = useState(0);
  const clave = ruta ? `${ruta}#${recarga}` : null;

  useEffect(() => {
    if (!ruta || !haySesion()) return;

    let vivo = true;

    api
      .get<T>(ruta)
      .then((d) => vivo && setEstado({ clave, datos: d, error: null }))
      .catch((e: unknown) => vivo && setEstado({ clave, datos: null, error: e }));

    // Evita que una respuesta lenta de una búsqueda anterior pise a la nueva.
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, ...deps]);

  return {
    datos: estado.clave === clave ? estado.datos : null,
    error: estado.clave === clave ? estado.error : null,
    cargando: ruta !== null && estado.clave !== clave,
    recargar: () => setRecarga((n) => n + 1),
  };
}

/** Tabla con sus tres estados resueltos. */
export function Tabla<T>({
  columnas,
  datos,
  error,
  cargando,
  fila,
  vacio = 'No hay nada para mostrar.',
}: {
  columnas: string[];
  datos: Pagina<T> | T[] | null;
  error?: unknown;
  cargando?: boolean;
  fila: (item: T) => ReactNode;
  vacio?: string;
}) {
  if (error) return <CajaError error={error} />;
  if (cargando && !datos) return <Vacio>Cargando…</Vacio>;

  const items = Array.isArray(datos) ? datos : (datos?.items ?? []);
  if (items.length === 0) return <Vacio>{vacio}</Vacio>;

  return (
    <div className="tabla-scroll">
      <table>
        <thead>
          <tr>
            {columnas.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{items.map(fila)}</tbody>
      </table>
    </div>
  );
}

/** Un id, monoespaciado y enlazado. Lo que más se copia y pega en el panel. */
export function Id({ valor, href }: { valor: string; href?: string }) {
  const contenido = <span className="mono">{valor}</span>;
  return href ? <Link href={href}>{contenido}</Link> : contenido;
}
