import { describe, expect, it } from 'vitest';
import { categoryOfState, type RallyEditValues } from '../src/domain/rally';
import { editChanges, syncedTags } from '../src/features/rally/RallyEditForm';

const base: RallyEditValues = {
  projectId: '7', name: 'Login', owner: { ref: '/user/55', name: 'Pepa' }, assignee: null, color: '#21A2E0', flowStateRef: '/flowstate/2',
  scheduleState: 'Defined', taskState: '', planEstimate: 3, estimate: null, toDo: null, description: 'Hola', notes: '', richDescription: false,
  richNotes: false, parent: null, feature: null, tags: [{ ref: '/tag/1', name: 'QA' }], milestones: [], releaseRef: '', iterationRef: '',
  expedite: false, defect: {}, portfolioStateRef: '', preliminaryEstimateRef: '', plannedStart: '', plannedEnd: '', custom: { c_Canal: 'App' },
};

describe('editar en Rally desde la ficha', () => {
  it('solo manda lo que ha cambiado', () => {
    expect(editChanges(base, { ...base })).toEqual({});
    expect(editChanges(base, { ...base, color: '#21a2e0', name: ' Login ' })).toEqual({}); // mayúsculas del color y espacios no cuentan
    expect(editChanges(base, {
      ...base, owner: null, parent: { id: 'US9', name: 'Padre', project: null }, tags: [], planEstimate: null,
      custom: { c_Canal: 'Web', c_Tipo: '' }, defect: { Severity: 'Major' },
    })).toEqual({ ownerRef: '', parentId: 'US9', tagRefs: [], planEstimate: null, custom: { c_Canal: 'Web' }, severity: 'Major' });
  });

  it('las etiquetas de la tarea del gestor siguen a las de Rally sin tocar las demás', () => {
    expect(syncedTags(['QA', 'rutina', 'Web'], ['QA', 'Web'], ['Web', 'App'])).toEqual(['rutina', 'Web', 'App']);
  });

  it('categoría de la columna o del Schedule State elegido en la ficha', () => {
    expect(categoryOfState('Need Review', 'In-Progress')).toBe('doing');
    expect(categoryOfState('Defined')).toBe('todo');
    expect(categoryOfState('Blocked', 'In-Progress')).toBe('blocked');
    expect(categoryOfState('Columna rara', 'Completed')).toBe('done');
    expect(categoryOfState('Accepted')).toBe('accepted');
    expect(categoryOfState('In-Progress')).toBe('doing');
  });
});
