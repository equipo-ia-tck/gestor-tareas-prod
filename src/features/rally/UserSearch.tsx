import { useEffect, useState } from 'react';
import { Check, Pencil, Search, UserRound } from 'lucide-react';
import type { RallyRef } from '../../domain/rally';
import { rallyApi } from './rallyApi';

export function useSearch<T>(q: string, load: (q: string) => Promise<T[]>, min: number) {
  const [found, setFound] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < min) { setFound(null); return; }
    let live = true;
    setFound(null);
    setError(null);
    const t = setTimeout(() => { load(term).then((r) => live && setFound(r), (e: Error) => live && setError(e.message)); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return { found, error };
}

export const box = 'flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 dark:border-zinc-600 dark:bg-zinc-800';
export const row = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800';

/** Analista (obligatorio): el último elegido de entrada y búsqueda en Rally. */
export function AnalystSearch({ value, onChange, placeholder = 'Buscar en Rally por nombre, usuario o email', autoFocus = false }: {
  value: RallyRef | null; onChange: (u: RallyRef) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const { found, error } = useSearch(q, (term) => rallyApi.searchUsers(term), 2);
  return (
    <>
      <div className={box}>
        <Search className="size-4 text-zinc-400" />
        <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      {q.trim().length >= 2 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
          {found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
          {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">Nadie con ese nombre.</p>}
          {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
          {found?.map((u) => (
            <button key={u.ref} type="button" onClick={() => { onChange(u); setQ(''); }} className={row}>
              <UserRound className="size-4 text-zinc-400" /><span className="flex-1">{u.name}</span>
              {value?.ref === u.ref && <Check className="size-4 text-indigo-600" />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Mención del PO en un comentario: por defecto el Owner del elemento; al pulsarla se abre el buscador de Rally para
 * mencionar a otra persona en su lugar (`value`), y «Volver al Owner» la quita.
 */
export function OwnerMention({ owner, value, onChange, className = 'text-xs' }: {
  owner: string | null;
  value: RallyRef | null;
  onChange: (u: RallyRef | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = value?.name ?? owner;
  return (
    <span className="block">
      <button type="button" onClick={() => setOpen(!open)} title="Cambiar a quién se menciona"
        className={`inline-flex items-center gap-1 rounded px-0.5 font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950 ${className}`}>
        {shown ? `@${shown}` : <span className="text-amber-600">Sin Owner en Rally · mencionar a alguien</span>}
        <Pencil className="size-3 opacity-60" />
      </button>
      {value && owner && (
        <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="ml-2 text-[11px] text-zinc-500 underline hover:text-zinc-700">
          Volver al Owner ({owner})
        </button>
      )}
      {open && (
        <span className="mt-1 block">
          <AnalystSearch value={value} onChange={(u) => { onChange(u); setOpen(false); }} placeholder="Buscar a quién mencionar en Rally" autoFocus />
        </span>
      )}
    </span>
  );
}
