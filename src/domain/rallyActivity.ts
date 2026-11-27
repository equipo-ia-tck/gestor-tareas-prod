/**
 * Más → Analítica → Rally: de todos los cambios que se hacen en Rally (discusiones, adjuntos, cambios de Flow State, Ready,
 * Blocked y altas), cuáles salen de la herramienta y cuáles se hacen directamente en Rally.
 *
 * Rally no dice desde dónde se hace un cambio, así que la herramienta apunta lo que escribe en Rally (tipo, el elemento con
 * una huella y la hora; tabla `rally_tool_events`, migración 011) y aquí se cruza: un cambio de Rally es «de la herramienta»
 * si hay uno apuntado del mismo tipo, en el mismo elemento y a menos de `MATCH_WINDOW_MS`.
 */

/** Lo que se ve en Rally. */
export type RallyChangeKind = 'comment' | 'attachment' | 'flow' | 'ready' | 'blocked' | 'create';
/** Lo que apunta la herramienta: un movimiento, Ready o Blocked es un `change` (puede tocar varios campos a la vez). */
export type ToolEventKind = 'comment' | 'attachment' | 'change' | 'create';

export const CHANGE_KINDS: { id: RallyChangeKind; label: string }[] = [
  { id: 'flow', label: 'Cambios de Flow State' },
  { id: 'comment', label: 'Discusiones' },
  { id: 'attachment', label: 'Archivos subidos' },
  { id: 'ready', label: 'Ready marcado o quitado' },
  { id: 'blocked', label: 'Blocked marcado o quitado' },
  { id: 'create', label: 'Elementos creados' },
];

/** Un cambio leído de Rally. `artifact`: FormattedID (US123…). `to`: el Flow State nuevo, si lo es. */
export interface RallyChange { kind: RallyChangeKind; artifact: string; user: string; at: string; to?: string | null }
export interface RallyActivity {
  changes: RallyChange[];
  /** Tipos que no se han podido leer (p. ej. si Rally no tiene el Lookback API para el historial de estados). */
  errors: { kinds: RallyChangeKind[]; message: string }[];
  /** Tipos con más cambios de los que se traen: la cifra es un mínimo. */
  truncated: RallyChangeKind[];
}

/** Lo apuntado por la herramienta (lo devuelve `admin_rally_tool`). `since`: el primero que se apuntó (null = ninguno). */
export interface ToolEvent { kind: ToolEventKind; hash: string; at: string }
export interface ToolReport { since: string | null; rows: ToolEvent[] }

export const MATCH_WINDOW_MS = 5 * 60 * 1000;

const toolKindOf = (k: RallyChangeKind): ToolEventKind => (k === 'flow' || k === 'ready' || k === 'blocked' ? 'change' : k);

/** Huella de un ID de Rally (16 caracteres hex de su SHA-256): así no se guarda qué elemento es. */
export async function artifactHash(formattedId: string): Promise<string> {
  const data = new TextEncoder().encode(formattedId.trim().toUpperCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Qué cambios de Rally ha hecho la herramienta. `hashes[i]` es la huella de `changes[i].artifact`. Cada apunte de la
 * herramienta cuenta para un solo cambio de cada tipo (un movimiento puede cambiar Flow State y Blocked a la vez), y se
 * elige el más cercano en el tiempo.
 */
export function matchTool(changes: RallyChange[], hashes: string[], tool: ToolEvent[], windowMs = MATCH_WINDOW_MS): boolean[] {
  const byKey = new Map<string, { t: number; i: number }[]>();
  tool.forEach((e, i) => {
    const k = `${e.kind}|${e.hash}`;
    byKey.set(k, [...(byKey.get(k) ?? []), { t: Date.parse(e.at), i }]);
  });
  const used = new Set<string>();
  const out = changes.map(() => false);
  // Primero los más cercanos: así dos cambios seguidos no se quitan el apunte que no es suyo.
  const pairs: { c: number; tool: number; d: number; kind: RallyChangeKind }[] = [];
  changes.forEach((c, ci) => {
    const t = Date.parse(c.at);
    for (const e of byKey.get(`${toolKindOf(c.kind)}|${hashes[ci]}`) ?? []) {
      const d = Math.abs(e.t - t);
      if (d <= windowMs) pairs.push({ c: ci, tool: e.i, d, kind: c.kind });
    }
  });
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    const k = `${p.tool}|${p.kind}`;
    if (out[p.c] || used.has(k)) continue;
    out[p.c] = true;
    used.add(k);
  }
  return out;
}

export interface Split { tool: number; rally: number }
export interface ActivitySummary {
  total: Split;
  byKind: (Split & { kind: RallyChangeKind; label: string })[];
  byPerson: (Split & { user: string })[];
  byWeek: (Split & { week: string })[];
  /** Cambios anteriores a que la herramienta empezara a apuntar (con margen): con `onlySince` no cuentan. */
  before: number;
}

const mondayOfIso = (iso: string) => {
  const d = new Date(iso);
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
};

/** ¿Es anterior a que la herramienta empezara a apuntar? Con el margen de la ventana: Rally guarda la hora un poco antes. */
export const beforeTracking = (at: string, since: string | null, windowMs = MATCH_WINDOW_MS) =>
  !since || Date.parse(at) < Date.parse(since) - windowMs;

/**
 * Totales: herramienta frente a Rally, por tipo, por persona (de Rally) y por semana. `onlySince`: dejar fuera lo anterior a
 * que la herramienta empezara a apuntar (entonces todo parecería de Rally).
 */
export function summarizeActivity(changes: RallyChange[], fromTool: boolean[], since: string | null, onlySince = false): ActivitySummary {
  const total: Split = { tool: 0, rally: 0 };
  const kinds = new Map<RallyChangeKind, Split>(CHANGE_KINDS.map((k) => [k.id, { tool: 0, rally: 0 }]));
  const people = new Map<string, Split>();
  const weeks = new Map<string, Split>();
  let before = 0;
  changes.forEach((c, i) => {
    if (beforeTracking(c.at, since)) { before += 1; if (onlySince) return; }
    const side = fromTool[i] ? 'tool' : 'rally';
    total[side] += 1;
    kinds.get(c.kind)![side] += 1;
    const p = people.get(c.user) ?? { tool: 0, rally: 0 };
    p[side] += 1;
    people.set(c.user, p);
    const w = mondayOfIso(c.at);
    const ws = weeks.get(w) ?? { tool: 0, rally: 0 };
    ws[side] += 1;
    weeks.set(w, ws);
  });
  return {
    total,
    byKind: CHANGE_KINDS.map((k) => ({ kind: k.id, label: k.label, ...kinds.get(k.id)! })),
    byPerson: [...people].map(([user, s]) => ({ user, ...s })).sort((a, b) => b.tool + b.rally - (a.tool + a.rally) || a.user.localeCompare(b.user, 'es')),
    byWeek: [...weeks].map(([week, s]) => ({ week, ...s })).sort((a, b) => a.week.localeCompare(b.week)),
    before,
  };
}

/** Clave de una persona para comparar nombres de Rally y de cuentas: sin tildes, mayúsculas, guiones ni espacios. */
export const personKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Los cambios hechos por las personas elegidas (null = todos), con su marca de herramienta. */
export function changesBy(changes: RallyChange[], fromTool: boolean[], people: string[] | null): { changes: RallyChange[]; fromTool: boolean[] } {
  if (!people) return { changes, fromTool };
  const keep = new Set(people.map(personKey));
  const idx = changes.map((c, i) => (keep.has(personKey(c.user)) ? i : -1)).filter((i) => i >= 0);
  return { changes: idx.map((i) => changes[i]), fromTool: idx.map((i) => fromTool[i]) };
}

/** Personas de Rally que han hecho cambios, con cuántos (más cambios primero). */
export function rallyPeople(changes: RallyChange[]): { name: string; count: number }[] {
  const by = new Map<string, { name: string; count: number }>();
  for (const c of changes) {
    const k = personKey(c.user);
    const e = by.get(k) ?? { name: c.user, count: 0 };
    e.count++;
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

/** Detalle de una persona de Rally (al pulsarla en Analítica): qué ha hecho, a qué columnas ha movido, qué elementos y cuándo. */
export interface PersonActivity {
  total: Split;
  byKind: { kind: RallyChangeKind; label: string; tool: number; rally: number }[];
  /** Columnas (Flow State) a las que ha movido elementos, de más a menos. */
  flowTo: { state: string; n: number }[];
  /** Elementos que ha tocado, los que más primero (y después el más reciente). */
  items: { artifact: string; n: number; tool: number; last: string }[];
  /** Sus cambios, el más nuevo primero. */
  rows: { change: RallyChange; tool: boolean; before: boolean }[];
}

export function personActivity(changes: RallyChange[], fromTool: boolean[], user: string, since: string | null, onlySince = false): PersonActivity {
  const key = personKey(user);
  const rows = changes.map((change, i) => ({ change, tool: fromTool[i], before: beforeTracking(change.at, since) }))
    .filter((r) => personKey(r.change.user) === key && !(onlySince && r.before))
    .sort((a, b) => b.change.at.localeCompare(a.change.at));
  const total: Split = { tool: 0, rally: 0 };
  const kinds = new Map<RallyChangeKind, Split>(CHANGE_KINDS.map((k) => [k.id, { tool: 0, rally: 0 }]));
  const flow = new Map<string, number>();
  const items = new Map<string, { artifact: string; n: number; tool: number; last: string }>();
  for (const r of rows) {
    const side = r.tool ? 'tool' : 'rally';
    total[side] += 1;
    kinds.get(r.change.kind)![side] += 1;
    if (r.change.kind === 'flow' && r.change.to) flow.set(r.change.to, (flow.get(r.change.to) ?? 0) + 1);
    const it = items.get(r.change.artifact) ?? { artifact: r.change.artifact, n: 0, tool: 0, last: r.change.at };
    it.n += 1;
    if (r.tool) it.tool += 1;
    if (r.change.at > it.last) it.last = r.change.at;
    items.set(r.change.artifact, it);
  }
  return {
    total,
    byKind: CHANGE_KINDS.map((k) => ({ kind: k.id, label: k.label, ...kinds.get(k.id)! })).filter((k) => k.tool + k.rally > 0),
    flowTo: [...flow].map(([state, n]) => ({ state, n })).sort((a, b) => b.n - a.n || a.state.localeCompare(b.state, 'es')),
    items: [...items.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last)),
    rows,
  };
}

/**
 * Hoy → «Rally · últimos cambios en lo tuyo»: lo que otras personas han hecho en tus elementos (los enlazados a tareas del
 * gestor y los que tienes de Assignee u Owner) en los últimos días. `create` = elemento nuevo para ti.
 */
export type RecentKind = 'comment' | 'attachment' | 'flow' | 'blocked' | 'create';
export interface RecentEvent {
  kind: RecentKind;
  /** FormattedID (US123…). */
  id: string;
  name: string;
  user: string;
  at: string;
  /** Columna nueva (`flow`), nombre del archivo (`attachment`) o true/false (`blocked`). */
  to?: string | null;
}
