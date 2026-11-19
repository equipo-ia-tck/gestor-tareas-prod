import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { repo } from '../data/services';
import { labelColorMap } from '../domain/colors';
import { postponeCounts } from '../domain/activity';
import { missingRallyTypes, RALLY_TYPE_IDS, withAcceptedState } from '../domain/workflows';
import { knownPeople } from '../domain/selectors';
import { matchesSpace, SPACES_ENABLED, spaceOf, spaceOfProject, type Space, type SpaceFilter } from '../domain/spaces';
import { useSync } from '../data/sync';
import { isHiddenRoutine, pendingRoutines, routineTask, TEAM_ROUTINES } from '../domain/routines';
import { usePersistentState } from '../hooks/usePersistentState';
import type { ActivityEntry, ISODate, ItemType, Label, Note, Person, Project, Release, Settings, Task } from '../domain/types';
import { useActivity, useItemTypes, useLabels, useNotes, usePeople, useProjects, useReleases, useSettings, useTasks, useToday } from '../hooks/useData';

interface AppData {
  /** Tareas del espacio elegido en el filtro (todas con "Todo"). */
  tasks: Task[];
  /** Espacios de los que soy miembro y el filtro actual ("all", "personal" o el id de un espacio). */
  spaces: Space[];
  spaceFilter: SpaceFilter;
  setSpaceFilter: (f: SpaceFilter) => void;
  /** Personas para sugerir al mencionar: las de las tareas y todas las cuentas del equipo. */
  mentionables: string[];
  /** Todos los proyectos, incluidos los archivados (para resolver nombres). */
  allProjects: Project[];
  /** Proyectos activos. */
  projects: Project[];
  projectMap: Map<string, Project>;
  itemTypes: ItemType[];
  releases: Release[];
  releaseMap: Map<string, Release>;
  notes: Note[];
  /** Fichas de persona guardadas (rol, notas). */
  peopleCards: Person[];
  activity: ActivityEntry[];
  /** Veces que se ha pospuesto cada tarea. */
  postponed: Map<string, number>;
  labels: Label[];
  /** nameKey(etiqueta) → color personalizado. */
  labelColors: Map<string, string>;
  settings: Settings;
  today: ISODate;
  /** Tarea abierta en el panel de detalle. */
  detailId: string | null;
  /** Abre la tarea en el panel de detalle lateral. */
  editTask: (task: Task) => void;
  closeDetail: () => void;
}

const Ctx = createContext<AppData | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp fuera de AppProvider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const allTasks = useTasks();
  const allProjects = useProjects(true);
  const { spaces, team, user, isAdmin, pulled } = useSync();
  // El filtro es de cada cuenta (en un navegador compartido no se hereda el de la anterior).
  const [storedFilter, setSpaceFilter] = usePersistentState<SpaceFilter>(`space-filter:${user?.id ?? ''}`, 'all');
  // Si dejo de estar en el espacio filtrado, se vuelve a "Todo".
  // Con los espacios apagados no se filtra nunca (un filtro guardado de antes ocultaría cosas).
  const spaceFilter = !SPACES_ENABLED ? 'all' : storedFilter === 'all' || storedFilter === 'personal' || spaces.some((s) => s.id === storedFilter) ? storedFilter : 'all';
  const allNotes = useNotes();
  const itemTypes = useItemTypes();
  // Los tipos son comunes al equipo y solo los cambia un administrador: desde su sesión se añade "Accepted" a los
  // tipos de serie que aún no lo tienen, y la sincronización lo lleva a los demás.
  const needsAccepted = isAdmin && itemTypes.some((t) => withAcceptedState(t));
  useEffect(() => { if (needsAccepted) void repo.ensureAcceptedStates(); }, [needsAccepted]);
  // Tipos de Rally (Feature, Defect…): una administradora los añade si faltan, y las tareas con su ID dejan de ser «Tarea».
  const rallyTypesMissing = isAdmin && missingRallyTypes(itemTypes).length > 0;
  const rallyTypeIds = itemTypes.filter((t) => RALLY_TYPE_IDS.includes(t.id)).map((t) => t.id).join();
  useEffect(() => { if (itemTypes.length) void repo.ensureRallyTypes(rallyTypesMissing); }, [rallyTypesMissing, rallyTypeIds]); // eslint-disable-line react-hooks/exhaustive-deps
  // Con un espacio elegido en el filtro, los proyectos nuevos (desde cualquier sitio) van a ese espacio.
  // Y las tareas sin proyecto, al proyecto con el nombre del espacio.
  const filterSpace = spaces.find((s) => s.id === spaceFilter);
  useEffect(() => {
    repo.defaultSpaceId = filterSpace?.id ?? null;
    repo.defaultSpace = filterSpace ? { id: filterSpace.id, name: filterSpace.name, color: filterSpace.color } : null;
  }, [filterSpace?.id, filterSpace?.name, filterSpace?.color]);
  const labels = useLabels();
  const releases = useReleases();
  const peopleCards = usePeople();
  const activity = useActivity();
  const settings = useSettings();
  const today = useToday();
  // Rutinas del equipo (objetivos del lunes, gestión de la demanda del viernes): se crean una vez por cuenta, cuando ya ha
  // llegado la primera sincronización (así otro navegador no las duplica). Se lee del repositorio, no de los hooks, que
  // pueden ir un paso por detrás.
  const routinesChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !pulled || routinesChecked.current === user.id) return;
    routinesChecked.current = user.id;
    void (async () => {
      // Colores de proyectos, grupos y etiquetas a la paleta de Marea (una vez por cuenta; las etiquetas, solo un admin).
      await repo.applyBrandColors(isAdmin).catch(() => {});
      const [list, current] = await Promise.all([repo.listTasks(), repo.getSettings()]);
      const missing = pendingRoutines(TEAM_ROUTINES, list, current.routines_added);
      if (!missing.length) return;
      await repo.batch('Tareas fijas del equipo añadidas', async () => {
        for (const r of missing) await repo.createTask(routineTask(r, today), { spaceDefault: false });
      });
      await repo.updateSettings({ routines_added: [...current.routines_added, ...missing.map((r) => r.id)] });
    })();
  }, [user, pulled, today]); // eslint-disable-line react-hooks/exhaustive-deps -- isAdmin llega con el usuario
  const [detailId, setDetailId] = useState<string | null>(null);

  const value = useMemo<AppData>(() => {
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));
    // Las rutinas del equipo ya hechas no vuelven a verse hasta su próximo día (`isHiddenRoutine`).
    const tasks = allTasks.filter((t) => matchesSpace(spaceOf(t, projectMap), spaceFilter) && !isHiddenRoutine(t, today));
    const notes = allNotes.filter((n) => matchesSpace(spaceOf(n, projectMap), spaceFilter));
    return {
    tasks,
    spaces,
    spaceFilter,
    setSpaceFilter,
    mentionables: [...new Set([...knownPeople(allTasks), ...team.map((u) => u.name)])],
    allProjects,
    // Activos (ni el proyecto ni sus antepasados archivados) y del espacio elegido.
    // Ya no se archiva (se elimina): los que estaban archivados vuelven a la lista para poder eliminarlos o seguir usándolos.
    projects: allProjects.filter((p) => matchesSpace(spaceOfProject(p.id, projectMap), spaceFilter)),
    projectMap,
    itemTypes,
    releases,
    releaseMap: new Map(releases.map((r) => [r.id, r])),
    notes,
    peopleCards,
    activity,
    postponed: postponeCounts(activity),
    labels,
    labelColors: labelColorMap(labels),
    settings,
    today,
    detailId: detailId && tasks.some((t) => t.id === detailId) ? detailId : null,
    editTask: (t) => setDetailId(t.id),
    closeDetail: () => setDetailId(null),
  };
  }, [allTasks, allProjects, allNotes, spaces, team, spaceFilter, setSpaceFilter, itemTypes, releases, peopleCards, activity, labels, settings, today, detailId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
