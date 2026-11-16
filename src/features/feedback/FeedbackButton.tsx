import { useState, type FormEvent } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { sync } from '../../data/sync';
import { FEEDBACK_KINDS, type FeedbackKind } from '../../domain/feedback';

/**
 * Botón flotante (abajo a la derecha, en todas las pantallas) para enviar mejoras, cosas rotas u otros comentarios.
 * Se guarda en Supabase con la pantalla y el navegador; solo lo leen los administradores (Más → Feedback).
 */
export function FeedbackButton() {
  const { detailId } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Cuéntanos mejoras o cosas que no funcionan"
        className={`fixed right-4 bottom-4 z-20 flex items-center gap-1.5 rounded-full bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-lg hover:bg-indigo-500 print:hidden ${detailId ? 'xl:right-[436px]' : ''}`}>
        <MessageSquarePlus className="size-4" />Feedback
      </button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<FeedbackKind>('improvement');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await sync().sendFeedback(kind, body.trim(), window.location.hash || '#/today');
      toast('¡Gracias! Hemos recibido tu feedback');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return (
    <Modal title="Enviar feedback" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {FEEDBACK_KINDS.map((k) => (
            <button key={k.id} type="button" onClick={() => setKind(k.id)} title={k.hint}
              className={`rounded-lg border px-2 py-1.5 text-sm ${kind === k.id
                ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
                : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800'}`}>
              {k.label}
            </button>
          ))}
        </div>
        <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={5000}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
          placeholder={kind === 'bug'
            ? 'Qué estabas haciendo, qué esperabas que pasara y qué ha pasado…'
            : kind === 'improvement' ? 'Qué te gustaría que hiciera la herramienta y para qué te serviría…' : 'Cuéntanos…'}
          className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
        <p className="text-xs text-zinc-500">Solo lo ven los administradores. Se envía también desde qué pantalla y con qué navegador.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
          <button type="submit" disabled={!body.trim() || sending}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
