/** Feedback de los usuarios (tabla `feedback` de Supabase, migración 006). Solo lo leen los administradores. */
export type FeedbackKind = 'improvement' | 'bug' | 'other';
export type FeedbackStatus = 'new' | 'doing' | 'done' | 'dismissed';

export interface Feedback {
  id: string;
  authorName: string;
  authorLogin: string;
  kind: FeedbackKind;
  body: string;
  /** Pantalla desde la que se envió (el hash: `#/board`…). */
  page: string;
  userAgent: string;
  status: FeedbackStatus;
  /** Tarea del gestor creada a partir de él. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: 'improvement', label: 'Mejora', hint: 'Algo que haría la herramienta más útil' },
  { id: 'bug', label: 'Algo roto', hint: 'Algo que no funciona como debería' },
  { id: 'other', label: 'Otro', hint: 'Dudas, ideas o cualquier otra cosa' },
];

export const FEEDBACK_STATUSES: { id: FeedbackStatus; label: string }[] = [
  { id: 'new', label: 'Nuevo' },
  { id: 'doing', label: 'En curso' },
  { id: 'done', label: 'Hecho' },
  { id: 'dismissed', label: 'Descartado' },
];

export const kindLabel = (k: FeedbackKind) => FEEDBACK_KINDS.find((x) => x.id === k)?.label ?? k;
export const statusLabel = (s: FeedbackStatus) => FEEDBACK_STATUSES.find((x) => x.id === s)?.label ?? s;

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

/** Título de la tarea creada desde un feedback: tipo y la primera línea, recortada. */
export function feedbackTaskTitle(f: Pick<Feedback, 'kind' | 'body'>): string {
  const first = f.body.trim().split('\n')[0].trim();
  const short = first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
  return `${kindLabel(f.kind)}: ${short}`;
}
