/** Feedback de los usuarios (tabla `feedback` de Supabase, migraciones 006 y 007). Solo lo leen los administradores. */
import type { Priority } from './types';

/** `other` solo existe en lo enviado con el primer formulario. */
export type FeedbackKind = 'bug' | 'improvement' | 'idea' | 'question' | 'other';
export type FeedbackStatus = 'new' | 'doing' | 'done' | 'dismissed';
export type FeedbackImpact = 'blocking' | 'annoying' | 'minor';

export interface Feedback {
  id: string;
  authorName: string;
  authorLogin: string;
  kind: FeedbackKind;
  /** En una frase (vacío en lo enviado con el primer formulario). */
  title: string;
  /** Parte de la web (`FEEDBACK_AREAS`). */
  area: string;
  /** Solo si algo no funciona. */
  impact: FeedbackImpact | null;
  /** Detalle (opcional). */
  body: string;
  /** Pantalla desde la que se envió (el hash: `#/board`…). */
  page: string;
  /** Tamaño de la ventana ("1440×900"). */
  screen: string;
  userAgent: string;
  status: FeedbackStatus;
  /** Tarea del gestor creada a partir de él. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const FEEDBACK_KINDS: { id: Exclude<FeedbackKind, 'other'>; label: string; title: string; body: string }[] = [
  { id: 'bug', label: 'Algo no funciona', title: 'Ej. Al mover una tarjeta a Completed vuelve a su columna',
    body: 'Qué estabas haciendo, qué ha pasado y qué esperabas que pasara. Si sabes repetirlo, los pasos.' },
  { id: 'improvement', label: 'Mejora', title: 'Ej. Poder filtrar el tablero por persona',
    body: 'Qué cambiarías de lo que ya hay y para qué te serviría.' },
  { id: 'idea', label: 'Idea nueva', title: 'Ej. Plantillas de acta para cada tipo de reunión',
    body: 'Qué te gustaría que hiciera la herramienta y en qué te ayudaría.' },
  { id: 'question', label: 'Duda', title: 'Ej. ¿Cómo paso una nota a tarea?',
    body: 'Qué querías hacer y dónde te has perdido.' },
];

export const FEEDBACK_STATUSES: { id: FeedbackStatus; label: string }[] = [
  { id: 'new', label: 'Nuevo' },
  { id: 'doing', label: 'En curso' },
  { id: 'done', label: 'Hecho' },
  { id: 'dismissed', label: 'Descartado' },
];

export const FEEDBACK_IMPACTS: { id: FeedbackImpact; label: string; priority: Priority }[] = [
  { id: 'blocking', label: 'Me bloquea', priority: 1 },
  { id: 'annoying', label: 'Molesta, pero puedo seguir', priority: 2 },
  { id: 'minor', label: 'Detalle', priority: 3 },
];

/** Partes de la web, en el orden de la barra lateral. */
export const FEEDBACK_AREAS: { id: string; label: string }[] = [
  { id: 'today', label: 'Hoy y Mi día' },
  { id: 'inbox', label: 'Bandeja y captura rápida' },
  { id: 'board', label: 'Tablero' },
  { id: 'calendar', label: 'Calendario y Outlook' },
  { id: 'notes', label: 'Notas y actas' },
  { id: 'rally', label: 'Rally' },
  { id: 'projects', label: 'Proyectos' },
  { id: 'people', label: 'Personas y grupos' },
  { id: 'search', label: 'Búsqueda' },
  { id: 'review', label: 'Revisión semanal y Registro' },
  { id: 'task', label: 'Ficha de una tarea' },
  { id: 'settings', label: 'Ajustes' },
  { id: 'account', label: 'Acceso, login y usuarios' },
  { id: 'other', label: 'Otra / en general' },
];

/** Parte de la web de una pantalla (para proponerla sola en el formulario). */
export function areaForHash(hash: string, taskOpen = false): string {
  if (taskOpen) return 'task';
  const view = hash.replace(/^#\/?/, '').split('/')[0];
  const map: Record<string, string> = {
    '': 'today', today: 'today', inbox: 'inbox', board: 'board', all: 'board', calendar: 'calendar', week: 'calendar',
    notes: 'notes', rally: 'rally', project: 'projects', projects: 'projects', people: 'people', person: 'people',
    search: 'search', review: 'review', log: 'review', settings: 'settings',
  };
  return map[view] ?? 'other';
}

export const kindLabel = (k: FeedbackKind) => FEEDBACK_KINDS.find((x) => x.id === k)?.label ?? 'Otro';
export const statusLabel = (s: FeedbackStatus) => FEEDBACK_STATUSES.find((x) => x.id === s)?.label ?? s;
export const areaLabel = (a: string) => FEEDBACK_AREAS.find((x) => x.id === a)?.label ?? a;
export const impactLabel = (i: FeedbackImpact) => FEEDBACK_IMPACTS.find((x) => x.id === i)?.label ?? i;

/** Navegador y sistema en pocas palabras ("Chrome 142 · macOS"), para no enseñar el user agent entero. */
export function browserSummary(ua: string): string {
  const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 60);
}

/** Título de la tarea creada desde un feedback: tipo y la frase (o la primera línea del detalle), recortada. */
export function feedbackTaskTitle(f: Pick<Feedback, 'kind' | 'title' | 'body'>): string {
  const first = (f.title.trim() || f.body.trim().split('\n')[0]).trim();
  const short = first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
  return `${kindLabel(f.kind)}: ${short}`;
}

/** Prioridad de la tarea: la del impacto (solo si algo no funciona); si no, la normal. */
export const feedbackPriority = (f: Pick<Feedback, 'impact'>): Priority =>
  FEEDBACK_IMPACTS.find((x) => x.id === f.impact)?.priority ?? 4;
