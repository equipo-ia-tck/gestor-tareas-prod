import type { ItemType, Task } from './types';
import { stateOf } from './workflows';

/**
 * Plantillas de mensajes (entregar una US, pedir una validación…). Viven como archivos Markdown en
 * `plantillas/` del repositorio, así se editan y versionan en Git entre todos.
 *
 * Formato: una cabecera opcional entre `---` con `nombre:`, `grupo:` y `tipos:` (abreviaturas o ids de
 * tipo, separados por comas; sin `tipos`, vale para todos) y después el texto con campos entre llaves.
 * Los campos `{?Etiqueta}` no salen de la tarea: se preguntan al preparar el mensaje. Con `{?Etiqueta|campo}`
 * toman por defecto un campo de la tarea (p. ej. `{?Responsable del delivery|para}` = las personas de la tarea).
 */
export interface MessageTemplate {
  id: string;
  name: string;
  /** Para agrupar en el desplegable ("Guías de etiquetado (US)"). */
  group: string;
  /** Ids o abreviaturas de tipo (en minúsculas). Vacío = cualquier tipo. */
  types: string[];
  body: string;
}

export function parseTemplate(id: string, raw: string): MessageTemplate {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^\s*([\wáéíóúñ]+)\s*:\s*(.*)$/i.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return {
    id,
    name: meta.nombre || id,
    group: meta.grupo ?? '',
    types: (meta.tipos ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    body: (m ? raw.slice(m[0].length) : raw).trim(),
  };
}

const PROMPT = /\{\?([^{}|]+)(?:\|(\w+))?\}/g;

export interface TemplatePrompt { label: string; from: string | null }

/** Campos que hay que preguntar (`{?Link a la guía}`), sin repetir y en orden de aparición. */
export function promptsOf(tpl: MessageTemplate): TemplatePrompt[] {
  const out = new Map<string, TemplatePrompt>();
  for (const m of tpl.body.matchAll(PROMPT)) {
    const label = m[1].trim();
    if (!out.has(label)) out.set(label, { label, from: m[2] ?? null });
  }
  return [...out.values()];
}

export const templatesFor = (templates: MessageTemplate[], type: ItemType) =>
  templates.filter((t) => !t.types.length || t.types.includes(type.id) || t.types.includes(type.short.toLowerCase()));

export interface TemplateContext {
  type: ItemType;
  projectPath?: string;
  link?: string | null;
  /** Nombres de los destinatarios (se usa el primer nombre de cada uno). */
  recipients?: string[];
}

const firstName = (n: string) => n.trim().split(/\s+/)[0];
const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;

/**
 * Rellena la plantilla con los datos de la tarea. Campos: {id} {titulo} {tipo} {estado} {proyecto}
 * {enlace} {fecha} {para} {hecho} {pendiente} {pasos} {descripcion}. Una línea cuyo campo queda vacío
 * se quita entera (así "Enlace: {enlace}" desaparece si no hay enlace).
 * Los campos preguntados sin respuesta se quedan como `<Etiqueta>`, para que se vea el hueco.
 */
export function fillTemplate(tpl: MessageTemplate, task: Task, ctx: TemplateContext, answers: Record<string, string> = {}): string {
  const steps = task.checklist;
  const values: Record<string, string> = {
    id: task.external_id ?? '',
    titulo: task.title,
    tipo: ctx.type.name,
    estado: stateOf([ctx.type], task).name,
    proyecto: ctx.projectPath ?? '',
    enlace: ctx.link ?? '',
    fecha: task.due_date ? task.due_date.split('-').reverse().slice(0, 2).join('/') : '',
    para: joinNames((ctx.recipients ?? task.people).map(firstName)),
    hecho: steps.filter((s) => s.done).map((s) => `✓ ${s.text}`).join('\n'),
    pendiente: steps.filter((s) => !s.done).map((s) => `• ${s.text}`).join('\n'),
    pasos: steps.map((s) => `${s.done ? '✓' : '•'} ${s.text}`).join('\n'),
    descripcion: task.notes.trim(),
  };
  const field = /\{(\w+)\}/g;
  return tpl.body
    .replace(PROMPT, (_, label: string, from?: string) =>
      answers[label.trim()]?.trim() || (from && values[from]) || `<${label.trim()}>`)
    .split('\n')
    .filter((line) => [...line.matchAll(field)].every(([, k]) => !(k in values) || values[k] !== ''))
    .map((line) => line.replace(field, (all, k: string) => (k in values ? values[k] : all)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Texto de una plantilla para un comentario de Rally, sin preguntar nada: los huecos `{?…}` se quitan («Hola {?PO},» →
 * «Hola,») y una línea que solo tenía huecos (o un «cc» con huecos) desaparece. La persona se menciona aparte.
 */
export function templateComment(tpl: MessageTemplate): string {
  return tpl.body
    .split('\n')
    .flatMap((line) => {
      if (!line.match(PROMPT)) return [line];
      const left = line.replace(PROMPT, '').replace(/\s+([,.;:])/g, '$1').replace(/([,;])(\s*[,;])+/g, '$1').replace(/\s{2,}/g, ' ').trim();
      // Solo quedan separadores o una palabra corta («cc», «y»): fuera la línea.
      return /^[\p{L}]{0,3}[\s,;:.y]*$/u.test(left) ? [] : [left];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
