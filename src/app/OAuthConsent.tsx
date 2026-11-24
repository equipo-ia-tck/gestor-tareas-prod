import { useEffect, useState } from 'react';
import { MareaLogo } from '../components/ui/MareaLogo';
import { sync } from '../data/sync';

/**
 * Página de permiso del conector de Claude (`/oauth-consent?authorization_id=…`). Supabase Auth hace de servidor OAuth:
 * cuando Claude pide conectarse, manda aquí a la persona (ya con su sesión de Marea, la pide `AuthGate`) para que diga
 * si deja que Claude lea sus datos de Marea. Al aceptar, Supabase devuelve a Claude con el código.
 */

export const isConsentPage = () => location.pathname.replace(/\/+$/, '') === '/oauth-consent';

interface Details { client: string; email: string }

export function OAuthConsent() {
  const id = new URLSearchParams(location.search).get('authorization_id') ?? '';
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(id ? null : 'Falta el identificador de la autorización. Vuelve a conectar desde Claude.');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    void sync().supabase.auth.oauth.getAuthorizationDetails(id).then(({ data, error: e }) => {
      if (e || !data) return setError(e?.message ?? 'No se ha encontrado la autorización. Vuelve a conectar desde Claude.');
      if ('redirect_url' in data) { location.href = data.redirect_url; return; } // ya lo había aceptado antes
      setDetails({ client: data.client.name || 'Claude', email: data.user.email });
    });
  }, [id]);

  const decide = async (ok: boolean) => {
    setBusy(true);
    const api = sync().supabase.auth.oauth;
    const { data, error: e } = ok ? await api.approveAuthorization(id, { skipBrowserRedirect: true }) : await api.denyAuthorization(id, { skipBrowserRedirect: true });
    if (e || !data) { setBusy(false); return setError(e?.message ?? 'No se ha podido guardar la respuesta.'); }
    location.href = data.redirect_url;
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-zinc-200 bg-white p-6 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <MareaLogo width={132} />
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        {!error && !details && <p className="text-zinc-500">Cargando…</p>}
        {details && (
          <>
            <h1 className="text-lg">¿Conectar {details.client} con Marea?</h1>
            <p>
              {details.client} podrá <strong>leer</strong> lo que tú ves en Marea con la cuenta <strong>{details.email}</strong>: tus tareas
              y las compartidas contigo, notas y actas, fichas de personas, proyectos y tu registro.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
              <li>No puede crear, cambiar ni borrar nada.</li>
              <li>Lo que lea entra en tus conversaciones con {details.client}. Revisa en sus ajustes de privacidad que no se usen para entrenar.</li>
              <li>Puedes quitar el acceso cuando quieras desde los conectores de {details.client}.</li>
            </ul>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void decide(true)}
                className="flex-1 rounded-md bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-60">Permitir</button>
              <button type="button" disabled={busy} onClick={() => void decide(false)}
                className="flex-1 rounded-md border border-zinc-300 py-2 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800">Cancelar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
