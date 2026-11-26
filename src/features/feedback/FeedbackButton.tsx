import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { track } from '../usage/track';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useToast } from '../../components/Toast';
import { sync, useSync } from '../../data/sync';
import { HIDDEN_FOR_ALL } from '../../domain/screens';
import { areaForHash, areaLabel, feedbackAreas, type Feedback, FEEDBACK_IMPACTS, FEEDBACK_KINDS, type FeedbackImpact, type FeedbackKind } from '../../domain/feedback';

/**
 * Botón flotante (abajo a la derecha, en todas las pantallas) para contar que algo no funciona, proponer mejoras o
 * ideas y preguntar dudas. Se guarda en Supabase con la pantalla, el tamaño y el navegador; solo lo leen los
 * administradores (Más → Feedback).
 */
export function FeedbackButton() {
  const { detailId } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => { track('feedback-open'); setOpen(true); }} title="Cuéntanos qué no funciona, mejoras, ideas o dudas"
        className={`fixed right-4 bottom-4 z-20 flex items-center gap-1.5 rounded-full bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-lg hover:bg-indigo-500 print:hidden ${detailId ? 'xl:right-[436px]' : ''}`}>
        <MessageSquarePlus className="size-4" />Feedback
      </button>
      {open && <FeedbackDialog taskOpen={!!detailId}
        onClose={() => { track('feedback-cancel'); setOpen(false); }}
        onSent={() => { track('feedback-send'); setOpen(false); }} />}
    </>
  );
}

const label = 'mb-1.5 block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400';
const field = 'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-600 dark:bg-zinc-900';
const Req = () => <span className="text-red-500"> *</span>;

/**
 * El formulario de feedback. Con `editing`, edita una solicitud propia que sigue en Nuevo (desde «Mis solicitudes»,
 * migración 019): viene relleno y al guardar devuelve la solicitud cambiada.
 */
export function FeedbackDialog({ taskOpen, onClose, onSent, editing, onSaved }: {
  taskOpen: boolean; onClose: () => void; onSent?: () => void; editing?: Feedback; onSaved?: (f: Feedback) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<Exclude<FeedbackKind, 'other'>>(editing && editing.kind !== 'other' ? editing.kind : 'bug');
  const { hiddenScreens, isAdmin } = useSync();
  const hidden = useMemo(() => [...hiddenScreens, ...HIDDEN_FOR_ALL], [hiddenScreens]);
  const areas = useMemo(() => {
    const list = feedbackAreas(hidden, isAdmin);
    // Al editar, la parte de la web que ya tenía se puede mantener aunque ahora no se ofrezca.
    return editing?.area && !list.some((a) => a.id === editing.area) ? [...list, { id: editing.area, label: areaLabel(editing.area) }] : list;
  }, [hidden, isAdmin, editing]);
  const [area, setArea] = useState(() => editing?.area || areaForHash(window.location.hash, taskOpen, hidden, isAdmin));
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [impact, setImpact] = useState<FeedbackImpact | null>(editing?.impact ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const k = FEEDBACK_KINDS.find((x) => x.id === kind)!;
  const page = window.location.hash || '#/today';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!title.trim() || !area || sending) return;
    setSending(true);
    setError('');
    try {
      const fields = { kind, area, title: title.trim(), body: body.trim(), impact: kind === 'bug' ? impact : null };
      if (editing) {
        const saved = await sync().editMyFeedback(editing.id, fields);
        toast('Solicitud actualizada');
        onSaved?.(saved);
      } else {
        await sync().sendFeedback({ ...fields, page });
        toast('¡Gracias! Puedes seguirlo en Más → Mis solicitudes');
        onSent?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-[8vh] dark:bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form role="dialog" aria-modal="true" aria-label={editing ? 'Editar solicitud' : 'Enviar feedback'} onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{editing ? 'Editar solicitud' : 'Enviar feedback'}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="inline-flex flex-wrap rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
            {FEEDBACK_KINDS.map((x) => (
              <button key={x.id} type="button" onClick={() => setKind(x.id)}
                className={`rounded-md px-3 py-1 text-sm ${kind === x.id ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
                {x.label}
              </button>
            ))}
          </div>

          <Field title={<>¿De qué parte de la web?<Req /></>}>
            <select value={area} onChange={(e) => setArea(e.target.value)} className={field} required>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>

          <Field title={<>En una frase<Req /></>}>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder={k.title} className={field} />
          </Field>

          <Field title={<>Cuéntalo <span className="font-normal tracking-normal normal-case">(cuanto más concreto, mejor)</span></>}>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={5000} placeholder={k.body} className={`${field} resize-y`} />
          </Field>

          {kind === 'bug' && (
            <fieldset>
              <legend className={label}>¿Cuánto te afecta?</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {FEEDBACK_IMPACTS.map((x) => (
                  <label key={x.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <input type="radio" name="impact" checked={impact === x.id} onChange={() => setImpact(x.id)} className="accent-indigo-600" />
                    {x.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {editing ? (
            <p className="text-xs text-zinc-500">Puedes cambiarla mientras esté en «Nuevo». Cuando un administrador la mire, ya no se podrá editar.</p>
          ) : <p className="text-xs text-zinc-500">
            Se guarda también desde dónde lo envías ({page}), el navegador y el tamaño de pantalla. Lo ven los administradores; tú puedes
            seguir su estado en <a href="#/feedback" onClick={onClose} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">Más → Mis solicitudes</a>.
          </p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 bg-white px-3.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800">Cancelar</button>
          <button type="submit" disabled={!title.trim() || sending}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {sending ? (editing ? 'Guardando…' : 'Enviando…') : editing ? 'Guardar cambios' : 'Enviar'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function Field({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <label className="block"><span className={label}>{title}</span>{children}</label>;
}
