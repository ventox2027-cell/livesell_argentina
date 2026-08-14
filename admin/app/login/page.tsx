'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { configDeAuth, entrarModoPrueba } from '@/lib/api';
import { Error as CajaError } from '@/components/ui';

/**
 * Entrada al panel.
 *
 * ─── Sobre el login de desarrollo ───
 *
 * Es la única forma de entrar por ahora, y sólo aparece si el BACKEND lo
 * habilita: el botón se muestra según lo que responde `/auth/config`, no según
 * una variable del frontend. En producción el backend rechaza arrancar con
 * `AUTH_DEV_LOGIN_ENABLED=true`, así que este camino no existe allá.
 *
 * Google para web queda pendiente. No se simula: si el backend no ofrece el
 * login de desarrollo, esta pantalla lo dice en vez de mostrar un botón que no
 * funciona.
 *
 * ⚠️ Entrar acá **no vuelve admin a nadie**. Da una sesión normal; el rol lo
 * otorga `npm run admin:create` desde el servidor. Si esta cuenta no es admin,
 * el panel va a responder 403 en todo.
 */
export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [dev, setDev] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [entrando, setEntrando] = useState(false);

  useEffect(() => {
    configDeAuth()
      .then((c) => setDev(c.devLoginEnabled))
      .catch((e: unknown) => setError(e));
  }, []);

  async function entrar() {
    setEntrando(true);
    setError(null);
    try {
      await entrarModoPrueba(email.trim().toLowerCase());
      router.push('/');
    } catch (e) {
      setError(e);
      setEntrando(false);
    }
  }

  return (
    <div className="login">
      <div className="caja">
        <div className="marca" style={{ padding: '0 0 20px', fontSize: 22 }}>
          Vendo<span>X</span> · admin
        </div>

        <CajaError error={error} />

        {dev === null && <p className="sub">Conectando con el backend…</p>}

        {dev === false && (
          <div className="panel">
            <p style={{ margin: 0 }}>
              El backend no tiene habilitado el acceso de desarrollo. El ingreso con Google
              para web todavía no está implementado.
            </p>
          </div>
        )}

        {dev === true && (
          <>
            <p className="sub">
              Entrá con la cuenta que ya tenga rol de administrador.
            </p>
            <label htmlFor="email" style={{ fontSize: 13, color: 'var(--texto-2)' }}>
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              autoFocus
              placeholder="vos@vendox.ar"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && void entrar()}
              style={{ marginBottom: 12 }}
            />
            <button
              className="primario"
              style={{ width: '100%' }}
              disabled={!email.includes('@') || entrando}
              onClick={() => void entrar()}
            >
              {entrando ? 'Entrando…' : 'Entrar'}
            </button>
            <p className="sub" style={{ marginTop: 16, fontSize: 13 }}>
              El rol de administrador se otorga desde el servidor con{' '}
              <span className="mono">npm run admin:create</span>. Entrar acá no lo da.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
