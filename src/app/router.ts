import { useEffect, useState } from 'react';

export type Route =
  | { view: 'today' }
  | { view: 'week' }
  | { view: 'board' }
  | { view: 'all' }
  | { view: 'log' }
  | { view: 'review' }
  | { view: 'notes'; id?: string }
  | { view: 'calendar' }
  | { view: 'rally' }
  | { view: 'inbox' }
  | { view: 'projects' }
  | { view: 'project'; id: string }
  | { view: 'people' }
  | { view: 'person'; name: string }
  | { view: 'settings' }
  | { view: 'search'; q: string };

/** Enrutado por hash: funciona en local, en GitHub Pages y offline sin configuración. */
export function parseHash(hash: string): Route {
  const [view, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const arg = rest.join('/');
  switch (view) {
    case 'week': return { view: 'week' };
    case 'board': return { view: 'board' };
    case 'all': return { view: 'all' };
    case 'log': return { view: 'log' };
    case 'review': return { view: 'review' };
    case 'notes': return arg ? { view: 'notes', id: decodeURIComponent(arg) } : { view: 'notes' };
    case 'calendar': return { view: 'calendar' };
    case 'rally': return { view: 'rally' };
    case 'inbox': return { view: 'inbox' };
    case 'projects': return { view: 'projects' };
    case 'project': return arg ? { view: 'project', id: decodeURIComponent(arg) } : { view: 'projects' };
    case 'people': return { view: 'people' };
    case 'person': return arg ? { view: 'person', name: decodeURIComponent(arg) } : { view: 'people' };
    case 'settings': return { view: 'settings' };
    case 'search': return { view: 'search', q: decodeURIComponent(arg ?? '') };
    default: return { view: 'today' };
  }
}

export function routeHref(r: Route): string {
  switch (r.view) {
    case 'project': return `#/project/${encodeURIComponent(r.id)}`;
    case 'person': return `#/person/${encodeURIComponent(r.name)}`;
    case 'search': return `#/search/${encodeURIComponent(r.q)}`;
    case 'notes': return r.id ? `#/notes/${encodeURIComponent(r.id)}` : '#/notes';
    default: return `#/${r.view}`;
  }
}

export const navigate = (r: Route) => { window.location.hash = routeHref(r); };

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

/** Abre el buscador (pantalla Buscar) y pone el cursor en su cuadro. */
export function openSearch() {
  if (!window.location.hash.startsWith('#/search/')) navigate({ view: 'search', q: '' });
  requestAnimationFrame(() => setTimeout(() => document.getElementById('global-search')?.focus(), 0));
}
