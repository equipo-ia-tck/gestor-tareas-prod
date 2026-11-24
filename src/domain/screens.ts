import type { Route } from '../app/router';

/**
 * Pantallas que un administrador puede ocultar a cada persona (Ajustes → Pantallas; migración 013). Hoy y Ajustes
 * siempre se ven, y Feedback y Analítica ya son solo de administradores. Ocultar una pantalla quita su entrada de la
 * barra lateral y no deja abrirla, pero no cambia qué datos ve nadie.
 */
export const SCREENS: { id: string; label: string; hint?: string }[] = [
  { id: 'inbox', label: 'Bandeja' },
  { id: 'board', label: 'Tablero' },
  { id: 'calendar', label: 'Calendario', hint: 'también la semana' },
  { id: 'notes', label: 'Notas' },
  { id: 'asistente', label: 'Asistente' },
  { id: 'rally', label: 'Rally' },
  { id: 'lista', label: 'Lista' },
  { id: 'sharepoint', label: 'SharePoint', hint: 'carpetas de SharePoint' },
  { id: 'projects', label: 'Proyectos', hint: 'la sección de la barra lateral y cada proyecto' },
  { id: 'people', label: 'Grupos y personas', hint: 'la sección de la barra lateral y las fichas' },
  { id: 'review', label: 'Revisión semanal' },
  { id: 'log', label: 'Registro' },
  { id: 'search', label: 'Buscar' },
];

export const SCREEN_IDS = SCREENS.map((s) => s.id);

/**
 * Pantallas ocultas para todo el mundo, administradores incluidos, además de lo que diga Ajustes → Pantallas. Para
 * apagar una pantalla sin tocar Supabase (p. ej. mientras no esté lista). Vacía: lo decide Ajustes → Pantallas.
 */
export const HIDDEN_FOR_ALL: string[] = [];

/** La pantalla (del catálogo) a la que pertenece una ruta; null = siempre visible (Hoy, Ajustes, las de administración). */
export function screenOf(view: Route['view']): string | null {
  switch (view) {
    case 'week': return 'calendar';
    case 'all': return 'board';
    case 'project': return 'projects';
    case 'person': return 'people';
    default: return SCREEN_IDS.includes(view) ? view : null;
  }
}

export const isHiddenRoute = (view: Route['view'], hidden: readonly string[]) => {
  const screen = screenOf(view);
  return !!screen && (hidden.includes(screen) || HIDDEN_FOR_ALL.includes(screen));
};
