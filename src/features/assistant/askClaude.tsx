import { useState, useSyncExternalStore } from 'react';
import { Copy, ExternalLink, Loader2, MessageSquareShare, RefreshCw } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { sync } from '../../data/sync';
import { Markdown } from '../notes/Markdown';
import { track } from '../usage/track';

/**
 * «Preguntar a Claude»: para lo que la IA local no razona bien (comparar, explicar, juntar muchas páginas). Sin API: abre
 * Claude (claude.ai) en una ventana al lado con la pregunta ya escrita y la indicación de usar el conector de Marea (MCP,
 * fase 38), que busca en las tareas, notas, personas y la documentación de Confluence. Solo viaja la pregunta: los
 * documentos de SharePoint no se mandan.
 *
 * La respuesta vuelve a Marea (migración 015): el mensaje lleva un id y Claude, al terminar, lo guarda con la herramienta
 * `responder_en_marea` del conector. Marea pregunta a Supabase cada pocos segundos hasta que llega y la enseña aquí.
 */

/** Dirección del conector MCP de Marea (la de producción, que es la que tiene cada persona en Claude). */
export const MCP_URL = 'https://gestor-tareas-prod.vercel.app/api/mcp';

/**
 * El mensaje para Claude: que use el conector de Marea (y, si lo tiene, el de Notion, para cruzar ambas fuentes en el mismo
 * chat), cite las fuentes y, con `id`, que guarde la respuesta en Marea. Nombrar Notion no estorba a quien no lo tenga
 * conectado: Claude simplemente no lo usa.
 */
export function claudePrompt(question: string, id?: string): string {
  const back = id ? `\n\nCuando termines, guarda tu respuesta completa en Marea con la herramienta «responder_en_marea» (id de Marea: ${id}).` : '';
  return `Usa el conector de Marea (busca en la documentación de Confluence y en Marea; haz varias búsquedas si hace falta) y, si la pregunta lo necesita y tienes el conector de Notion conectado, busca también en Notion y cruza ambas fuentes. Responde en español, citando las páginas, tareas o documentos de Notion de donde sale cada cosa.${back}\n\nPregunta: ${question.trim()}`;
}

export const claudeUrl = (question: string, id?: string) => `https://claude.ai/new?q=${encodeURIComponent(claudePrompt(question, id))}`;

/** Id de una pregunta para Claude: corto, en minúsculas y sin repetirse (lo que admite la migración 015). */
export const newRequestId = () => `m-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** Abre Claude en una ventana estrecha a la derecha de la pantalla (si el navegador no deja, en una pestaña). */
/** La ventana de Claude que ha abierto Marea (para cerrarla cuando llega la respuesta). */
let claudeWindow: Window | null = null;

export function openClaude(question: string, id?: string) {
  const url = claudeUrl(question, id);
  const width = Math.min(560, Math.round(window.screen.availWidth * 0.4));
  const left = window.screen.availWidth - width;
  const win = window.open(url, 'marea-claude', `popup,width=${width},height=${window.screen.availHeight},left=${left},top=0`);
  claudeWindow = win;
  if (!win) window.open(url, '_blank', 'noopener');
  track('assistant-claude', 'open');
}

/** ¿Cerrar la ventana de Claude al llegar la respuesta? (De cada persona; sí por defecto.) */
const CLOSE_KEY = 'gestor-tareas:claude-close-on-answer';
export const closeOnAnswer = () => { try { return localStorage.getItem(CLOSE_KEY) !== 'false'; } catch { return true; } };
const setCloseOnAnswer = (v: boolean) => { try { localStorage.setItem(CLOSE_KEY, String(v)); } catch { /* sin almacenamiento */ } };

/**
 * Cierra la ventana de Claude que abrió Marea y vuelve aquí. Solo la nuestra (la abrió este script, así que el navegador
 * deja cerrarla); la conversación sigue en el historial de Claude.
 */
function closeClaude(): boolean {
  const win = claudeWindow;
  claudeWindow = null;
  if (!win || win.closed || !closeOnAnswer()) return false;
  try { win.close(); } catch { return false; }
  window.focus();
  return true;
}

// --- La respuesta de vuelta ---

interface Reply { requestId: string; status: 'waiting' | 'done' | 'error' | 'timeout'; answer: string; error?: string; at: number; closed?: boolean }

// Por respuesta del Asistente (su id), mientras dure la sesión.
const replies = new Map<string, Reply>();
const listeners = new Set<() => void>();
let version = 0;
const setReply = (entryId: string, r: Reply) => {
  replies.set(entryId, r);
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const useReplies = () => useSyncExternalStore(subscribe, () => version);

const POLL_MS = 3000;
/** Tiempo máximo esperando (Claude puede tardar si busca mucho, o la persona no envía la pregunta). */
const WAIT_MS = 15 * 60_000;
/** Después de llegar, se sigue mirando un rato por si Claude la corrige. */
const AFTER_MS = 60_000;

async function fetchAnswer(requestId: string): Promise<string | null> {
  const r = await sync().supabase.from('assistant_answers').select('answer').eq('id', requestId).maybeSingle();
  if (r.error) {
    throw new Error(/assistant_answers|relation|does not exist|schema cache/i.test(r.error.message)
      ? 'Falta preparar Marea: una administradora tiene que ejecutar supabase/migrations/015_respuestas_claude.sql.'
      : r.error.message);
  }
  return (r.data as { answer: string } | null)?.answer ?? null;
}

/** Espera la respuesta de una pregunta (una sola espera por respuesta del Asistente). */
function watch(entryId: string) {
  const started = Date.now();
  let doneAt = 0;
  const tick = async () => {
    const cur = replies.get(entryId);
    if (!cur) return;
    try {
      const answer = await fetchAnswer(cur.requestId);
      if (replies.get(entryId)?.requestId !== cur.requestId) return; // se pidió otra vez
      if (answer && answer !== cur.answer) {
        // La primera vez que llega, se cierra la ventana de Claude (si se abrió desde aquí) y se vuelve a Marea.
        const closed = !doneAt ? closeClaude() : cur.closed;
        doneAt ||= Date.now();
        setReply(entryId, { ...cur, status: 'done', answer, at: Date.now(), closed });
        track('assistant-claude', 'answer');
      }
    } catch (e) {
      setReply(entryId, { ...cur, status: 'error', error: (e as Error).message });
      return;
    }
    const now = Date.now();
    if (doneAt ? now - doneAt > AFTER_MS : now - started > WAIT_MS) {
      const last = replies.get(entryId)!;
      if (last.status === 'waiting') setReply(entryId, { ...last, status: 'timeout' });
      return;
    }
    setTimeout(() => void tick(), POLL_MS);
  };
  setTimeout(() => void tick(), POLL_MS);
}

function ask(entryId: string, question: string) {
  const requestId = newRequestId();
  setReply(entryId, { requestId, status: 'waiting', answer: '', at: Date.now() });
  openClaude(question, requestId);
  watch(entryId);
}

/** La respuesta de Claude dentro de Marea (o la espera). */
function ClaudeReply({ entryId, question }: { entryId: string; question: string }) {
  useReplies();
  const r = replies.get(entryId);
  if (!r) return null;
  const retry = () => {
    setReply(entryId, { ...r, status: 'waiting', error: undefined });
    watch(entryId);
  };
  return (
    <div className="mt-2 rounded-md border-l-4 border-orange-400 bg-orange-50/60 px-3 py-2 text-sm dark:bg-orange-950/30">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-orange-800 dark:text-orange-200">
        <MessageSquareShare className="size-3.5" />Respuesta de Claude
      </p>
      {r.status === 'done' ? (
        <>
          <Markdown text={r.answer} />
          <p className="mt-1.5 text-[11px] text-zinc-400">
            Redactada por Claude con el conector de Marea.{r.closed ? ' He cerrado su ventana: la conversación sigue en tu historial de Claude' : ' La conversación sigue en Claude por si quieres preguntarle más'}
            {r.closed && <a href="https://claude.ai/recents" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-orange-700 hover:underline dark:text-orange-300">abrirla<ExternalLink className="size-3" /></a>}.
          </p>
        </>
      ) : r.status === 'waiting' ? (
        <p className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
          <Loader2 className="size-3.5 animate-spin" />Esperando a Claude… Envía la pregunta en su ventana; la respuesta aparecerá aquí cuando termine.
        </p>
      ) : (
        <div className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
          <p>{r.status === 'error' ? `No se puede recoger la respuesta: ${r.error}` : 'Claude no ha guardado la respuesta en Marea (o aún no la has enviado).'}</p>
          <p>
            Si en Claude ya está, pídele «guárdala en Marea» y pulsa
            <button type="button" onClick={retry} className="ml-1 inline-flex items-center gap-0.5 font-medium text-orange-700 hover:underline dark:text-orange-300"><RefreshCw className="size-3" />Volver a mirar</button>
            {' '}o <button type="button" onClick={() => ask(entryId, question)} className="font-medium text-orange-700 hover:underline dark:text-orange-300">preguntar otra vez</button>.
          </p>
        </div>
      )}
    </div>
  );
}

/** Botón arriba de cada respuesta del Asistente (para que se vea) y, debajo, la respuesta de Claude cuando llega. */
export function AskClaudeButton({ entryId, question }: { entryId: string; question: string }) {
  const toast = useToast();
  useReplies();
  const r = replies.get(entryId);
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <button type="button" onClick={() => ask(entryId, question)} title="Abre Claude al lado con esta pregunta; la respuesta vuelve aquí"
          className="inline-flex items-center gap-1.5 rounded-md border border-orange-300 bg-orange-50 px-2.5 py-1 text-sm font-medium text-orange-800 hover:bg-orange-100 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-900/40">
          <MessageSquareShare className="size-4" />{r ? 'Preguntar a Claude otra vez' : 'Preguntar a Claude'}
        </button>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(claudePrompt(question)).then(() => toast('Pregunta copiada para Claude')); }}
          title="Copiar la pregunta para pegarla en Claude (app de escritorio o panel de Chrome)" className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
          <Copy className="size-3.5" />
        </button>
        {!r && <span className="text-zinc-400">Para lo que hay que pensar o juntar mucho: responde con el conector de Marea y la respuesta vuelve aquí.</span>}
      </div>
      {r && <ClaudeReply entryId={entryId} question={question} />}
    </div>
  );
}

/** Tarjeta del panel lateral: qué es y cómo se conecta Marea a Claude (una vez por persona). */
export function ClaudeCard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-orange-200 p-3 text-sm dark:border-orange-900">
      <h2 className="mb-1 flex items-center gap-1.5 font-semibold"><MessageSquareShare className="size-4 text-orange-600" />Preguntar a Claude</h2>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        Para preguntas que hay que pensar, comparar o explicar. «Preguntar a Claude», debajo de cada respuesta, abre Claude al lado con la
        pregunta escrita: solo hay que enviarla. Claude busca en Marea y en Confluence con el conector de Marea (y en Notion, si
        lo conectas) y, al terminar, la respuesta aparece también aquí. Va con tu cuenta de Claude (también la gratuita) y solo se manda la pregunta.
      </p>
      <button type="button" onClick={() => setOpen(!open)} className="text-xs font-medium text-orange-700 hover:underline dark:text-orange-300">
        {open ? 'Ocultar' : 'Cómo conectar Marea a Claude (una vez)'}
      </button>
      {open && (
        <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
          <li>En Claude: <strong>Ajustes → Conectores → Añadir conector personalizado</strong>.</li>
          <li>
            Nombre «Marea» y esta dirección:
            <span className="mt-0.5 flex items-center gap-1">
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">{MCP_URL}</code>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(MCP_URL).then(() => toast('Dirección copiada')); }} className="rounded p-0.5 text-zinc-400 hover:text-zinc-700" aria-label="Copiar la dirección"><Copy className="size-3" /></button>
            </span>
          </li>
          <li>Pulsa <strong>Conectar</strong> y entra con tu cuenta de Marea.</li>
          <li>La primera vez que Claude guarde una respuesta en Marea pedirá permiso: elige <strong>Permitir siempre</strong>.</li>
          <li>
            Opcional: para cruzar con <strong>Notion</strong> en el mismo chat, añade también el conector oficial de Notion
            en Claude (Ajustes → Conectores) con tu cuenta de Notion. Claude usará Marea y Notion a la vez.
          </li>
          <li>Recomendado: en Claude, Ajustes → Privacidad, desactiva que usen tus conversaciones para entrenar.</li>
          <li>
            Si tienes Claude de pago, también puedes usarlo en el panel lateral de Chrome (extensión «Claude in Chrome»)
            <a href="https://claude.ai" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-orange-700 hover:underline dark:text-orange-300">claude.ai<ExternalLink className="size-3" /></a>.
          </li>
        </ol>
      )}
      <CloseSetting />
    </section>
  );
}

/** Cerrar o no la ventana de Claude al llegar la respuesta. */
function CloseSetting() {
  const [on, setOn] = useState(closeOnAnswer);
  return (
    <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
      <input type="checkbox" className="accent-orange-600" checked={on} onChange={(e) => { setCloseOnAnswer(e.target.checked); setOn(e.target.checked); }} />
      Cerrar la ventana de Claude cuando llegue la respuesta
    </label>
  );
}
