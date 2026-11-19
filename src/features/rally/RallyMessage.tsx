import { useEffect, useRef, useState } from 'react';
import { AtSign, Copy, Send, UserRound } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useToast } from '../../components/Toast';
import { projectPath } from '../../domain/projects';
import { unlinkedMentions, type RallyItem, type RallyRef } from '../../domain/rally';
import { externalUrl } from '../../domain/releases';
import { fillTemplate, promptsOf, templatesFor, type MessageTemplate } from '../../domain/templates';
import type { Task } from '../../domain/types';
import { DEFAULT_TYPE_ID } from '../../domain/types';
import { findType } from '../../domain/workflows';
import { MESSAGE_TEMPLATES } from '../templates/MessageComposer';
import { Dialog } from './RallyPickers';
import { rallyApi } from './rallyApi';
import { MentionTextarea, UnlinkedWarning } from './MentionTextarea';

/** Huecos de plantilla que no son personas: enlaces y números. */
const notPerson = (label: string) => /link|enlace|documento|n[uú]mero/i.test(label);

/** Tarea mínima para rellenar la plantilla cuando el elemento de Rally no está en el gestor. */
function pseudoTask(item: RallyItem, typeId: string): Task {
  return {
    id: '', title: item.name, external_id: item.id, url: item.url, type_id: typeId, state_id: '', status: 'todo',
    people: [], checklist: [], notes: '', due_date: null, project_id: null,
  } as unknown as Task;
}

/**
 * «Mensaje» al marcar Ready: el mismo preparador de mensajes del panel de la tarea (plantillas de `plantillas/`), pero
 * las personas se buscan en Rally y se publican en la discusión como menciones de Rally (avisan por correo).
 */
export function RallyMessage({ item, task, onClose, onPosted, onConfirm }: {
  item: RallyItem;
  task?: Task;
  /** La cruz, Esc o clic fuera: no se marca Ready. */
  onClose: () => void;
  onPosted: (message: string) => void;
  /**
   * Marca Ready en Rally: antes de publicar el mensaje o con «Sin mensaje». En los TS, solo después de publicarlo (y sin
   * «Sin mensaje»): si el mensaje no sale, Ready no se marca. Sin `onConfirm`, la ventana solo prepara y publica el mensaje
   * («Preparar mensaje» del panel de una tarea enlazada).
   */
  onConfirm?: () => Promise<void>;
}) {
  const { itemTypes, projectMap } = useApp();
  const toast = useToast();
  const kindType = itemTypes.find((t) => t.short && t.short.toUpperCase() === item.kind);
  const base = task ?? pseudoTask(item, kindType?.id ?? DEFAULT_TYPE_ID);
  const type = findType(itemTypes, base.type_id);
  const options = templatesFor(MESSAGE_TEMPLATES, type);
  const [templateId, setTemplateId] = useState(options[0]?.id ?? '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mentions, setMentions] = useState<RallyRef[]>([]);
  const template = options.find((t) => t.id === templateId) ?? options[0];
  const fill = (tpl: MessageTemplate | undefined, a: Record<string, string>) => (tpl ? fillTemplate(tpl, base, {
    type,
    projectPath: base.project_id ? projectPath(base.project_id, projectMap) : undefined,
    link: externalUrl(base, type) ?? item.url,
  }, a) : '');
  const [text, setText] = useState(() => fill(template, {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const answer = (label: string, value: string) => {
    const next = { ...answers, [label]: value };
    setAnswers(next);
    setText(fill(template, next));
  };
  const pick = (id: string) => {
    setTemplateId(id);
    setText(fill(options.find((t) => t.id === id) ?? options[0], answers));
  };
  const remember = (u: RallyRef) => setMentions((m) => (m.some((x) => x.ref === u.ref) ? m : [...m, u]));
  const mentionIn = (label: string, u: RallyRef) => { remember(u); answer(label, `@${u.name}`); };
  // «Etiquetar a…»: inserta @Nombre donde esté el cursor del mensaje.
  const insertMention = (u: RallyRef) => {
    remember(u);
    const el = area.current;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const tag = `${before && !/\s$/.test(before) ? ' ' : ''}@${u.name} `;
    setText(before + tag + text.slice(at));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + tag.length, at + tag.length); });
  };

  const tagged = mentions.filter((m) => text.includes(`@${m.name}`));
  const groups = [...new Set(options.map((t) => t.group))];
  const prompts = template ? promptsOf(template) : [];
  // Todos los huecos de la plantilla son obligatorios para publicar (los que tienen valor por defecto, si lo tienen).
  // «Etiquetar a», abajo, es opcional.
  const missing = prompts.filter((p) => fill(template, answers).includes(`<${p.label}>`)).map((p) => p.label);
  const leftovers = missing.length === 0 && prompts.some((p) => text.includes(`<${p.label}>`));
  // Cada persona de la plantilla tiene que estar elegida en Rally, para que la mención avise.
  const unpicked = prompts.filter((p) => !notPerson(p.label) && !missing.includes(p.label)
    && !mentions.some((m) => (answers[p.label] ?? '') === `@${m.name}`)).map((p) => p.label);
  const unlinked = unlinkedMentions(text, mentions).length > 0;
  const canPublish = !!text.trim() && !busy && missing.length === 0 && !leftovers && !unpicked.length && !unlinked;

  // TS: Ready solo si el mensaje se publica (primero el mensaje y, si sale bien, Ready; sin «Sin mensaje»).
  const messageFirst = item.kind === 'TS';
  const publish = async () => {
    if (!canPublish) return;
    setBusy(true);
    setError(null);
    try {
      if (!messageFirst) await onConfirm?.();
      const r = await rallyApi.message(item.id, text, tagged);
      const posted = `Mensaje publicado en ${item.id}${r.mentioned.length ? ` · etiquetados: ${r.mentioned.join(', ')}` : ''}`;
      if (messageFirst && onConfirm) {
        try {
          await onConfirm();
        } catch (e) {
          onPosted(`${posted}, pero no se ha podido marcar Ready: ${(e as Error).message}`);
          onClose();
          return;
        }
      }
      onPosted(posted);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Mensaje copiado');
    } catch {
      toast('No se pudo copiar: selecciona el texto y cópialo a mano');
    }
  };

  return (
    <Dialog title={onConfirm ? 'Mensaje · Ready' : `Mensaje · ${item.id}`} width="max-w-xl" onClose={onClose}>
      <div className="min-h-0 space-y-2 overflow-y-auto">
        <p className="text-xs text-zinc-500">
          {item.id} · {item.name} · {onConfirm
            ? messageFirst
              ? 'En los TS, Ready solo se marca si se publica el mensaje; si cierras o falla, no se marca'
              : 'Ready se marca al publicar (o con «Sin mensaje»); si cierras con la cruz, no se marca'
            : 'Se publica en la discusión de Rally y las personas elegidas reciben el aviso por correo'}
        </p>
        {options.length > 1 && (
          <select value={templateId} aria-label="Plantilla" onChange={(e) => pick(e.target.value)}
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
            {groups.map((g) => {
              const items = options.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.name}</option>);
              return g ? <optgroup key={g} label={g}>{items}</optgroup> : items;
            })}
          </select>
        )}
        {!options.length && <p className="text-xs text-zinc-500">No hay plantillas para este tipo: escribe el mensaje.</p>}
        {prompts.length > 0 && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
            {prompts.map((p) => (
              <label key={p.label} className="contents">
                <span className={`text-xs ${missing.includes(p.label) ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>{p.label} <span className="text-red-600">*</span></span>
                {notPerson(p.label) ? (
                  <input value={answers[p.label] ?? ''} onChange={(e) => answer(p.label, e.target.value)} list={`rsug-${p.label}`}
                    placeholder="Escribe o elige…"
                    className="min-w-0 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
                ) : (
                  <RallyPersonInput value={answers[p.label] ?? ''} onText={(v) => answer(p.label, v)} onPick={(u) => mentionIn(p.label, u)} />
                )}
                {notPerson(p.label) && (
                  <datalist id={`rsug-${p.label}`}>
                    {[item.url, base.url].filter((x): x is string => !!x && !/n[uú]mero/i.test(p.label)).map((v) => <option key={v} value={v} />)}
                  </datalist>
                )}
              </label>
            ))}
          </div>
        )}
        <MentionTextarea ref={area} value={text} onChange={setText} mentions={mentions} onMentions={setMentions} rows={11} aria-label="Mensaje"
          className="w-full resize-y rounded-md border border-zinc-200 bg-white p-2 font-sans text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-900" />
        <UnlinkedWarning text={text} mentions={mentions} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500"><AtSign className="size-3.5" />Etiquetar a</span>
          <div className="min-w-48 flex-1"><RallyPersonInput value="" clearOnPick onText={() => {}} onPick={insertMention} placeholder="Buscar en Rally…" /></div>
        </div>
        {tagged.length > 0 && (
          <p className="text-xs text-zinc-500">
            Se etiqueta (y avisa por correo) a{' '}
            {tagged.map((m, i) => <span key={m.ref}>{i > 0 && ', '}<b className="text-indigo-700 dark:text-indigo-300">@{m.name}</b></span>)}
          </p>
        )}
        {missing.length > 0 && (
          <p className="text-xs text-red-600 dark:text-red-400">Para publicar, rellena: {missing.join(', ')}.</p>
        )}
        {unpicked.length > 0 && (
          <p className="text-xs text-red-600 dark:text-red-400">Elige en la lista de Rally a: {unpicked.join(', ')} (si no, la mención no avisa).</p>
        )}
        {leftovers && <p className="text-xs text-red-600 dark:text-red-400">Quedan huecos «&lt;…&gt;» en el mensaje: complétalos o quítalos.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {onConfirm && !messageFirst && <button type="button" disabled={busy} onClick={() => {
          setBusy(true);
          setError(null);
          onConfirm().then(onClose, (e: Error) => { setError(e.message); setBusy(false); });
        }}
          title="Marca Ready sin publicar ningún mensaje"
          className="mr-auto rounded-md px-3 py-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Sin mensaje</button>}
        <button type="button" onClick={() => void copy()}
          className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <Copy className="size-3.5" />Copiar
        </button>
        <button type="button" disabled={!canPublish} onClick={() => void publish()}
          title={missing.length ? `Falta: ${missing.join(', ')}` : unpicked.length ? `Elige en Rally a: ${unpicked.join(', ')}` : undefined}
          className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          <Send className="size-3.5" />{busy ? 'Publicando…' : 'Publicar en Rally'}
        </button>
      </div>
    </Dialog>
  );
}

/** Casilla con búsqueda de personas en Rally (desde 2 letras). Elegir a alguien lo etiqueta. */
export function RallyPersonInput({ value, onText, onPick, placeholder = 'Buscar en Rally…', clearOnPick = false }: {
  value: string;
  onText: (v: string) => void;
  onPick: (u: RallyRef) => void;
  placeholder?: string;
  clearOnPick?: boolean;
}) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<RallyRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setQ(value); }, [value]);

  const term = q.replace(/^@/, '').trim();
  useEffect(() => {
    if (!open || term.length < 2) { setFound(null); return; }
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      rallyApi.searchUsers(term).then((u) => live && setFound(u), (e: Error) => live && setError(e.message));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [term, open]);

  const choose = (u: RallyRef) => {
    onPick(u);
    setQ(clearOnPick ? '' : `@${u.name}`);
    setOpen(false);
  };

  return (
    <div className="relative min-w-0">
      <input value={q} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => { setQ(e.target.value); onText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && found?.[0]) { e.preventDefault(); choose(found[0]); } }}
        className="w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      {open && term.length >= 2 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
          {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">Nadie con ese nombre.</p>}
          {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
          {found?.map((u) => (
            <button key={u.ref} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(u)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <UserRound className="size-4 text-zinc-400" />{u.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
