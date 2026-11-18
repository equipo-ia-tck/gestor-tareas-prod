/**
 * KPIs de Más → Analítica por pantalla, para una persona o para todo el equipo (la misma cuenta con una o con todas las
 * cuentas). Funciones puras sobre el informe de `admin_usage` (migración 010).
 */
import type { UsageReport, UsageRow, UsageSnapshot, UsageUser } from './usage';

export interface KpiPart { label: string; value: number }
export interface Kpi {
  label: string;
  /** Cifra principal ya formateada («12», «40 %», «Sí»…). */
  value: string;
  /** Aclaración debajo («de 30 tareas pendientes»…). */
  hint?: string;
  /** En la vista de equipo: cuántas personas lo hacen (de cuántas). */
  people?: { n: number; of: number };
  /** Desglose («Doble clic 3 · Ficha de persona 1»). */
  parts?: KpiPart[];
}
export interface ScreenKpis {
  id: string;
  title: string;
  /** Pantalla(s) cuyas visitas se cuentan (vacío = sin bloque de visitas, p. ej. Feedback). */
  screens: string[];
  visits: { visits: number; quality: number; people: number; qualityPeople: number; avgSeconds: number | null } | null;
  kpis: Kpi[];
}

interface Scope {
  rows: UsageRow[];
  users: UsageUser[];
  states: NonNullable<UsageReport['states']>;
  team: boolean;
}

type Filter = { kind?: string; screen?: string | string[]; name?: string; detail?: string | string[] };
const inList = (v: string | undefined, f: string | string[] | undefined) => f === undefined || (Array.isArray(f) ? f.includes(v ?? '') : v === f);
const match = (r: UsageRow, f: Filter) => (f.kind === undefined || r.kind === f.kind) && inList(r.screen, f.screen)
  && inList(r.name ?? '', f.name) && inList(r.detail ?? '', f.detail);

/** Suma de una acción: su valor (cuántas cosas) o, si no lo tiene, cuántas veces. */
const measure = (r: UsageRow) => (r.kind === 'action' ? (r.value ?? r.count) : r.count);
const total = (s: Scope, f: Filter) => s.rows.filter((r) => match(r, f)).reduce((n, r) => n + measure(r), 0);
const peopleWith = (s: Scope, f: Filter) => new Set(s.rows.filter((r) => match(r, f) && measure(r) > 0).map((r) => r.user)).size;
const action = (name: string, extra: Omit<Filter, 'kind' | 'name'> = {}): Filter => ({ kind: 'action', name, ...extra });

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const snap = (s: Scope, k: keyof UsageSnapshot) => s.users.reduce((n, u) => n + Number(u.snapshot?.[k] ?? 0), 0);
const snapPeople = (s: Scope, k: keyof UsageSnapshot) => s.users.filter((u) => Number(u.snapshot?.[k] ?? 0) > 0).length;

function count(s: Scope, label: string, f: Filter, more: Partial<Kpi> = {}): Kpi {
  return { label, value: String(total(s, f)), ...(s.team ? { people: { n: peopleWith(s, f), of: s.users.length } } : {}), ...more };
}
function parts(s: Scope, name: string, labels: Record<string, string>, extra: Omit<Filter, 'kind' | 'name' | 'detail'> = {}): KpiPart[] {
  const known = Object.entries(labels).map(([detail, label]) => ({ label, value: total(s, action(name, { ...extra, detail })) }));
  const other = total(s, action(name, extra)) - known.reduce((n, p) => n + p.value, 0);
  return [...known, ...(other > 0 ? [{ label: 'Otros', value: other }] : [])].filter((p) => p.value > 0);
}
/** Desglose por todos los detalles que aparezcan (botones, columnas…), de más a menos. */
function byDetail(s: Scope, f: Filter, labels: Record<string, string> = {}): KpiPart[] {
  const m = new Map<string, number>();
  for (const r of s.rows) if (match(r, f)) m.set(r.detail ?? '', (m.get(r.detail ?? '') ?? 0) + measure(r));
  return [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([d, value]) => ({ label: labels[d] ?? (d || '—'), value }));
}

function visits(s: Scope, screens: string[]): ScreenKpis['visits'] {
  const f = { screen: screens };
  const v = total(s, { ...f, kind: 'screen' });
  const seconds = s.rows.filter((r) => r.kind === 'visit' && screens.includes(r.screen)).reduce((n, r) => n + (r.value ?? 0), 0);
  return {
    visits: v,
    quality: total(s, { ...f, kind: 'quality' }),
    people: peopleWith(s, { ...f, kind: 'screen' }),
    qualityPeople: peopleWith(s, { ...f, kind: 'quality' }),
    avgSeconds: v && seconds ? Math.round(seconds / v) : null,
  };
}

/** Última preferencia de cada persona del alcance. */
const statesOf = (s: Scope, name: string) => s.states.filter((x) => x.name === name);

const RALLY_BUTTONS: Record<string, string> = {
  search: 'Buscador', new: 'Nuevo en Rally', request: 'Crear con petición', refresh: 'Actualizar', disconnect: 'Desconectar',
  columns: 'Columnas', project: 'Proyecto', view: 'Vista', tags: 'Etiquetas', mine: 'Asignado a mí', 'hide-done': 'Ocultar terminadas',
  type: 'Tipos', open: 'Abrir ficha',
};
const RALLY_COLUMNS: Record<string, string> = {
  id: 'ID', name: 'Nombre', state: 'Estado', owner: 'Owner', assignee: 'Asignado', project: 'Proyecto', iteration: 'Iteración',
  release: 'Release', tags: 'Etiquetas', updated: 'Actualizado', points: 'Puntos', kind: 'Tipo',
};
const PROJECT_BUTTONS: Record<string, string> = {
  'mode-list': 'Lista', 'mode-board': 'Tablero', subproject: '+ Subproyecto', move: 'Mover…', delete: 'Eliminar',
  rename: 'Renombrar', color: 'Color', 'with-children': 'Ver también sus tareas',
};

/** Todos los KPIs del documento, pantalla a pantalla, para las cuentas de `userIds` (todas = vista de equipo). */
export function screenKpis(report: UsageReport, userIds: string[] | null): ScreenKpis[] {
  const ids = new Set(userIds ?? report.users.map((u) => u.id));
  const s: Scope = {
    rows: report.rows.filter((r) => ids.has(r.user)),
    users: report.users.filter((u) => ids.has(u.id)),
    states: (report.states ?? []).filter((x) => ids.has(x.user)),
    team: userIds === null || userIds.length > 1,
  };
  const block = (id: string, title: string, screens: string[], kpis: Kpi[]): ScreenKpis =>
    ({ id, title, screens, visits: screens.length ? visits(s, screens) : null, kpis });

  const commentParts = parts(s, 'rally-comment', { move: 'Al mover, bloquear o quitar Ready', 'need-review': 'Need Review', message: 'Mensaje al marcar Ready', free: 'Comentario suelto' });
  const analystYes = total(s, action('analyst', { detail: 'yes' }));
  const analystNo = total(s, action('analyst', { detail: 'no' }));
  const analystCancel = total(s, action('analyst', { detail: 'cancel' }));
  const calendarOn = statesOf(s, 'calendar-tasks');
  const columns = new Map<string, number>();
  for (const st of statesOf(s, 'rally-columns')) for (const c of st.detail.split(',').filter(Boolean)) columns.set(c, (columns.get(c) ?? 0) + 1);
  const connected = s.users.filter((u) => u.snapshot?.rallyConnected).length;

  return [
    block('today', 'Hoy', ['today'], []),
    block('inbox', 'Bandeja', ['inbox'], [
      { label: 'Tareas creadas con la herramienta', value: String(snap(s, 'tasksCreated')), hint: 'en todo el gestor, en el periodo',
        ...(s.team ? { people: { n: snapPeople(s, 'tasksCreated'), of: s.users.length } } : {}),
        parts: screenParts(s, 'task-create') },
      count(s, 'Tareas creadas desde la Bandeja', action('task-create', { screen: 'inbox' })),
    ]),
    block('board', 'Tablero', ['board'], [
      count(s, 'Tareas movidas de estado en el tablero', action('state-change', { screen: 'board' })),
      count(s, 'Movimientos enviados a Rally', action('rally-move'), { hint: 'desde cualquier pantalla del gestor' }),
      count(s, 'Cambios que llegan desde Rally', action('rally-in'), { hint: 'tareas que se mueven solas porque han cambiado en Rally' }),
      count(s, 'Discusiones publicadas por la app', action('rally-comment'), { parts: commentParts }),
      count(s, 'Discusiones sin cambio de estado', action('rally-comment', { detail: ['free', 'message'] })),
      { ...count(s, 'Discusiones editadas', action('rally-comment-edit')) },
      { ...count(s, 'Discusiones eliminadas', action('rally-comment-delete')) },
      count(s, 'Archivos subidos a Rally', action('rally-attach')),
      count(s, 'Archivos eliminados de Rally', action('rally-attach-delete')),
      { label: 'Nombran analista al comentar un cambio de estado', value: pct(analystYes, analystYes + analystNo),
        hint: `${analystYes} con analista · ${analystNo} sin analista · ${analystCancel} cancelados`,
        ...(s.team ? { people: { n: peopleWith(s, action('analyst', { detail: 'yes' })), of: s.users.length } } : {}) },
      { label: 'Tareas de Rally pendientes en el tablero', value: String(snap(s, 'rallyActive')),
        ...(s.team ? { people: { n: snapPeople(s, 'rallyActive'), of: s.users.length } } : {}) },
      { label: 'Pendientes con fecha', value: pct(snap(s, 'activeWithDate'), snap(s, 'tasksActive')), hint: `${snap(s, 'activeWithDate')} de ${snap(s, 'tasksActive')} tareas pendientes` },
      { label: 'Pendientes con proyecto', value: pct(snap(s, 'activeWithProject'), snap(s, 'tasksActive')), hint: `${snap(s, 'activeWithProject')} de ${snap(s, 'tasksActive')} tareas pendientes` },
      { label: 'Creadas en el periodo con fecha / con proyecto', value: `${pct(snap(s, 'createdWithDate'), snap(s, 'tasksCreated'))} / ${pct(snap(s, 'createdWithProject'), snap(s, 'tasksCreated'))}`,
        hint: `de ${snap(s, 'tasksCreated')} tareas creadas` },
    ]),
    block('calendar', 'Calendario', ['calendar'], [
      { label: 'Tienen activado «Tareas» en el calendario',
        value: s.team ? `${calendarOn.filter((x) => x.value === 1).length} de ${calendarOn.length}` : (calendarOn[0] ? (calendarOn[0].value === 1 ? 'Sí' : 'No') : '—'),
        hint: s.team ? 'personas que han abierto el calendario' : undefined },
      count(s, 'Se unen a reuniones desde la herramienta', action('meeting-join'), { parts: parts(s, 'meeting-join', { calendar: 'Calendario', notes: 'Acta' }) }),
      count(s, 'Reuniones creadas', action('meeting-create'), { parts: parts(s, 'meeting-create', { dblclick: 'Doble clic en la hora', person: 'Ficha de persona', rally: 'Al entregar en Rally' }) }),
      count(s, 'Botón «Nuevo» del calendario', action('calendar-new'), { hint: 'abre la captura de tareas (no crea reuniones)' }),
    ]),
    block('notes', 'Notas', ['notes'], [
      { label: 'Notas creadas', value: String(snap(s, 'notesCreated')), hint: `${snap(s, 'notesTotal')} notas en total`,
        ...(s.team ? { people: { n: snapPeople(s, 'notesCreated'), of: s.users.length } } : {}) },
      count(s, 'Tareas creadas desde notas', action('task-from-note'), { parts: parts(s, 'task-from-note', { action: 'Acciones del acta', line: '→ Tarea en una línea' }) }),
      { label: 'Tareas salidas de notas que se han completado', value: pct(snap(s, 'tasksFromNotesDone'), snap(s, 'tasksFromNotes')),
        hint: `${snap(s, 'tasksFromNotesDone')} de ${snap(s, 'tasksFromNotes')}` },
      { label: 'Secciones (proyectos) que tienen', value: String(snap(s, 'sections')),
        hint: `${pct(snap(s, 'notesInSection'), snap(s, 'notesTotal'))} de las notas están dentro de una sección`,
        ...(s.team ? { people: { n: snapPeople(s, 'sections'), of: s.users.length } } : {}) },
      count(s, 'Secciones creadas desde Notas', action('section-create')),
    ]),
    block('rally', 'Rally', ['rally'], [
      { label: 'Tienen Rally conectado', value: s.team ? `${connected} de ${s.users.length}` : (connected ? 'Sí' : 'No'),
        hint: s.team ? pct(connected, s.users.length) + ' de las cuentas' : undefined },
      count(s, 'Elementos creados en Rally', action('rally-create'), { parts: parts(s, 'rally-create', { form: 'Nuevo en Rally', request: 'Crear con petición', task: 'Tarea dentro de una US' }) }),
      count(s, 'Uso de los botones de la pantalla', action('rally-button'), { parts: byDetail(s, action('rally-button'), RALLY_BUTTONS) }),
      count(s, 'Pasar a mis tareas del gestor', action('rally-add'), {
        hint: 'tareas añadidas',
        parts: [
          { label: 'De una en una', value: total(s, action('rally-add', { detail: ['one.project', 'one.none'] })) },
          { label: 'Todas de golpe', value: total(s, action('rally-add', { detail: ['all.project', 'all.none'] })) },
          { label: 'Con proyecto', value: total(s, action('rally-add', { detail: ['one.project', 'all.project'] })) },
          { label: 'Sin proyecto', value: total(s, action('rally-add', { detail: ['one.none', 'all.none'] })) },
        ].filter((p) => p.value > 0) }),
      { label: 'Columnas que se muestran', value: String(statesOf(s, 'rally-columns').length), hint: 'personas con columnas elegidas',
        parts: [...columns].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ label: RALLY_COLUMNS[c] ?? c, value: n })) },
    ]),
    block('project', 'Proyecto', ['project'], [
      { label: 'Proyectos creados', value: String(snap(s, 'projectsCreated')), hint: 'en el periodo, desde cualquier sitio',
        ...(s.team ? { people: { n: snapPeople(s, 'projectsCreated'), of: s.users.length } } : {}) },
      count(s, 'Cambios de estado dentro de un proyecto', action('state-change', { screen: 'project' })),
      count(s, 'Uso de los botones de la barra superior', action('project-button'), { parts: byDetail(s, action('project-button'), PROJECT_BUTTONS) }),
    ]),
    block('people', 'Grupos', ['people'], [
      count(s, 'Grupos creados', action('group-create'), { hint: `${snap(s, 'groups')} grupos en total` }),
      { label: 'Personas asignadas a un grupo', value: String(snap(s, 'peopleInGroup')), hint: `de ${snap(s, 'peopleCards')} fichas`,
        ...(s.team ? { people: { n: snapPeople(s, 'peopleInGroup'), of: s.users.length } } : {}) },
    ]),
    block('person', 'Personas', ['person'], [
      { label: 'Fichas con email', value: pct(snap(s, 'peopleWithEmail'), snap(s, 'peopleCards')), hint: `${snap(s, 'peopleWithEmail')} de ${snap(s, 'peopleCards')} fichas` },
      { label: 'Fichas con puesto', value: pct(snap(s, 'peopleWithRole'), snap(s, 'peopleCards')), hint: `${snap(s, 'peopleWithRole')} de ${snap(s, 'peopleCards')} fichas` },
      count(s, 'Usan «Chat en Teams»', action('person-chat')),
      count(s, 'Crean reuniones desde la ficha', action('meeting-create', { detail: 'person' })),
      count(s, 'Renombran o unen personas', action('person-rename')),
      count(s, 'Eliminan personas', action('person-delete')),
    ]),
    block('review', 'Revisión semanal', ['review'], [
      count(s, 'Empiezan el proceso', action('review-start')),
      count(s, 'Lo acaban', action('review-done'), { hint: pct(total(s, action('review-done')), total(s, action('review-start'))) + ' de los que empiezan' }),
    ]),
    block('log', 'Registro', ['log'], []),
    block('feedback', 'Feedback', [], [
      count(s, 'Pulsan el botón de feedback', action('feedback-open')),
      count(s, 'Envían feedback', action('feedback-send')),
      count(s, 'Cancelan o cierran sin enviar', action('feedback-cancel')),
    ]),
  ];
}

/** Desglose de una acción por pantalla («Tablero 3 · Rally 2»). */
function screenParts(s: Scope, name: string): KpiPart[] {
  const m = new Map<string, number>();
  for (const r of s.rows) if (r.kind === 'action' && r.name === name) m.set(r.screen, (m.get(r.screen) ?? 0) + measure(r));
  return [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([screen, value]) => ({ label: SCREEN_NAMES[screen] ?? screen, value }));
}
const SCREEN_NAMES: Record<string, string> = {
  today: 'Hoy', inbox: 'Bandeja', board: 'Tablero', calendar: 'Calendario', notes: 'Notas', rally: 'Rally', project: 'Proyecto',
  people: 'Grupos', person: 'Persona', search: 'Buscar', review: 'Revisión', log: 'Registro', settings: 'Ajustes',
};

export const formatSeconds = (s: number | null) => (s === null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim());
