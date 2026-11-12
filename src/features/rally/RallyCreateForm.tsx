import { useMemo, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Ban, Check, Paperclip, Plus, Wand2, X } from 'lucide-react';
import { inputClass } from '../../components/ui/styles';
import {
  RALLY_COLORS, type RallyCreatableKind, type RallyCreateInput, type RallyFormOptions, type RallyItem, type RallyPick, type RallyProject, type RallyRef,
} from '../../domain/rally';
import { usePersistentState } from '../../hooks/usePersistentState';
import { MAX_UPLOAD, MAX_UPLOAD_LABEL, rallyApi, toBase64, tooBigMessage } from './rallyApi';
import { localLoad, ParentField, PersonPicker, ValuesField } from './RallyPickers';
import { fold } from '../../domain/text';

/**
 * Datos ya rellenados por «Crear con petición». Personas, etiquetas y padre llegan buscados en Rally; estado, release,
 * iteración y campos de defecto llegan como texto y se buscan al cargar las opciones del proyecto. `warnings`: lo que no
 * se ha podido entender o encontrar, que se muestra arriba para revisarlo.
 */
export interface RallyPrefill {
  source: string;
  kind?: RallyCreatableKind;
  name?: string;
  projectId?: string;
  /** `@me`: la persona conectada (se sabe al cargar las opciones). */
  owner?: RallyRef | '@me';
  assignee?: RallyRef | '@me';
  state?: string;
  release?: string;
  iteration?: string;
  tags?: RallyRef[];
  parent?: RallyPick;
  feature?: RallyPick;
  estimate?: number;
  /** Feature: talla de Preliminary Estimate (se busca en las opciones) y fechas planificadas ya en ISO. */
  preliminaryEstimate?: string;
  plannedStart?: string;
  plannedEnd?: string;
  milestones?: string[];
  description?: string;
  notes?: string;
  color?: string;
  ready?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  expedite?: boolean;
  defect?: Record<string, string>;
  warnings: string[];
}

const same = (a: string, b: string) => fold(a).replace(/[^a-z0-9]/g, '') === fold(b).replace(/[^a-z0-9]/g, '');
/** Opción por nombre: igual (sin tildes ni signos), si no la que lo contiene. */
function byName<T>(list: T[], name: string, nameOf: (t: T) => string): T | undefined {
  const key = fold(name).replace(/[^a-z0-9]/g, '');
  return list.find((t) => same(nameOf(t), name)) ?? list.find((t) => key && fold(nameOf(t)).replace(/[^a-z0-9]/g, '').includes(key));
}

/** Tipos del desplegable «Work Item Types» de Rally (más las tareas, que van dentro de una US o un defecto). */
const KINDS: { kind: RallyCreatableKind; label: string }[] = [
  { kind: 'FE', label: 'Feature' },
  { kind: 'US', label: 'User Story' },
  { kind: 'DE', label: 'Defect' },
  { kind: 'DS', label: 'Defect Suite' },
  { kind: 'TS', label: 'Test Set' },
  { kind: 'TA', label: 'Task' },
];
const US = { key: 'US', label: 'User Story' };
export const PARENT: Partial<Record<RallyCreatableKind, { label: string; types: { key: string; label: string }[]; required?: boolean }>> = {
  // El padre de una feature es un portfolio item de nivel superior (Initiative, Epic…), a menudo de otro proyecto.
  FE: { label: 'Parent', types: [{ key: 'PI', label: 'Portfolio item' }] },
  US: { label: 'Parent', types: [US] },
  DE: { label: 'User Story', types: [US] },
  TA: { label: 'Work Product', types: [US, { key: 'DE', label: 'Defect' }], required: true },
};
const FEATURE = [{ key: 'F', label: 'Feature' }];

const labelClass = 'mb-1 block text-sm font-semibold text-zinc-600 dark:text-zinc-300';

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <span className={labelClass}>{label}{required && <span className="text-red-600"> *</span>}</span>
      {children}
    </div>
  );
}

/** Interruptor como el «Expedite» de Rally. */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? 'left-5.5' : 'left-0.5'}`} />
    </button>
  );
}

/**
 * Alta de un elemento en Rally con el mismo formulario que su «New Item»: tipo, nombre, Ready/Blocked, color, Owner,
 * Assignee, proyecto, Schedule State, Flow State, estimación, descripción, padre, etiquetas, release, iteración,
 * milestones, Expedite, feature, adjuntos, notas, campos de defecto y los personalizados obligatorios.
 * Pie como en Rally: Discard, Create + New (crea y deja el formulario listo para otro: se vacían nombre, descripción,
 * notas, adjuntos, estimaciones, color y Ready/Blocked; se quedan tipo, proyecto, personas, padre, etiquetas, release,
 * iteración y estados) y Create.
 * `onCreated` recibe el elemento creado, si hay que añadirlo también al gestor y si el formulario sigue abierto. `defaultTags`: las etiquetas del filtro
 * de la pantalla Rally, que salen ya puestas (se pueden quitar o añadir más).
 */
export function RallyCreateForm({ projects, defaultProjectId, defaultTags = [], prefill, onCreated, onCancel }: {
  projects: RallyProject[];
  defaultProjectId: string | null;
  defaultTags?: RallyRef[];
  prefill?: RallyPrefill;
  onCreated: (item: RallyItem, addToGestor: boolean, keepOpen: boolean) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = usePersistentState<RallyCreatableKind>('rally-new-kind', 'US');
  const [lastProject, setLastProject] = usePersistentState('rally-new-project', '');
  const [assignToMe, setAssignToMe] = usePersistentState('rally-new-assign', true);
  const [addToGestor, setAddToGestor] = usePersistentState('rally-new-add', true);
  const [projectId, setProjectId] = useState(() =>
    [prefill?.projectId, lastProject, defaultProjectId].find((id) => id && projects.some((p) => p.id === id)) ?? '');

  const [options, setOptions] = useState<RallyFormOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [name, setName] = useState(prefill?.name ?? '');
  const [ready, setReady] = useState(prefill?.ready ?? false);
  const [blocked, setBlocked] = useState(prefill?.blocked ?? false);
  const [blockedReason, setBlockedReason] = useState(prefill?.blockedReason ?? '');
  const [color, setColor] = useState(prefill?.color ?? '');
  const [owner, setOwner] = useState<RallyRef | null>(prefill?.owner && prefill.owner !== '@me' ? prefill.owner : null);
  const [assignee, setAssignee] = useState<RallyRef | null>(prefill?.assignee && prefill.assignee !== '@me' ? prefill.assignee : null);
  const [scheduleState, setScheduleState] = useState('');
  const [flowStateRef, setFlowStateRef] = useState('');
  const [state, setState] = useState('');
  const [planEstimate, setPlanEstimate] = useState(prefill?.estimate !== undefined ? String(prefill.estimate) : '');
  const [toDo, setToDo] = useState('');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [parent, setParent] = useState<RallyPick | null>(prefill?.parent ?? null);
  const [tags, setTags] = useState<RallyRef[]>(prefill?.tags?.length ? prefill.tags : defaultTags);
  const [releaseRef, setReleaseRef] = useState('');
  const [iterationRef, setIterationRef] = useState('');
  const [milestones, setMilestones] = useState<RallyRef[]>([]);
  const [expedite, setExpedite] = useState(prefill?.expedite ?? false);
  const [feature, setFeature] = useState<RallyPick | null>(prefill?.feature ?? null);
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState(prefill?.notes ?? '');
  const [defect, setDefect] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  // Feature: estado de portfolio, talla (Preliminary Estimate) y fechas planificadas.
  const [portfolioStateRef, setPortfolioStateRef] = useState('');
  const [estimateRef, setEstimateRef] = useState('');
  const [plannedStart, setPlannedStart] = useState(prefill?.plannedStart ?? '');
  const [plannedEnd, setPlannedEnd] = useState(prefill?.plannedEnd ?? '');

  const [busy, setBusy] = useState<string | null>(null);
  // «Crear con petición»: lo que depende de las opciones del proyecto se aplica una vez, al cargarlas.
  const pending = useRef(prefill ?? null);
  const [warnings, setWarnings] = useState<string[]>(prefill?.warnings ?? []);
  useEffect(() => { if (prefill?.kind) setKind(prefill.kind); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  /** «Create + New»: el último creado sin cerrar el formulario. */
  const [lastCreated, setLastCreated] = useState<RallyItem | null>(null);
  const again = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isTask = kind === 'TA';
  const isFeature = kind === 'FE';

  // Opciones del tipo en el proyecto; al cambiar, se quedan solo los valores que siguen existiendo.
  useEffect(() => {
    if (!projectId) { setOptions(null); return; }
    let live = true;
    setOptions(null);
    setOptionsError(null);
    rallyApi.formOptions(kind, projectId).then((o) => {
      if (!live) return;
      setOptions(o);
      const has = (list: RallyRef[], r: string) => list.some((x) => x.ref === r);
      // Owner y Assignee pueden ser de fuera del equipo (buscados en Rally): se conservan al cambiar de proyecto.
      setOwner((u) => u ?? o.me);
      setAssignee((u) => u ?? (assignToMe ? o.me : null));
      setFlowStateRef((r) => (has(o.flowStates, r) ? r : o.flowStates[0]?.ref ?? ''));
      setScheduleState((s) => (o.scheduleStates.includes(s) ? s : o.flowStates[0]?.scheduleState ?? o.scheduleStates[0] ?? ''));
      setState((s) => (o.taskStates.includes(s) ? s : o.taskStates[0] ?? ''));
      setReleaseRef((r) => (has(o.releases, r) ? r : ''));
      setIterationRef((r) => (has(o.iterations, r) ? r : ''));
      setMilestones((list) => list.filter((m) => has(o.milestones, m.ref)));
      setPortfolioStateRef((r) => (has(o.portfolioStates, r) ? r : o.portfolioStates[0]?.ref ?? ''));
      setEstimateRef((r) => (has(o.preliminaryEstimates, r) ? r : ''));
      const p = pending.current;
      if (p && (!p.kind || p.kind === kind) && (!p.projectId || p.projectId === projectId)) {
        pending.current = null;
        const missing: string[] = [];
        if (p.owner === '@me') setOwner(o.me);
        if (p.assignee === '@me') setAssignee(o.me);
        if (p.state) {
          if (kind === 'TA') { const st = byName(o.taskStates, p.state, (x) => x); if (st) setState(st); else missing.push(`estado «${p.state}»`); }
          else if (kind === 'FE') { const st = byName(o.portfolioStates, p.state, (x) => x.name); if (st) setPortfolioStateRef(st.ref); else missing.push(`estado «${p.state}»`); }
          else {
            const flow = byName(o.flowStates, p.state, (x) => x.name);
            const sched = byName(o.scheduleStates, p.state, (x) => x);
            if (flow) { setFlowStateRef(flow.ref); if (flow.scheduleState) setScheduleState(flow.scheduleState); }
            else if (sched) { setScheduleState(sched); setFlowStateRef(o.flowStates.find((f) => f.scheduleState === sched)?.ref ?? ''); }
            else missing.push(`estado «${p.state}»`);
          }
        }
        if (p.release) { const r = byName(o.releases, p.release, (x) => x.name); if (r) setReleaseRef(r.ref); else missing.push(`release «${p.release}»`); }
        if (p.iteration) {
          const it = byName(o.iterations, p.iteration, (x) => x.name);
          if (it && kind !== 'FE') setIterationRef(it.ref); else missing.push(`iteración «${p.iteration}»`);
        }
        if (p.preliminaryEstimate) {
          const e = kind === 'FE' ? byName(o.preliminaryEstimates, p.preliminaryEstimate, (x) => x.name) : undefined;
          if (e) setEstimateRef(e.ref);
          else missing.push(kind === 'FE' ? `Preliminary Estimate «${p.preliminaryEstimate}»` : `Preliminary Estimate (solo en features)`);
        }
        if (p.milestones?.length) {
          const found = p.milestones.map((m) => byName(o.milestones, m, (x) => x.name));
          setMilestones(found.filter((m): m is RallyRef => !!m));
          p.milestones.forEach((m, i) => { if (!found[i]) missing.push(`milestone «${m}»`); });
        }
        if (p.defect && kind === 'DE') {
          const next: Record<string, string> = {};
          for (const [f, v] of Object.entries(p.defect)) { const m = byName(o.values[f] ?? [], v, (x) => x); if (m) next[f] = m; else missing.push(`${f} «${v}»`); }
          setDefect((d) => ({ ...d, ...next }));
        }
        if (missing.length) setWarnings((w) => [...w, ...missing.map((m) => `No está en este proyecto: ${m}`)]);
      }
    }, (e: Error) => live && setOptionsError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assignToMe solo da el valor inicial
  }, [kind, projectId]);

  // Columnas del Schedule State elegido (como en Rally, elegir uno lleva a su primera columna y al revés).
  const flowFor = (s: string) => options?.flowStates.find((f) => f.scheduleState === s)?.ref;
  const pickSchedule = (s: string) => {
    setScheduleState(s);
    const current = options?.flowStates.find((f) => f.ref === flowStateRef);
    if (current?.scheduleState !== s) setFlowStateRef(flowFor(s) ?? '');
  };
  const pickFlow = (ref: string) => {
    setFlowStateRef(ref);
    const mapped = options?.flowStates.find((f) => f.ref === ref)?.scheduleState;
    if (mapped) setScheduleState(mapped);
  };

  const missingCustom = (options?.custom ?? []).filter((c) => !custom[c.field]?.trim());
  const badDates = isFeature && !!plannedStart && !!plannedEnd && plannedStart > plannedEnd;
  const ready_ = !!name.trim() && !!projectId && !!options && (!isTask || !!parent) && missingCustom.length === 0 && !badDates;
  const tooBig = files.find((f) => f.size > MAX_UPLOAD);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const keepOpen = again.current;
    again.current = false;
    if (!ready_ || busy || tooBig) return;
    setBusy('Creando en Rally…');
    setError(null);
    const n = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    const input: RallyCreateInput = {
      kind, name, projectId, description, notes, ownerRef: owner?.ref ?? '', assigneeRef: isFeature ? '' : assignee?.ref ?? '', color, ready,
      blocked: blocked && !isFeature, blockedReason: blocked && !isFeature ? blockedReason : '',
      tagRefs: tags.map((t) => t.ref), milestoneRefs: milestones.map((m) => m.ref), releaseRef, iterationRef: isFeature ? '' : iterationRef,
      ...(parent && PARENT[kind] ? { parentId: parent.id } : {}),
      ...(isTask
        ? { state, estimate: n(planEstimate), toDo: n(toDo) }
        : isFeature
          ? { portfolioStateRef, preliminaryEstimateRef: estimateRef, plannedStart, plannedEnd }
          : { scheduleState, flowStateRef, planEstimate: n(planEstimate), expedite }),
      ...(kind === 'US' && feature ? { featureId: feature.id } : {}),
      ...(kind === 'DE' ? { severity: defect.Severity, priority: defect.Priority, state: defect.State, environment: defect.Environment } : {}),
      custom,
    };
    let item: RallyItem;
    try {
      item = await rallyApi.create(input);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      return;
    }
    setLastProject(projectId);
    // Los adjuntos se suben después, de uno en uno; si alguno falla, el elemento ya está creado.
    const failed: string[] = [];
    for (const [i, file] of files.entries()) {
      setBusy(`Subiendo adjunto ${i + 1} de ${files.length}…`);
      try {
        await rallyApi.attach(item, { name: file.name, contentType: file.type, content: await toBase64(file) });
      } catch {
        failed.push(file.name);
      }
    }
    if (failed.length) window.alert(`${item.id} se ha creado, pero no se han podido adjuntar: ${failed.join(', ')}. Adjúntalos desde su ficha.`);
    onCreated(item, addToGestor, keepOpen);
    if (!keepOpen) return;
    setBusy(null);
    setLastCreated(item);
    setName(''); setDescription(''); setNotes(''); setFiles([]); setPlanEstimate(''); setToDo(''); setColor('');
    setReady(false); setBlocked(false); setBlockedReason('');
    if (fileInput.current) fileInput.current.value = '';
    requestAnimationFrame(() => nameInput.current?.focus());
  }

  const select = (value: string, onChange: (v: string) => void, list: { value: string; label: string }[], placeholder: string, label: string) => (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={!options}>
      <option value="">{options ? placeholder : projectId ? 'Cargando…' : 'Elige antes el proyecto'}</option>
      {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const refOptions = (list: RallyRef[] = []) => list.map((r) => ({ value: r.ref, label: r.name }));
  const milestoneLoad = useMemo(() => localLoad(options?.milestones ?? []), [options]);
  const colorHex = RALLY_COLORS.find((c) => c.hex === color)?.hex;
  const parentInfo = PARENT[kind];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30 dark:bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <form role="dialog" aria-modal="true" aria-label="Nuevo elemento en Rally" onSubmit={submit}
        onKeyDown={(e) => {
          // Esc en un desplegable (portal) lo cierra a él, no al panel.
          if (e.key === 'Escape' && !busy && e.currentTarget.contains(e.target as Node)) { e.preventDefault(); onCancel(); }
        }}
        className="flex h-full w-full max-w-md flex-col bg-zinc-50 shadow-2xl dark:bg-zinc-900">
        <header className="flex items-center gap-2 bg-[#0b2b5b] px-4 py-3 text-white">
          <h2 className="flex-1 text-lg font-semibold">Nuevo elemento</h2>
          <button type="button" onClick={onCancel} disabled={!!busy} className="rounded p-1 hover:bg-white/15" aria-label="Cerrar"><X className="size-5" /></button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 text-sm">
          {prefill && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <p className="flex items-center gap-1 font-semibold"><Wand2 className="size-3.5" />Rellenado con tu petición: revísalo antes de crear</p>
              <p className="mt-0.5 italic text-amber-800 dark:text-amber-200">«{prefill.source}»</p>
              {warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              )}
            </div>
          )}
          <Field label="Work Item Type" required>
            <select className={inputClass} value={kind} aria-label="Tipo" onChange={(e) => {
              const next = e.target.value as RallyCreatableKind;
              setKind(next);
              setParent((p) => (p && PARENT[next]?.types.some((t) => p.id.toUpperCase().startsWith(t.key)) ? p : null));
            }}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </Field>

          <Field label="Name" required>
            <input ref={nameInput} autoFocus className={`${inputClass} ${name.trim() ? '' : 'border-red-400'}`} value={name} onChange={(e) => setName(e.target.value)}
              maxLength={256} aria-label="Nombre" />
          </Field>

          <Field label="Status">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setReady(!ready)} aria-pressed={ready}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 ${ready ? 'border-green-600 bg-green-600 text-white' : 'border-indigo-600 text-indigo-700 dark:text-indigo-300'}`}>
                <Check className="size-4" /> Ready
              </button>
              {!isFeature && <button type="button" onClick={() => setBlocked(!blocked)} aria-pressed={blocked}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 ${blocked ? 'border-red-600 bg-red-600 text-white' : 'border-indigo-600 text-indigo-700 dark:text-indigo-300'}`}>
                <Ban className="size-4" /> Blocked
              </button>}
            </div>
            {blocked && !isFeature && (
              <input className={`${inputClass} mt-2`} value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} maxLength={256}
                placeholder="Motivo del bloqueo (opcional)" aria-label="Motivo del bloqueo" />
            )}
          </Field>

          <Field label="Color">
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 rounded-full border border-zinc-300"
                style={{ background: colorHex ?? 'transparent' }} />
              <select className={`${inputClass} pl-7`} value={color} onChange={(e) => setColor(e.target.value)} aria-label="Color">
                <option value="">Sin color</option>
                {RALLY_COLORS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
              </select>
            </div>
          </Field>

          <Field label="Owner">
            <PersonPicker label="Owner" value={owner} onChange={setOwner} me={options?.me ?? null} team={options?.users ?? []} loading={!options && !!projectId} />
          </Field>
          {!isFeature && (
            <Field label="Assignee">
              <PersonPicker label="Assignee" value={assignee} me={options?.me ?? null} team={options?.users ?? []} loading={!options && !!projectId}
                onChange={(u) => { setAssignee(u); setAssignToMe(!!u && u.ref === options?.me.ref); }} />
            </Field>
          )}

          <Field label="Project" required>
            <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Proyecto de Rally">
              <option value="">Elige el proyecto…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          {optionsError && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">No se han podido cargar las opciones: {optionsError}</p>}

          {isTask ? (
            <>
              <Field label="State" required>{select(state, setState, (options?.taskStates ?? []).map((s) => ({ value: s, label: s })), 'Elige…', 'State')}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Estimate (h)"><input className={inputClass} inputMode="decimal" value={planEstimate} onChange={(e) => setPlanEstimate(e.target.value)} /></Field>
                <Field label="To Do (h)"><input className={inputClass} inputMode="decimal" value={toDo} onChange={(e) => setToDo(e.target.value)} /></Field>
              </div>
            </>
          ) : isFeature ? (
            <>
              {/* Las columnas del Portfolio Kanban, como en Rally; por defecto, la primera. */}
              <Field label="State">{select(portfolioStateRef, setPortfolioStateRef, refOptions(options?.portfolioStates), '-- Sin estado --', 'State')}</Field>
              {options && options.portfolioStates.length === 0 && (
                <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  No se han podido leer de Rally los estados de Feature: se creará sin estado y tendrás que ponérselo en Rally.
                </p>
              )}
              <Field label="Preliminary Estimate">
                {select(estimateRef, setEstimateRef, refOptions(options?.preliminaryEstimates), 'Sin estimar', 'Preliminary Estimate')}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Planned Start Date">
                  <input type="date" className={inputClass} value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} aria-label="Planned Start Date" />
                </Field>
                <Field label="Planned End Date">
                  <input type="date" className={`${inputClass} ${badDates ? 'border-red-400' : ''}`} value={plannedEnd} min={plannedStart || undefined}
                    onChange={(e) => setPlannedEnd(e.target.value)} aria-label="Planned End Date" />
                </Field>
              </div>
              {badDates && <p className="text-xs text-red-600">La fecha de fin es anterior a la de inicio.</p>}
            </>
          ) : (
            <>
              <Field label="Schedule State" required>
                <div className="flex gap-1" role="radiogroup" aria-label="Schedule State">
                  {(options?.scheduleStates ?? []).map((s, i, all) => {
                    const at = all.indexOf(scheduleState);
                    return (
                      <button key={s} type="button" role="radio" aria-checked={s === scheduleState} title={s} onClick={() => pickSchedule(s)}
                        className={`h-8 flex-1 rounded text-xs font-semibold ${i <= at ? 'bg-[#1e64c8] text-white' : 'bg-zinc-200 text-zinc-500 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300'}`}>
                        {s === 'In-Progress' ? 'P' : s[0]}
                      </button>
                    );
                  })}
                  {!options && <span className="text-xs text-zinc-400">{projectId ? 'Cargando…' : 'Elige antes el proyecto'}</span>}
                </div>
                {scheduleState && <p className="mt-1 text-xs text-zinc-500">{scheduleState}</p>}
              </Field>
              {(options?.flowStates.length ?? 0) > 0 && (
                <Field label="Flow State" required>{select(flowStateRef, pickFlow, refOptions(options?.flowStates), 'Sin columna', 'Flow State')}</Field>
              )}
              <Field label="Plan Estimate">
                <input className={inputClass} inputMode="decimal" value={planEstimate} onChange={(e) => setPlanEstimate(e.target.value)} aria-label="Plan Estimate" />
              </Field>
            </>
          )}

          {kind === 'DE' && options && (
            <div className="grid grid-cols-2 gap-3">
              {['Severity', 'Priority', 'State', 'Environment'].map((f) => (options.values[f]?.length ?? 0) > 0 && (
                <Field key={f} label={f}>
                  {select(defect[f] ?? '', (v) => setDefect((d) => ({ ...d, [f]: v })), options.values[f].map((v) => ({ value: v, label: v })), '—', f)}
                </Field>
              ))}
            </div>
          )}

          <Field label="Description">
            <textarea className={`${inputClass} min-h-32 resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Descripción" />
          </Field>

          {parentInfo && (
            <Field label={parentInfo.label} required={parentInfo.required}>
              <ParentField key={kind} title={`Elegir ${parentInfo.label === 'Parent' ? 'padre' : parentInfo.label}`} value={parent} onChange={setParent}
                types={parentInfo.types} projects={projects} projectId={projectId} releases={options?.releases ?? []} allProjects={isFeature} />
            </Field>
          )}

          <Field label="Tags">
            <ValuesField title="Elegir etiquetas" value={tags} onChange={setTags} load={rallyApi.tags} recentKey="rally-recent-tags" />
            {defaultTags.length > 0 && <p className="mt-1 text-xs text-zinc-500">Puestas desde el filtro de etiquetas; puedes quitarlas o añadir más.</p>}
          </Field>
          <Field label="Release">{select(releaseRef, setReleaseRef, refOptions(options?.releases), 'Unscheduled', 'Release')}</Field>
          {!isFeature && <Field label="Iteration">{select(iterationRef, setIterationRef, refOptions(options?.iterations), 'Unscheduled', 'Iteration')}</Field>}
          <Field label="Milestones"><ValuesField title="Elegir milestones" value={milestones} onChange={setMilestones} load={milestoneLoad} recentKey="rally-recent-milestones" /></Field>

          {!isTask && !isFeature && (
            <Field label="Expedite"><Toggle checked={expedite} onChange={setExpedite} label="Expedite" /></Field>
          )}

          {kind === 'US' && (
            <Field label="Feature">
              <ParentField title="Elegir feature" value={feature} onChange={setFeature} types={FEATURE} projects={projects} projectId={projectId} releases={options?.releases ?? []} />
            </Field>
          )}

          <Field label="Attachments">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]); }}
              onClick={() => fileInput.current?.click()}
              className="cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-2 text-indigo-700 hover:border-indigo-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-indigo-300">
              <Plus className="mr-1 inline size-4" /> Arrastra o haz clic para adjuntar
            </div>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
            {files.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className={`flex items-center gap-1.5 text-xs ${f.size > MAX_UPLOAD ? 'text-red-600' : 'text-zinc-600 dark:text-zinc-300'}`}>
                    <Paperclip className="size-3" /> <span className="truncate">{f.name}</span>
                    {f.size > MAX_UPLOAD && <span title={tooBigMessage(f)}>(más de {MAX_UPLOAD_LABEL})</span>}
                    <button type="button" className="ml-auto" onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} aria-label={`Quitar ${f.name}`}><X className="size-3" /></button>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field label="Notes">
            <textarea className={`${inputClass} min-h-24 resize-y`} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notas" />
          </Field>

          {(options?.custom.length ?? 0) > 0 && (
            <section className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
              <p className="text-xs text-zinc-500">Campos obligatorios de vuestro Rally</p>
              {options!.custom.map((c) => (
                <Field key={c.field} label={c.label} required>
                  {c.values.length
                    ? select(custom[c.field] ?? '', (v) => setCustom((x) => ({ ...x, [c.field]: v })), c.values.map((v) => ({ value: v, label: v })), 'Elige…', c.label)
                    : <input className={inputClass} value={custom[c.field] ?? ''} onChange={(e) => setCustom((x) => ({ ...x, [c.field]: e.target.value }))} aria-label={c.label} />}
                </Field>
              ))}
            </section>
          )}
        </div>

        <footer className="space-y-2 border-t border-zinc-200 bg-white px-6 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {error && <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
          {tooBig && <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{tooBigMessage(tooBig)}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="inline-flex items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={addToGestor} onChange={(e) => setAddToGestor(e.target.checked)} /> Añadir también al gestor</label>
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={onCancel} disabled={!!busy}
                className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-[#1e64c8] hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-blue-300 dark:hover:bg-zinc-800">Discard</button>
              <button type="submit" onClick={() => { again.current = true; }} disabled={!ready_ || !!busy || !!tooBig}
                className="whitespace-nowrap rounded-md border border-[#1e64c8] bg-white px-4 py-1.5 font-medium text-[#1e64c8] hover:bg-blue-50 disabled:border-zinc-300 disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-zinc-900 dark:text-blue-300 dark:disabled:border-zinc-600 dark:disabled:bg-zinc-800">
                Create + New
              </button>
              <button type="submit" onClick={() => { again.current = false; }} disabled={!ready_ || !!busy || !!tooBig}
                className="whitespace-nowrap rounded-md bg-[#1e64c8] px-4 py-1.5 font-medium text-white hover:bg-[#1a56ad] disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-800">
                Create
              </button>
            </span>
          </div>
          {busy && <p className="text-right text-xs text-zinc-500">{busy}</p>}
          {lastCreated && !busy && (
            <p className="text-xs text-green-700 dark:text-green-400">
              Creado <a href={lastCreated.url} target="_blank" rel="noreferrer" className="font-medium underline">{lastCreated.id}</a> · {lastCreated.name}. Rellena el siguiente.
            </p>
          )}
          {missingCustom.length > 0 && name.trim() && <p className="text-xs text-zinc-400">Falta: {missingCustom.map((c) => c.label).join(', ')}.</p>}
        </footer>
      </form>
    </div>
  );
}
