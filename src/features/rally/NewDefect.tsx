import { useState } from 'react';
import { Bug, Plus } from 'lucide-react';
import { repo } from '../../data/services';
import { fold } from '../../domain/text';
import { taskFromRally, type RallyDetail, type RallyItem, type RallyProject, type RallyRef } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { track } from '../usage/track';
import { RallyCreateForm, type RallyPrefill } from './RallyCreateForm';
import { loadProjects } from './RallyEditForm';
import { rallyApi } from './rallyApi';
import { rememberRally } from './rallyStore';

/** Etiqueta de los defectos de las validaciones de Tech. */
export const DEFECT_TAG = 'ANA_etiquetado';

/**
 * Valores de entrada de un defecto creado desde una US, según la guía del equipo: «Error found in TS…», proyecto y User
 * Story de la US, State Open, New, Owner quien lo crea y Assignee vacío, el APPGAR de la US, PRE, Minor Problem, Normal,
 * ANA_etiquetado y «Afectación a usuario» = No. Descripción, Canal y adjunto se rellenan a mano.
 */
export function defectPrefill(us: RallyItem, detail: RallyDetail, tag: RallyRef | null): RallyPrefill {
  const custom = detail.edit?.custom ?? {};
  const appgarKey = Object.keys(custom).find((k) => fold(k).includes('appgar'));
  const appgar = appgarKey ? custom[appgarKey] : '';
  return {
    source: `Defecto de ${us.id} · ${us.name}`,
    title: `Nuevo defecto de ${us.id}: revisa la descripción, el Canal y adjunta el documento de validación`,
    kind: 'DE',
    name: 'Error found in TS',
    ...(detail.edit?.projectId ? { projectId: detail.edit.projectId } : {}),
    parent: { id: us.id, name: us.name, project: us.project },
    state: 'New',
    owner: '@me',
    noAssignee: true,
    defect: { State: 'Open', Environment: 'PRE', Severity: 'Minor Problem', Priority: 'Normal' },
    custom: { ...(appgar ? { APPGAR: appgar } : {}), 'Afectación a usuario': 'No' },
    ...(tag ? { tags: [tag] } : {}),
    warnings: [
      ...(appgar ? [] : [`${us.id} no tiene APPGAR en Rally: elígelo a mano.`]),
      ...(tag ? [] : [`No se ha encontrado la etiqueta ${DEFECT_TAG} en Rally: añádela a mano.`]),
    ],
  };
}

/**
 * «+ Nuevo defecto» en la ficha de una US: abre el formulario de «Nuevo elemento» ya rellenado (`defectPrefill`). Al
 * crearlo se vuelve a leer la ficha (sale en sus defectos) y, si se marca, se añade también al gestor, en el proyecto de
 * la tarea de la US.
 */
export function NewDefect({ us, detail, task, onCreated }: {
  us: RallyItem;
  detail: RallyDetail;
  task?: Task;
  onCreated: () => void;
}) {
  const [prefill, setPrefill] = useState<RallyPrefill | null>(null);
  const [projects, setProjects] = useState<RallyProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const [list, tags] = await Promise.all([loadProjects(), rallyApi.tags(DEFECT_TAG, 1).catch(() => ({ items: [] as RallyRef[] }))]);
      setProjects(list);
      setPrefill(defectPrefill(us, detail, tags.items.find((t) => fold(t.name) === fold(DEFECT_TAG)) ?? null));
      track('rally-button', 'new-defect');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void open()} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
        <Bug className="size-3.5" /><Plus className="-ml-1 size-3" />{busy ? 'Preparando…' : 'Nuevo defecto'}
      </button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {prefill && (
        <RallyCreateForm key={prefill.source} prefill={prefill} projects={projects} defaultProjectId={prefill.projectId ?? null}
          onCancel={() => setPrefill(null)}
          onCreated={(item, addToGestor, keepOpen) => {
            rememberRally([item]);
            if (!keepOpen) setPrefill(null);
            onCreated();
            if (addToGestor) {
              void repo.listItemTypes().then((types) =>
                repo.batch(`${item.id} añadido desde Rally`, async () => { await repo.createTask(taskFromRally(item, types, task?.project_id ?? null)); }));
            }
          }} />
      )}
    </>
  );
}
