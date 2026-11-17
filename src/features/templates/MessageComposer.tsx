import { lazy, Suspense, useState } from 'react';
import { Copy, MessageSquare } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { routeHref } from '../../app/router';
import { Popover } from '../../components/ui/Popover';
import { useToast } from '../../components/Toast';
import { projectPath } from '../../domain/projects';
import { externalUrl } from '../../domain/releases';
import { teamsChatUrl } from '../../domain/teams';
import { fillTemplate, parseTemplate, promptsOf, templatesFor, type MessageTemplate } from '../../domain/templates';
import { fold, nameKey } from '../../domain/text';
import { peopleDirectory } from '../../domain/people';
import type { Task } from '../../domain/types';
import { findType } from '../../domain/workflows';
import { teamsLinkProps, useTeamsApp } from '../../hooks/useTeamsApp';
import { isRallyId, type RallyItem } from '../../domain/rally';
import { useRallyItem } from '../rally/rallyStore';

// RallyMessage importa este archivo (las plantillas): se carga aparte para no crear un ciclo al arrancar.
const RallyMessage = lazy(() => import('../rally/RallyMessage').then((m) => ({ default: m.RallyMessage })));

// Las plantillas son archivos del repositorio (plantillas/*.md) y entran en la app al compilar.
const files = import.meta.glob('/plantillas/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
export const MESSAGE_TEMPLATES = Object.entries(files)
  .filter(([path]) => !path.endsWith('/README.md'))
  .map(([path, raw]) => parseTemplate(path.split('/').pop()!.replace(/\.md$/, ''), raw))
  .sort((a, b) => a.id.localeCompare(b.id, 'es'));

/** Prepara un mensaje a partir de una plantilla y lo copia o lo abre en un chat de Teams. */
export function MessageButton({ task, className }: { task: Task; className: string }) {
  const { itemTypes } = useApp();
  const toast = useToast();
  const known = useRallyItem(task.external_id);
  const [rallyOpen, setRallyOpen] = useState(false);
  const options = templatesFor(MESSAGE_TEMPLATES, findType(itemTypes, task.type_id));
  // Tarea enlazada a Rally: la ventana de mensajes de Rally (personas buscadas en Rally, «Copiar» y «Publicar en Rally»).
  if (isRallyId(task.external_id)) {
    const item = known ?? ({ id: task.external_id, name: task.title, url: task.url ?? '', kind: '' } as unknown as RallyItem);
    return (
      <>
        <button type="button" onClick={() => setRallyOpen(true)} className={`${className} flex items-center gap-1.5 text-left text-indigo-600 dark:text-indigo-400`}>
          Preparar mensaje<span className="text-xs text-zinc-400">(copiar o publicar en Rally)</span>
        </button>
        {rallyOpen && (
          <Suspense fallback={null}>
            <RallyMessage item={item} task={task} onClose={() => setRallyOpen(false)} onPosted={toast} />
          </Suspense>
        )}
      </>
    );
  }
  if (!options.length) return <span className="px-2 text-xs text-zinc-400">No hay plantillas para este tipo (carpeta plantillas/)</span>;
  return (
    <Popover width="w-[26rem]" trigger={(toggle) => (
      <button type="button" onClick={toggle} className={`${className} flex items-center gap-1.5 text-left text-indigo-600 dark:text-indigo-400`}>
        Preparar mensaje<span className="text-xs text-zinc-400">({options.length === 1 ? options[0].name : `${options.length} plantillas`})</span>
      </button>
    )}>
      {(close) => <Composer task={task} close={close} />}
    </Popover>
  );
}

function Composer({ task, close }: { task: Task; close: () => void }) {
  const { itemTypes, projectMap, peopleCards, tasks, notes } = useApp();
  const toast = useToast();
  const type = findType(itemTypes, task.type_id);
  const options = templatesFor(MESSAGE_TEMPLATES, type);
  const [templateId, setTemplateId] = useState(options[0].id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const template = options.find((t) => t.id === templateId) ?? options[0];
  const fill = (tpl: MessageTemplate, a: Record<string, string>) => fillTemplate(tpl, task, {
    type,
    projectPath: task.project_id ? projectPath(task.project_id, projectMap) : undefined,
    link: externalUrl(task, type),
  }, a);
  const [text, setText] = useState(() => fill(template, answers));
  const prompts = promptsOf(template);
  const answer = (label: string, value: string) => {
    const next = { ...answers, [label]: value };
    setAnswers(next);
    setText(fill(template, next));
  };
  const pick = (id: string) => {
    setTemplateId(id);
    setText(fill(options.find((t) => t.id === id) ?? options[0], answers));
  };

  // Sugerencias para cada hueco: enlaces de la tarea para los de tipo enlace; personas (primero las de ese rol).
  const link = externalUrl(task, type);
  const directory = peopleDirectory(tasks, notes, peopleCards);
  const suggestions = (label: string) => {
    if (/link|enlace|documento/i.test(label)) return [link, task.url].filter((x): x is string => !!x);
    if (/n[uú]mero/i.test(label)) return [];
    const words = fold(label).split(/[^a-z]+/).filter((w) => w.length > 1);
    const roleOf = (n: string) => fold(peopleCards.find((p) => nameKey(p.name) === nameKey(n))?.role ?? '');
    const score = (n: string) => words.filter((w) => roleOf(n).includes(w)).length;
    return [...new Set([...task.people, ...directory.map((p) => p.name)])].sort((a, b) => score(b) - score(a));
  };
  const groups = [...new Set(options.map((t) => t.group))];

  const people = task.people.map((name) => ({ name, email: peopleCards.find((p) => nameKey(p.name) === nameKey(name))?.email ?? '' }));
  const missing = people.filter((p) => !p.email);
  const topic = [task.external_id, task.title].filter(Boolean).join(' · ');
  const [teamsApp] = useTeamsApp();
  const teams = teamsChatUrl(people.map((p) => p.email), topic, text);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Mensaje copiado');
      close();
    } catch {
      toast('No se pudo copiar: selecciona el texto y cópialo a mano');
    }
  };

  return (
    <div className="space-y-2 p-2 text-sm">
      {options.length > 1 && (
        <select value={templateId} aria-label="Plantilla" onChange={(e) => pick(e.target.value)}
          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
          {groups.map((g) => {
            const items = options.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.name}</option>);
            return g ? <optgroup key={g} label={g}>{items}</optgroup> : items;
          })}
        </select>
      )}
      {prompts.length > 0 && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
          {prompts.map((p) => (
            <label key={p.label} className="contents">
              <span className="text-xs text-zinc-500">{p.label}</span>
              <input value={answers[p.label] ?? ''} onChange={(e) => answer(p.label, e.target.value)} list={`sug-${p.label}`}
                placeholder={p.from ? 'Las personas de la tarea' : 'Escribe o elige…'}
                className="min-w-0 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              <datalist id={`sug-${p.label}`}>{suggestions(p.label).map((v) => <option key={v} value={v} />)}</datalist>
            </label>
          ))}
        </div>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} aria-label="Mensaje"
        className="w-full resize-y rounded-md border border-zinc-200 bg-white p-2 font-sans text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-900" />
      {missing.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Para abrir el chat en Teams falta el email de{' '}
          {missing.map((p, i) => (
            <span key={p.name}>{i > 0 && ', '}<a href={routeHref({ view: 'person', name: p.name })} className="underline" onClick={close}>{p.name}</a></span>
          ))}{' '}(en su ficha).
        </p>
      )}
      {!people.length && <p className="text-xs text-zinc-500">Añade personas a la tarea para abrir el chat en Teams.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <Copy className="size-3.5" />Copiar
        </button>
        {teams && (
          <a {...teamsLinkProps(teams, teamsApp)} onClick={close}
            className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">
            <MessageSquare className="size-3.5" />Abrir en Teams{people.length - missing.length > 1 ? ' (chat de grupo)' : ''}
          </a>
        )}
      </div>
    </div>
  );
}
