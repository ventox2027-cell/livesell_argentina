'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { api, borrarSesion, haySesion, type Atencion } from '@/lib/api';

/**
 * Navegación. Diez entradas y ninguna más.
 *
 * Un panel operativo se usa con urgencia: alguien está resolviendo el problema
 * de una persona concreta mientras esa persona espera. Un menú con submenús y
 * secciones colapsables agrega decisiones justo cuando no hay tiempo para
 * tomarlas.
 *
 * Los contadores de al lado son lo único que se destaca, porque son lo único
 * que pide acción.
 */
const ENTRADAS = [
  { href: '/', etiqueta: 'Inicio' },
  { href: '/buscar', etiqueta: 'Búsqueda' },
  { href: '/ordenes', etiqueta: 'Órdenes' },
  { href: '/pagos', etiqueta: 'Pagos', contador: 'pagosInciertos' },
  { href: '/devoluciones', etiqueta: 'Devoluciones', contador: 'devolucionesFallidas' },
  { href: '/vendedores', etiqueta: 'Vendedores' },
  { href: '/usuarios', etiqueta: 'Usuarios' },
  /**
   * La cola de reportes.
   *
   * Va con el resto y no escondida: el día que entre alguien vendiendo algo que
   * no se puede vender, la única pregunta que importa es cuánto tarda en
   * desaparecer, y la respuesta depende de que alguien esté mirando esta
   * pantalla.
   */
  { href: '/moderacion', etiqueta: 'Moderación' },
  { href: '/webhooks', etiqueta: 'Webhooks', contador: 'webhooksConError' },
  { href: '/auditoria', etiqueta: 'Auditoría' },
] as const;

export function Sidebar() {
  const ruta = usePathname();
  const router = useRouter();
  const [atencion, setAtencion] = useState<Atencion | null>(null);

  useEffect(() => {
    if (ruta === '/login' || !haySesion()) return;
    api.get<Atencion>('/api/v1/admin/attention').then(setAtencion).catch(() => {
      // Un contador que no carga no puede romper la navegación: el panel se
      // usa igual sin él.
    });
  }, [ruta]);

  if (ruta === '/login') return null;

  return (
    <nav className="sidebar">
      <div className="marca">
        Vendo<span>X</span> · admin
      </div>

      {ENTRADAS.map((e) => {
        const activo = e.href === '/' ? ruta === '/' : ruta.startsWith(e.href);
        const n = 'contador' in e && atencion ? atencion[e.contador] : 0;
        return (
          <Link key={e.href} href={e.href} className={`nav-item ${activo ? 'activo' : ''}`}>
            {e.etiqueta}
            {n > 0 && <span className="chip chip-error">{n}</span>}
          </Link>
        );
      })}

      <div style={{ flex: 1 }} />
      <button
        onClick={() => {
          borrarSesion();
          router.push('/login');
        }}
      >
        Salir
      </button>
    </nav>
  );
}
