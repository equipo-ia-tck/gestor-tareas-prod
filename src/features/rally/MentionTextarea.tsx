import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { UserRound } from 'lucide-react';
import { mentionQuery, unlinkedMentions, type RallyRef } from '../../domain/rally';
import { rallyApi } from './rallyApi';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (text: string) => void;
  /** Personas elegidas en Rally (las que se publicarán como mención). */
  mentions: RallyRef[];
  onMentions: (m: RallyRef[]) => void;
};

/**
 * Cuadro de texto para comentarios de Rally: al escribir «@» y dos letras busca personas en Rally; elegir una (clic, Enter
 * o Tab) inserta «@Nombre» y la recuerda, para que al publicar sea una mención de Rally (avisa por correo).
 */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea(
  { value, onChange, mentions, onMentions, onKeyDown, className = '', ...rest }, outer,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<RallyRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<number | null>(null);
  const q = mentionQuery(value, caret);
  const open = !!q && closed !== q.start;
  const term = q?.query.trim() ?? '';

  useEffect(() => {
    if (!open || term.length < 2) { setFound(null); return; }
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      rallyApi.searchUsers(term).then((u) => { if (live) { setFound(u.slice(0, 8)); setActive(0); } }, (e: Error) => live && setError(e.message));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [term, open]);

  const choose = (u: RallyRef) => {
    if (!q) return;
    const tag = `@${u.name} `;
    const next = value.slice(0, q.start) + tag + value.slice(caret);
    onChange(next);
    if (!mentions.some((m) => m.ref === u.ref)) onMentions([...mentions, u]);
    const at = q.start + tag.length;
    setFound(null);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(at, at); setCaret(at); });
  };
  const track = () => setCaret(ref.current?.selectionStart ?? value.length);

  return (
    <div className="relative">
      <textarea
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setClosed(null); }}
        onSelect={track}
        onClick={track}
        onBlur={() => setTimeout(() => setClosed(q?.start ?? null), 150)}
        onKeyDown={(e) => {
          if (open && found?.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % found.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + found.length) % found.length); return; }
            if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); choose(found[active] ?? found[0]); return; }
          }
          if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosed(q!.start); return; }
          onKeyDown?.(e);
        }}
        className={className}
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {term.length < 2 && <p className="px-2 py-1 text-xs text-zinc-400">Escribe el nombre para buscar en Rally…</p>}
          {term.length >= 2 && found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
          {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">Nadie con ese nombre en Rally.</p>}
          {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
          {found?.map((u, i) => (
            <button key={u.ref} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(u)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${i === active ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
              <UserRound className="size-4 text-zinc-400" />{u.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/** Aviso de las «@» que no están enlazadas a nadie de Rally (no avisarían): hay que elegirlas en la lista o quitar la @. */
export function UnlinkedWarning({ text, mentions }: { text: string; mentions: RallyRef[] }) {
  const bad = unlinkedMentions(text, mentions);
  if (!bad.length) return null;
  return (
    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
      {bad.join(', ')} no {bad.length === 1 ? 'está enlazada' : 'están enlazadas'} a nadie de Rally y no avisaría: borra el nombre, vuelve a
      escribir «@» y elige a la persona de la lista (o quita la @).
    </p>
  );
}
