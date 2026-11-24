import { useState } from 'react';
import { Copy, ExternalLink, MessageSquareShare } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { track } from '../usage/track';

/**
 * «Preguntar a Claude»: para lo que la IA local no razona bien (comparar, explicar, juntar muchas páginas). Sin API: abre
 * Claude (claude.ai) en una ventana al lado con la pregunta ya escrita y la indicación de usar el conector de Marea (MCP,
 * fase 38), que busca en las tareas, notas, personas y la documentación de Confluence. Solo viaja la pregunta: los
 * documentos de SharePoint no se mandan.
 */

/** Dirección del conector MCP de Marea (la de producción, que es la que tiene cada persona en Claude). */
export const MCP_URL = 'https://gestor-tareas-prod.vercel.app/api/mcp';

/** El mensaje para Claude: que use el conector de Marea y cite las fuentes. */
export function claudePrompt(question: string): string {
  return `Usa el conector de Marea (busca en la documentación de Confluence y en Marea; haz varias búsquedas si hace falta) y responde en español, citando las páginas o tareas de donde sale cada cosa.\n\nPregunta: ${question.trim()}`;
}

export const claudeUrl = (question: string) => `https://claude.ai/new?q=${encodeURIComponent(claudePrompt(question))}`;

/** Abre Claude en una ventana estrecha a la derecha de la pantalla (si el navegador no deja, en una pestaña). */
export function openClaude(question: string) {
  const width = Math.min(560, Math.round(window.screen.availWidth * 0.4));
  const left = window.screen.availWidth - width;
  const win = window.open(claudeUrl(question), 'marea-claude', `popup,width=${width},height=${window.screen.availHeight},left=${left},top=0`);
  if (!win) window.open(claudeUrl(question), '_blank', 'noopener');
  track('assistant-claude', 'open');
}

/** Botón pequeño, debajo de cada respuesta del Asistente. */
export function AskClaudeButton({ question }: { question: string }) {
  const toast = useToast();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
      <span className="text-zinc-400">¿Necesitas que lo piense más?</span>
      <button type="button" onClick={() => openClaude(question)} title="Abre Claude al lado con esta pregunta; usa el conector de Marea"
        className="inline-flex items-center gap-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 font-medium text-orange-800 hover:bg-orange-100 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-900/40">
        <MessageSquareShare className="size-3.5" />Preguntar a Claude
      </button>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(claudePrompt(question)).then(() => toast('Pregunta copiada para Claude')); }}
        title="Copiar la pregunta para pegarla en Claude (app de escritorio o panel de Chrome)" className="rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
        <Copy className="size-3.5" />
      </button>
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
        pregunta escrita: solo hay que enviarla. Claude busca en Marea y en Confluence con el conector de Marea. Va con tu cuenta de Claude
        (también la gratuita) y solo se manda la pregunta.
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
          <li>Recomendado: en Claude, Ajustes → Privacidad, desactiva que usen tus conversaciones para entrenar.</li>
          <li>
            Si tienes Claude de pago, también puedes usarlo en el panel lateral de Chrome (extensión «Claude in Chrome»)
            <a href="https://claude.ai" target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-orange-700 hover:underline dark:text-orange-300">claude.ai<ExternalLink className="size-3" /></a>.
          </li>
        </ol>
      )}
    </section>
  );
}
