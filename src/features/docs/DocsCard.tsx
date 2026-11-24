import { useEffect, useState } from 'react';
import { BookText, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { sync } from '../../data/sync';

/**
 * Ajustes → Documentación (solo administradores; migración 014). La documentación de Confluence la sube UNA persona con el
 * script del Mac (`scripts/subir-docs.ts`), no desde aquí. Esta tarjeta solo: muestra cuántas páginas hay, genera la clave
 * de subida (se ve una vez, con la orden para copiar) y la quita. Igual que la clave de subida del calendario.
 */

interface Info { count: number; updatedAt: string | null }
interface Token { hasToken: boolean; createdAt?: string; owner?: string }

export function DocsCard() {
  const toast = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // la clave recién generada (se ve una vez)
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [a, b] = await Promise.all([sync().supabase.rpc('docs_info'), sync().supabase.rpc('docs_token_info')]);
      if (a.error) throw new Error(a.error.message);
      if (b.error) throw new Error(b.error.message);
      setInfo(a.data as Info);
      setToken(b.data as Token);
    } catch (e) {
      setError(mensaje(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      if (done) toast(done);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setBusy(false);
    }
  };

  const generar = () => run(async () => {
    const { data, error: e } = await sync().supabase.rpc('create_docs_token');
    if (e) throw new Error(e.message);
    setFresh(data as string);
  });

  const comando = fresh ? `npm run subir-docs -- ${fresh} <ruta-a-cada-zip>` : '';

  return (
    <section className="mb-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><BookText size={16} /> Documentación (conector de Claude)</h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        La documentación de Confluence la sube una sola persona desde su Mac con <code>npm run subir-docs</code>; no se sube
        desde aquí. Genera una clave de subida y guárdala: con ella el script sube la documentación sin tu contraseña.
      </p>
      {info && (
        <p className="mb-3 text-sm">
          {info.count > 0
            ? <>Hay <strong>{info.count}</strong> páginas{info.updatedAt ? `, actualizadas el ${new Date(info.updatedAt).toLocaleDateString('es-ES')}` : ''}.</>
            : 'Aún no se ha subido documentación.'}
        </p>
      )}

      {fresh ? (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800/60 dark:bg-amber-950/40">
          <p className="mb-2">Esta clave se ve <strong>solo una vez</strong>. Guárdala y súbela cada mes así:</p>
          <code className="block overflow-x-auto whitespace-pre rounded bg-white px-2 py-1 text-xs dark:bg-zinc-900">{comando}</code>
          <button
            onClick={() => { void navigator.clipboard?.writeText(fresh); toast('Clave copiada'); }}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <Copy size={13} /> Copiar la clave
          </button>
        </div>
      ) : token?.hasToken && (
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Hay una clave de subida activa{token.owner ? ` (de ${token.owner})` : ''}{token.createdAt ? `, generada el ${new Date(token.createdAt).toLocaleDateString('es-ES')}` : ''}.
          Generar otra invalida la anterior.
        </p>
      )}

      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={generar}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          <KeyRound size={15} /> {token?.hasToken ? 'Generar otra clave' : 'Generar clave de subida'}
        </button>
        {token?.hasToken && (
          <button
            disabled={busy}
            onClick={() => run(async () => { const { error: e } = await sync().supabase.rpc('revoke_docs_token'); if (e) throw new Error(e.message); setFresh(null); }, 'Clave quitada')}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <Trash2 size={15} /> Quitar la clave
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

function mensaje(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/docs_info|docs_token|upload_docs|function.*does not exist|404/i.test(m)) {
    return 'Falta preparar la documentación en Supabase: un administrador tiene que ejecutar supabase/migrations/014_documentacion.sql.';
  }
  return m;
}
