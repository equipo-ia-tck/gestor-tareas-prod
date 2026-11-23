import { useEffect, useState } from 'react';
import { Plus, Wand2, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useToast } from '../../components/Toast';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { TITLE_FIELD, type MsListField } from '../../domain/msListParse';
import { parseListRequest } from '../../domain/msListRequest';
import { usePersistentState } from '../../hooks/usePersistentState';
import { Dialog } from '../rally/RallyPickers';
import { track } from '../usage/track';
import { extensionOk, isConnected, queueCreate, useLista } from './listaStore';

/** Columnas del formulario: el título primero y después las que se pueden rellenar, en el orden de la lista. */
export const formFields = (fields: MsListField[]) => [
  ...fields.filter((f) => f.label === TITLE_FIELD),
  ...fields.filter((f) => f.label !== TITLE_FIELD && f.editable),
];

/** Valores por defecto de SharePoint (los que tienen sentido aquí: opciones, textos, números y sí/no). */
function defaults(fields: MsListField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of formFields(fields)) {
    const d = f.defaultValue;
    if (!d || /^\[|^=/.test(d)) continue; // [today], fórmulas…
    if (f.type === 'Boolean') out[f.label] = d === '1' ? 'Sí' : d === '0' ? 'No' : '';
    else if (f.type === 'Choice' && f.choices.length && !f.choices.includes(d)) continue;
    else out[f.label] = d;
  }
  return out;
}

export interface ListPrefill { values: Record<string, string>; warnings: string[] }

/**
 * «Nuevo elemento» de la lista, como el «New Item» de SharePoint: las columnas que se pueden rellenar desde Marea
 * (obligatorias con *). Se crea en SharePoint en cuanto haya conexión (extensión o marcador) y, si se marca, con su
 * tarea de Marea enlazada. Pie como en Rally: Descartar · Crear y otro · Crear.
 */
export function NewListItem({ fields, prefill, onClose }: { fields: MsListField[]; prefill?: ListPrefill | null; onClose: () => void }) {
  const toast = useToast();
  const lista = useLista();
  const { projects } = useApp();
  const shown = formFields(fields);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...defaults(fields), ...(prefill?.values ?? {}) }));
  const [withTask, setWithTask] = usePersistentState('lista-new-task', true);
  const [projectId, setProjectId] = usePersistentState('lista-project', '');
  const target = projects.some((p) => p.id === projectId) ? projectId : null;
  const hidden = fields.filter((f) => f.label !== TITLE_FIELD && !f.editable);
  const missing = shown.filter((f) => (f.required || f.label === TITLE_FIELD) && !(values[f.label] ?? '').trim()).map((f) => f.label);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = (again: boolean) => {
    if (missing.length) return;
    const clean = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    queueCreate(clean, withTask ? { projectId: target } : null);
    track('lista-create', prefill ? 'request' : 'form');
    const live = isConnected(lista) || extensionOk(lista);
    toast(live ? `«${clean[TITLE_FIELD]}» se está creando en la lista` : `«${clean[TITLE_FIELD]}» se creará en la lista en cuanto haya conexión (extensión o marcador)`);
    if (again) {
      // Como «Create + New» de Rally: se vacían título y textos y se conservan las opciones elegidas.
      const keep: Record<string, string> = {};
      for (const f of shown) if (f.label !== TITLE_FIELD && !['Text', 'Note'].includes(f.type) && values[f.label]) keep[f.label] = values[f.label];
      setValues(keep);
    } else onClose();
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <header className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
        <h2 className="min-w-0 flex-1 font-semibold">Nuevo elemento{lista.snapshot ? <span className="font-normal text-zinc-500"> · {lista.snapshot.title}</span> : null}</h2>
        <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {prefill && prefill.warnings.length > 0 && (
          <div className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
            <p className="font-medium">Revisa antes de crear:</p>
            <ul className="list-disc pl-4">{prefill.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {shown.map((f) => (
          <label key={f.name} className="block">
            <span className="mb-0.5 block text-xs font-medium text-zinc-500">
              {f.label}{(f.required || f.label === TITLE_FIELD) && <span className="text-red-600"> *</span>}
            </span>
            <FieldInput field={f} value={values[f.label] ?? ''} changed={false} autoFocus={f.label === TITLE_FIELD}
              onChange={(v) => setValues({ ...values, [f.label]: v })} />
          </label>
        ))}
        {hidden.length > 0 && (
          <p className="text-xs text-zinc-500">
            No se pueden rellenar desde Marea (personas y búsquedas): {hidden.map((f) => f.label).join(', ')}. Se ponen después en SharePoint.
            {hidden.some((f) => f.required) && <b className="text-red-600"> Si alguna es obligatoria, SharePoint no dejará crear el elemento.</b>}
          </p>
        )}
        <div className="space-y-1.5 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withTask} onChange={(e) => setWithTask(e.target.checked)} />
            Crear también la tarea en Marea, enlazada
          </label>
          {withTask && (
            <select className={`${inputClass} py-1`} value={target ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Proyecto de la tarea">
              <option value="">Bandeja (sin proyecto)</option>
              <ProjectOptions />
            </select>
          )}
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
        <span className="mr-auto text-xs text-zinc-500">{missing.length ? `Falta: ${missing.join(', ')}` : 'Se crea en SharePoint en unos segundos si hay conexión.'}</span>
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">Descartar</button>
        <button type="button" disabled={missing.length > 0} onClick={() => create(true)}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-600 dark:hover:bg-zinc-800">Crear y otro</button>
        <button type="button" disabled={missing.length > 0} onClick={() => create(false)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Crear</button>
      </footer>
    </aside>
  );
}

/** Frase de ejemplo con las columnas de la lista (para la ventana de petición). */
export function exampleRequest(fields: MsListField[]): string {
  const parts = ['Revisar etiquetado de la home'];
  for (const f of formFields(fields).filter((x) => x.label !== TITLE_FIELD).slice(0, 4)) {
    if (f.type === 'Choice' || f.type === 'MultiChoice') { if (f.choices[0]) parts.push(`${f.label.toLowerCase()} ${f.choices[0]}`); }
    else if (f.type === 'DateTime') parts.push(`${f.label.toLowerCase()} el viernes`);
    else if (f.type === 'Number' || f.type === 'Currency') parts.push(`${f.label.toLowerCase()} 2`);
    else if (f.type === 'Boolean') parts.push(`${f.label.toLowerCase()} sí`);
  }
  return parts.join(', ');
}

/**
 * «Crear con petición»: una frase con el título y las columnas («estado en curso, prioridad 1, para el viernes»), que se
 * interpreta aquí mismo (sin IA). Enseña al momento lo entendido y abre «Nuevo elemento» relleno para revisar.
 */
export function ListRequestDialog({ fields, onReady, onClose }: { fields: MsListField[]; onReady: (p: ListPrefill) => void; onClose: () => void }) {
  const { today } = useApp();
  const [text, setText] = useState('');
  const req = text.trim() ? parseListRequest(text, fields, today) : null;
  const example = exampleRequest(fields);
  const go = () => {
    if (!req) return;
    const warnings = req.unknown.map((u) => `No entendido: «${u}»`);
    if (!req.values[TITLE_FIELD]) warnings.push('Falta el título.');
    onReady({ values: req.values, warnings });
  };
  const columns = formFields(fields).filter((f) => f.label !== TITLE_FIELD);
  return (
    <Dialog title="Crear con petición" width="max-w-xl" onClose={onClose}>
      <div className="min-h-0 space-y-3 overflow-y-auto text-sm">
        <p className="text-xs text-zinc-500">
          Escribe el título y lo que quieras rellenar, nombrando las columnas («estado en curso», «prioridad 1»). Las opciones que solo están en
          una columna valen solas, y también una fecha («para el viernes»). Se interpreta aquí mismo (sin IA) y se abre el formulario relleno.
        </p>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Petición"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } }}
          placeholder={example} className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-600 dark:bg-zinc-800" />
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <button type="button" onClick={() => setText(example)}
            className="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">Usar el ejemplo</button>
          <span className="ml-1 text-zinc-400">Columnas:</span>
          {columns.map((f) => (
            <button key={f.name} type="button" title={f.choices.length ? `Opciones: ${f.choices.join(', ')}` : f.type}
              onClick={() => setText((t) => `${t.trim()}${t.trim() ? ', ' : ''}${f.label.toLowerCase()} `)}
              className="rounded-full border border-zinc-300 px-2 py-0.5 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
              {f.label}
            </button>
          ))}
        </div>
        {req && (
          <div className="rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60">
            <p className="mb-1 text-xs font-semibold text-zinc-500">Entendido</p>
            {Object.keys(req.values).length === 0 && <p className="text-xs text-zinc-400">Nada todavía.</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {formFields(fields).filter((f) => req.values[f.label]).map((f) => (
                <div key={f.name} className="contents"><dt className="text-zinc-500">{f.label}</dt><dd className="font-medium">{req.values[f.label]}</dd></div>
              ))}
            </dl>
            {req.unknown.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">No entendido: {req.unknown.join(' · ')}</p>}
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
        <button type="button" disabled={!req} onClick={go}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          <Wand2 className="size-4" />Rellenar formulario
        </button>
      </div>
    </Dialog>
  );
}

/** Botones de la cabecera de la Lista: «Nuevo elemento» y «Crear con petición». */
export function NewListButtons({ fields }: { fields: MsListField[] }) {
  const [form, setForm] = useState<{ prefill: ListPrefill | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const btn = 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm';
  return (
    <>
      <button type="button" onClick={() => setForm({ prefill: null })} className={`${btn} bg-indigo-600 font-medium text-white hover:bg-indigo-500`}>
        <Plus className="size-4" />Nuevo elemento
      </button>
      <button type="button" onClick={() => setAsking(true)} className={`${btn} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800`}>
        <Wand2 className="size-4" />Crear con petición
      </button>
      {asking && <ListRequestDialog fields={fields} onClose={() => setAsking(false)} onReady={(prefill) => { setAsking(false); setForm({ prefill }); }} />}
      {form && <NewListItem fields={fields} prefill={form.prefill} onClose={() => setForm(null)} />}
    </>
  );
}

/** Campo de una columna según su tipo (opción, varias opciones, sí/no, fecha, número, nota o texto). */
export function FieldInput({ field: f, value, changed, onChange, autoFocus }: { field: MsListField; value: string; changed: boolean; onChange: (v: string) => void; autoFocus?: boolean }) {
  const cls = `${inputClass} py-1 ${changed ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/40' : ''}`;
  if (!f.editable) return <p className="rounded-md bg-zinc-50 px-2 py-1 whitespace-pre-wrap text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{value || '—'}</p>;
  if (f.type === 'Choice') {
    const options = f.choices.includes(value) || !value ? f.choices : [value, ...f.choices];
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  if (f.type === 'MultiChoice') {
    const chosen = value ? value.split(/\s*,\s*/) : [];
    return (
      <div className={`${cls} flex flex-wrap gap-x-3 gap-y-1`}>
        {f.choices.map((c) => (
          <span key={c} className="inline-flex items-center gap-1">
            <input type="checkbox" checked={chosen.includes(c)}
              onChange={(e) => onChange((e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c)).filter((x) => f.choices.includes(x)).sort((a, b) => f.choices.indexOf(a) - f.choices.indexOf(b)).join(', '))} />
            {c}
          </span>
        ))}
      </div>
    );
  }
  if (f.type === 'Boolean') {
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option><option value="Sí">Sí</option><option value="No">No</option>
      </select>
    );
  }
  if (f.type === 'DateTime') {
    return f.format === 'datetime'
      ? <input type="datetime-local" className={cls} value={value.replace(' ', 'T')} onChange={(e) => onChange(e.target.value.replace('T', ' '))} />
      : <input type="date" className={cls} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (f.type === 'Number' || f.type === 'Currency') return <input type="number" step="any" className={cls} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'Note') return <textarea rows={4} className={`${cls} resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />;
  return <input className={cls} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />;
}
