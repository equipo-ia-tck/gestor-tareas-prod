import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import {
  categoryOfState, RALLY_COLORS, workRuleFields, type RallyCreatableKind, type RallyDetail, type RallyEditValues, type RallyFormOptions,
  type RallyItem, type RallyProject, type RallyRef, type RallyUpdateInput,
} from '../../domain/rally';
import type { Task } from '../../domain/types';
import { useToast } from '../../components/Toast';
import { FEATURE, Field, PARENT, ruleFieldsFor, Toggle } from './RallyCreateForm';
import { localLoad, ParentField, PersonPicker, ValuesField } from './RallyPickers';
import { rallyApi } from './rallyApi';
import { moveRallyItem } from './rallyStates';
import { rememberRally } from './rallyStore';

/** Proyectos de Rally (una vez por sesión: el servidor ya los guarda 10 minutos). */
let projectsOnce: Promise<RallyProject[]> | null = null;
export const loadProjects = () => (projectsOnce ??= rallyApi.projects().catch((e) => { projectsOnce = null; throw e; }));

const DEFECT_FIELDS = [['Severity', 'severity'], ['Priority', 'priority'], ['State', 'state'], ['Environment', 'environment']] as const;
const sameRefs = (a: RallyRef[], b: RallyRef[]) => a.length === b.length && a.every((x, i) => x.ref === b[i].ref);
const numText = (n: number | null) => (n === null ? '' : String(n));
const toNum = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

/** Lo que ha cambiado respecto a lo que hay en Rally, como lo espera `POST /api/rally/update`. */
export function editChanges(orig: RallyEditValues, v: RallyEditValues): RallyUpdateInput {
  const c: RallyUpdateInput = {};
  if (v.name.trim() !== orig.name.trim()) c.name = v.name;
  if (v.projectId !== orig.projectId) c.projectId = v.projectId;
  if ((v.owner?.ref ?? '') !== (orig.owner?.ref ?? '')) c.ownerRef = v.owner?.ref ?? '';
  if ((v.assignee?.ref ?? '') !== (orig.assignee?.ref ?? '')) c.assigneeRef = v.assignee?.ref ?? '';
  if (v.color.toLowerCase() !== orig.color.toLowerCase()) c.color = v.color;
  if (v.description !== orig.description) c.description = v.description;
  if (v.notes !== orig.notes) c.notes = v.notes;
  if (v.planEstimate !== orig.planEstimate) c.planEstimate = v.planEstimate;
  if (v.estimate !== orig.estimate) c.estimate = v.estimate;
  if (v.toDo !== orig.toDo) c.toDo = v.toDo;
  if ((v.parent?.id ?? '') !== (orig.parent?.id ?? '')) c.parentId = v.parent?.id ?? '';
  if ((v.feature?.id ?? '') !== (orig.feature?.id ?? '')) c.featureId = v.feature?.id ?? '';
  if (!sameRefs(v.tags, orig.tags)) c.tagRefs = v.tags.map((t) => t.ref);
  if (!sameRefs(v.milestones, orig.milestones)) c.milestoneRefs = v.milestones.map((m) => m.ref);
  if (v.releaseRef !== orig.releaseRef) c.releaseRef = v.releaseRef;
  if (v.iterationRef !== orig.iterationRef) c.iterationRef = v.iterationRef;
  if (v.expedite !== orig.expedite) c.expedite = v.expedite;
  for (const [field, key] of DEFECT_FIELDS) {
    if ((v.defect[field] ?? '') !== (orig.defect[field] ?? '')) c[key] = v.defect[field] ?? '';
  }
  if (v.portfolioStateRef !== orig.portfolioStateRef) c.portfolioStateRef = v.portfolioStateRef;
  if (v.preliminaryEstimateRef !== orig.preliminaryEstimateRef) c.preliminaryEstimateRef = v.preliminaryEstimateRef;
  if (v.plannedStart !== orig.plannedStart) c.plannedStart = v.plannedStart;
  if (v.plannedEnd !== orig.plannedEnd) c.plannedEnd = v.plannedEnd;
  const custom = Object.fromEntries(Object.entries(v.custom).filter(([k, x]) => (orig.custom[k] ?? '') !== x));
  if (Object.keys(custom).length) c.custom = custom;
  return c;
}

/** Etiquetas de la tarea del gestor tras cambiar las de Rally: se quitan las de antes, se ponen las nuevas y el resto se queda. */
export function syncedTags(taskTags: string[], before: string[], after: string[]): string[] {
  const out = taskTags.filter((t) => !before.includes(t));
  for (const t of after) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * Ficha de Rally editable, con los campos del formulario «Nuevo elemento». Los cambios se guardan juntos con «Guardar
 * cambios» (los campos tocados se marcan). Los estados (Schedule State, Flow State y el State de una tarea) se mueven al
 * momento con la misma ventana de comentario que al arrastrar en el Tablero: si se cierra, no cambian. Al guardar, si
 * hay tarea del gestor enlazada, se le ponen también el nombre y las etiquetas.
 */
export function RallyEditForm({ item, detail, task, onSaved }: {
  item: RallyItem;
  detail: RallyDetail & { edit: RallyEditValues };
  task?: Task;
  onSaved: (detail: RallyDetail) => void;
}) {
  const toast = useToast();
  const kind = item.kind as RallyCreatableKind;
  const isTask = kind === 'TA';
  const isFeature = kind === 'FE';
  const orig = detail.edit;
  const [values, setValues] = useState<RallyEditValues>(orig);
  const [options, setOptions] = useState<RallyFormOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<RallyProject[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ficha nueva (al guardar o al mover): lo que no se había tocado se pone al día; lo tocado se conserva.
  const [base, setBase] = useState(orig);
  useEffect(() => {
    setValues((v) => {
      const dirty = editChanges(base, v);
      const next = { ...orig };
      for (const k of Object.keys(dirty)) {
        const field = ({ ownerRef: 'owner', assigneeRef: 'assignee', parentId: 'parent', featureId: 'feature', tagRefs: 'tags', milestoneRefs: 'milestones',
          severity: 'defect', priority: 'defect', state: 'defect', environment: 'defect' } as Record<string, keyof RallyEditValues>)[k] ?? k as keyof RallyEditValues;
        (next as unknown as Record<string, unknown>)[field] = v[field];
      }
      return next;
    });
    setBase(orig);
  }, [orig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadProjects().then(setProjects, () => {}); }, []);
  useEffect(() => {
    if (!values.projectId) return;
    let live = true;
    setOptionsError(null);
    rallyApi.formOptions(kind, values.projectId, ruleFieldsFor(kind, values.projectId))
      .then((o) => live && setOptions(o), (e: Error) => live && setOptionsError(e.message));
    return () => { live = false; };
  }, [kind, values.projectId]);

  const changes = useMemo(() => editChanges(orig, values), [orig, values]);
  const dirty = Object.keys(changes).length > 0;
  const changed = (k: keyof RallyUpdateInput) => k in changes;
  const set = <K extends keyof RallyEditValues>(k: K, v: RallyEditValues[K]) => setValues((x) => ({ ...x, [k]: v }));
  const badDates = isFeature && !!values.plannedStart && !!values.plannedEnd && values.plannedStart > values.plannedEnd;
  const canSave = dirty && !busy && !!values.name.trim() && !badDates;

  const save = async () => {
    if (!canSave) return;
    setBusy('Guardando en Rally…');
    setError(null);
    try {
      const fresh = await rallyApi.update(item, changes);
      rememberRally([fresh.item]);
      // La tarea del gestor enlazada lleva el mismo nombre y las mismas etiquetas que en Rally.
      if (task && (changes.name !== undefined || changes.tagRefs !== undefined)) {
        const patch: { title?: string; tags?: string[] } = {};
        if (changes.name !== undefined) patch.title = fresh.item.name;
        if (changes.tagRefs !== undefined) patch.tags = syncedTags(task.tags, orig.tags.map((t) => t.name), values.tags.map((t) => t.name));
        await repo.updateTask(task.id, patch);
      }
      onSaved(fresh);
      toast(`${item.id} guardado en Rally`);
    } catch (e) {
      const message = (e as Error).message;
      const ruled = workRuleFields(message);
      setError(ruled.length ? `Rally pide estos campos por una regla del proyecto: ${ruled.join(', ')}.\n\n${message}` : message);
    } finally {
      setBusy(null);
    }
  };

  /** Estados: se mueven al momento, con la ventana de comentario (cerrarla = no cambia). */
  const move = async (flowName: string | undefined, category: ReturnType<typeof categoryOfState>) => {
    setBusy('Moviendo en Rally…');
    setError(null);
    try {
      const moved = await moveRallyItem(item.id, flowName, category, toast, task, item.name);
      if (moved && moved !== 'cancel') onSaved(await rallyApi.detail(moved));
    } finally {
      setBusy(null);
    }
  };
  const pickFlow = (ref: string) => {
    const flow = options?.flowStates.find((f) => f.ref === ref);
    if (flow && ref !== values.flowStateRef) void move(flow.name, categoryOfState(flow.name, flow.scheduleState));
  };
  const pickSchedule = (s: string) => {
    if (s === values.scheduleState) return;
    const flow = options?.flowStates.find((f) => f.scheduleState === s);
    void move(flow?.name, categoryOfState(flow?.name ?? s, s));
  };
  const pickTaskState = (s: string) => { if (s && s !== values.taskState) void move(undefined, categoryOfState(s, s)); };

  const select = (value: string, onChange: (v: string) => void, list: { value: string; label: string }[], placeholder: string, label: string, mark = false) => (
    <select className={`${inputClass} ${mark ? 'ring-2 ring-amber-400' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={!options || !!busy}>
      <option value="">{options ? placeholder : 'Cargando…'}</option>
      {/* Si el valor actual no está entre las opciones (p. ej. de otro proyecto), se enseña igual. */}
      {value && !list.some((o) => o.value === value) && <option value={value}>{value}</option>}
      {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const refOptions = (list: RallyRef[] = []) => list.map((r) => ({ value: r.ref, label: r.name }));
  const milestoneLoad = useMemo(() => localLoad(options?.milestones ?? []), [options]);
  const parentInfo = PARENT[kind];
  const ring = (k: keyof RallyUpdateInput) => (changed(k) ? 'rounded-md ring-2 ring-amber-400 ring-offset-1 dark:ring-offset-zinc-900' : '');
  const projectOptions = projects.some((p) => p.id === values.projectId) ? projects
    : [...projects, { id: values.projectId, name: item.project ?? values.projectId }];
  const customFields = options?.custom ?? [];

  return (
    <div className="space-y-4 text-sm">
      <Field label="Name" required>
        {/* En varias líneas: los nombres de Rally suelen ser largos. Sin saltos de línea (Rally no los admite en el nombre). */}
        <textarea className={`${inputClass} resize-none ${values.name.trim() ? '' : 'border-red-400'} ${changed('name') ? 'ring-2 ring-amber-400' : ''}`}
          rows={Math.min(4, Math.max(2, Math.ceil(values.name.length / 48)))} value={values.name} maxLength={256} aria-label="Nombre"
          onChange={(e) => set('name', e.target.value.replace(/\n/g, ' '))} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
      </Field>

      <Field label="Color">
        <div className={`relative ${ring('color')}`}>
          <span className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 rounded-full border border-zinc-300"
            style={{ background: RALLY_COLORS.find((c) => c.hex.toLowerCase() === values.color.toLowerCase())?.hex ?? 'transparent' }} />
          <select className={`${inputClass} pl-7`} value={RALLY_COLORS.find((c) => c.hex.toLowerCase() === values.color.toLowerCase())?.hex ?? values.color}
            onChange={(e) => set('color', e.target.value)} aria-label="Color">
            <option value="">Sin color</option>
            {values.color && !RALLY_COLORS.some((c) => c.hex.toLowerCase() === values.color.toLowerCase()) && <option value={values.color}>{values.color}</option>}
            {RALLY_COLORS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
          </select>
        </div>
      </Field>

      <Field label="Owner">
        <div className={ring('ownerRef')}>
          <PersonPicker label="Owner" value={values.owner} onChange={(u) => set('owner', u)} me={options?.me ?? null} team={options?.users ?? []} loading={!options} />
        </div>
      </Field>
      {(kind === 'US' || kind === 'DE' || kind === 'TA') && (
        <Field label="Assignee">
          <div className={ring('assigneeRef')}>
            <PersonPicker label="Assignee" value={values.assignee} onChange={(u) => set('assignee', u)} me={options?.me ?? null} team={options?.users ?? []} loading={!options} />
          </div>
        </Field>
      )}

      <Field label="Project" required>
        <select className={`${inputClass} ${changed('projectId') ? 'ring-2 ring-amber-400' : ''}`} value={values.projectId}
          onChange={(e) => set('projectId', e.target.value)} aria-label="Proyecto de Rally">
          {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {optionsError && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">No se han podido cargar las opciones: {optionsError}</p>}

      {isTask ? (
        <>
          <Field label="State">
            {select(values.taskState, pickTaskState, (options?.taskStates ?? []).map((s) => ({ value: s, label: s })), 'Elige…', 'State')}
            <p className="mt-1 text-xs text-zinc-500">Cambia al momento en Rally, con su comentario.</p>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estimate (h)"><NumInput value={values.estimate} onChange={(n) => set('estimate', n)} mark={changed('estimate')} label="Estimate" /></Field>
            <Field label="To Do (h)"><NumInput value={values.toDo} onChange={(n) => set('toDo', n)} mark={changed('toDo')} label="To Do" /></Field>
          </div>
        </>
      ) : isFeature ? (
        <>
          <Field label="State">{select(values.portfolioStateRef, (v) => set('portfolioStateRef', v), refOptions(options?.portfolioStates), '-- Sin estado --', 'State', changed('portfolioStateRef'))}</Field>
          <Field label="Preliminary Estimate">
            {select(values.preliminaryEstimateRef, (v) => set('preliminaryEstimateRef', v), refOptions(options?.preliminaryEstimates), 'Sin estimar', 'Preliminary Estimate', changed('preliminaryEstimateRef'))}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned Start Date">
              <input type="date" className={`${inputClass} ${changed('plannedStart') ? 'ring-2 ring-amber-400' : ''}`} value={values.plannedStart}
                onChange={(e) => set('plannedStart', e.target.value)} aria-label="Planned Start Date" />
            </Field>
            <Field label="Planned End Date">
              <input type="date" className={`${inputClass} ${badDates ? 'border-red-400' : ''} ${changed('plannedEnd') ? 'ring-2 ring-amber-400' : ''}`} value={values.plannedEnd}
                min={values.plannedStart || undefined} onChange={(e) => set('plannedEnd', e.target.value)} aria-label="Planned End Date" />
            </Field>
          </div>
          {badDates && <p className="text-xs text-red-600">La fecha de fin es anterior a la de inicio.</p>}
        </>
      ) : (
        <>
          <Field label="Schedule State">
            <div className="flex gap-1" role="radiogroup" aria-label="Schedule State">
              {(options?.scheduleStates ?? []).map((s, i, all) => {
                const at = all.indexOf(values.scheduleState);
                return (
                  <button key={s} type="button" role="radio" aria-checked={s === values.scheduleState} title={`${s} (se mueve al momento en Rally)`}
                    disabled={!!busy} onClick={() => pickSchedule(s)}
                    className={`h-8 flex-1 rounded text-xs font-semibold disabled:opacity-60 ${i <= at ? 'bg-[#1e64c8] text-white' : 'bg-zinc-200 text-zinc-500 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300'}`}>
                    {s === 'In-Progress' ? 'P' : s[0]}
                  </button>
                );
              })}
              {!options && <span className="text-xs text-zinc-400">Cargando…</span>}
            </div>
            {values.scheduleState && <p className="mt-1 text-xs text-zinc-500">{values.scheduleState}</p>}
          </Field>
          {(options?.flowStates.length ?? 0) > 0 && (
            <Field label="Flow State">
              {select(values.flowStateRef, pickFlow, refOptions(options?.flowStates), 'Sin columna', 'Flow State')}
            </Field>
          )}
          <p className="-mt-2 text-xs text-zinc-500">Los estados se cambian al momento en Rally, con la misma ventana de comentario que al arrastrar en el Tablero. Si la cierras, no cambian.</p>
          <Field label="Plan Estimate">
            <NumInput value={values.planEstimate} onChange={(n) => set('planEstimate', n)} mark={changed('planEstimate')} label="Plan Estimate" />
          </Field>
        </>
      )}

      {kind === 'DE' && (
        <div className="grid grid-cols-2 gap-3">
          {DEFECT_FIELDS.map(([f, key]) => (
            <Field key={f} label={f}>
              {select(values.defect[f] ?? '', (v) => set('defect', { ...values.defect, [f]: v }), (options?.values[f] ?? []).map((v) => ({ value: v, label: v })), '—', f, changed(key))}
            </Field>
          ))}
        </div>
      )}

      <Field label="Description">
        <textarea className={`${inputClass} min-h-32 resize-y ${changed('description') ? 'ring-2 ring-amber-400' : ''}`} value={values.description}
          onChange={(e) => set('description', e.target.value)} aria-label="Descripción" />
        {orig.richDescription && <RichWarning changed={changed('description')} />}
      </Field>

      {parentInfo && (
        <Field label={parentInfo.label} required={parentInfo.required}>
          <div className={ring('parentId')}>
            <ParentField key={kind} title={`Elegir ${parentInfo.label === 'Parent' ? 'padre' : parentInfo.label}`} value={values.parent} onChange={(p) => set('parent', p)}
              types={parentInfo.types} projects={projects} projectId={values.projectId} releases={options?.releases ?? []} allProjects={isFeature} />
          </div>
        </Field>
      )}

      <Field label="Tags">
        <div className={ring('tagRefs')}>
          <ValuesField title="Elegir etiquetas" value={values.tags} onChange={(t) => set('tags', t)} load={rallyApi.tags} recentKey="rally-recent-tags" />
        </div>
      </Field>
      <Field label="Release">{select(values.releaseRef, (v) => set('releaseRef', v), refOptions(options?.releases), 'Unscheduled', 'Release', changed('releaseRef'))}</Field>
      {!isFeature && <Field label="Iteration">{select(values.iterationRef, (v) => set('iterationRef', v), refOptions(options?.iterations), 'Unscheduled', 'Iteration', changed('iterationRef'))}</Field>}
      <Field label="Milestones">
        <div className={ring('milestoneRefs')}>
          <ValuesField title="Elegir milestones" value={values.milestones} onChange={(m) => set('milestones', m)} load={milestoneLoad} recentKey="rally-recent-milestones" />
        </div>
      </Field>

      {!isTask && !isFeature && (
        <Field label="Expedite"><span className={`inline-block p-0.5 ${ring('expedite')}`}><Toggle checked={values.expedite} onChange={(v) => set('expedite', v)} label="Expedite" /></span></Field>
      )}

      {kind === 'US' && (
        <Field label="Feature">
          <div className={ring('featureId')}>
            <ParentField title="Elegir feature" value={values.feature} onChange={(f) => set('feature', f)} types={FEATURE} projects={projects} projectId={values.projectId} releases={options?.releases ?? []} />
          </div>
        </Field>
      )}

      <Field label="Notes">
        <textarea className={`${inputClass} min-h-24 resize-y ${changed('notes') ? 'ring-2 ring-amber-400' : ''}`} value={values.notes}
          onChange={(e) => set('notes', e.target.value)} aria-label="Notas" />
        {orig.richNotes && <RichWarning changed={changed('notes')} />}
      </Field>

      {customFields.length > 0 && (
        <section className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          <p className="text-xs text-zinc-500">Campos obligatorios de vuestro Rally</p>
          {customFields.map((cf) => {
            const value = values.custom[cf.field] ?? '';
            const mark = (orig.custom[cf.field] ?? '') !== value;
            return (
              <Field key={cf.field} label={cf.rule ? `${cf.label} · regla del proyecto` : cf.label}>
                {cf.values.length
                  ? select(value, (v) => set('custom', { ...values.custom, [cf.field]: v }), cf.values.map((v) => ({ value: v, label: v })), 'Elige…', cf.label, mark)
                  : <input className={`${inputClass} ${mark ? 'ring-2 ring-amber-400' : ''}`} value={value}
                      onChange={(e) => set('custom', { ...values.custom, [cf.field]: e.target.value })} aria-label={cf.label} />}
              </Field>
            );
          })}
        </section>
      )}

      {/* Barra de guardar: siempre a la vista al bajar por la ficha. */}
      <div className="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
        {error && <p className="mb-2 rounded-md bg-red-50 px-2 py-1 text-xs whitespace-pre-line text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-xs text-zinc-500">
            {busy ?? (dirty ? `${Object.keys(changes).length} ${Object.keys(changes).length === 1 ? 'campo cambiado' : 'campos cambiados'} (marcados en ámbar)` : 'Sin cambios')}
            {dirty && task && (changes.name !== undefined || changes.tagRefs !== undefined) && ' · también en la tarea del gestor'}
          </span>
          <button type="button" disabled={!dirty || !!busy} onClick={() => { setValues(orig); setError(null); }}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:hover:bg-zinc-800">
            <RotateCcw className="size-3.5" />Descartar
          </button>
          <button type="button" disabled={!canSave} onClick={() => void save()}
            className="inline-flex items-center gap-1 rounded-md bg-[#1e64c8] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1a56ad] disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-800">
            <Save className="size-3.5" />Guardar cambios
          </button>
        </div>
      </div>
    </div>
  );
}

function RichWarning({ changed }: { changed: boolean }) {
  return (
    <p className={`mt-1 flex items-start gap-1 text-xs ${changed ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'}`}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      En Rally tiene formato (negritas, listas, enlaces o imágenes). Si lo cambias aquí se guarda como texto y ese formato se pierde.
    </p>
  );
}

/** Número con decimales (con coma o punto) que se puede dejar vacío; se pone al día si el valor cambia desde fuera. */
function NumInput({ value, onChange, mark, label }: { value: number | null; onChange: (v: number | null) => void; mark: boolean; label: string }) {
  const [text, setText] = useState(numText(value));
  useEffect(() => { if (toNum(text) !== value) setText(numText(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = text.trim() !== '' && !Number.isFinite(toNum(text));
  return (
    <input className={`${inputClass} ${bad ? 'border-red-400' : ''} ${mark ? 'ring-2 ring-amber-400' : ''}`} inputMode="decimal" value={text} aria-label={label}
      onChange={(e) => { setText(e.target.value); const n = toNum(e.target.value); if (n === null || Number.isFinite(n)) onChange(n); }} />
  );
}
