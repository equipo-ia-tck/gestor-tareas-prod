import { useState, type DragEvent } from 'react';
import { track } from '../usage/track';
import { Check, FolderInput } from 'lucide-react';
import { MenuItem, Popover } from '../../components/ui/Popover';
import { useApp } from '../../app/AppContext';
import { repo } from '../../data/services';
import { groupOf } from '../../domain/people';
import { PROJECT_COLORS, type PersonGroup } from '../../domain/types';

/** Tipo MIME propio para arrastrar personas entre grupos. */
export const PERSON_MIME = 'application/x-gestor-person';

export function setDraggedPerson(e: DragEvent, name: string) {
  e.dataTransfer.setData(PERSON_MIME, name);
  e.dataTransfer.setData('text/plain', name);
  e.dataTransfer.effectAllowed = 'move';
}

/** Convierte un elemento en destino de personas arrastradas. */
export function usePersonDrop(onDrop: (name: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    dropProps: {
      onDragOver(e: DragEvent) {
        if (!e.dataTransfer.types.includes(PERSON_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave(e: DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop(e: DragEvent) {
        const name = e.dataTransfer.getData(PERSON_MIME);
        setOver(false);
        if (!name) return;
        e.preventDefault();
        onDrop(name);
      },
    },
  };
}

/** Meter a una persona en un grupo (null = sacarla), con aviso "Deshacer". */
export function movePersonToGroup(name: string, group: PersonGroup | null) {
  return repo.batch(group ? `${name} → ${group.name}` : `${name} sin grupo`, () => repo.setPersonGroup(name, group?.id ?? null));
}

export async function createGroup(name: string, groups: PersonGroup[]): Promise<PersonGroup | null> {
  const n = name.trim();
  if (!n) return null;
  const group = { id: crypto.randomUUID(), name: n, color: PROJECT_COLORS[groups.length % PROJECT_COLORS.length] };
  await repo.updateSettings({ groups: [...groups, group] });
  track('group-create');
  return group;
}

export const updateGroup = (groups: PersonGroup[], id: string, patch: Partial<Omit<PersonGroup, 'id'>>) =>
  repo.updateSettings({ groups: groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });

/** Quita el grupo; sus personas pasan a "Sin grupo" (en un solo "Deshacer" para las fichas). */
export async function deleteGroup(groups: PersonGroup[], id: string, members: string[]) {
  const g = groups.find((x) => x.id === id);
  await repo.batch(`Grupo ${g?.name ?? ''} eliminado`, async () => {
    for (const name of members) await repo.setPersonGroup(name, null);
  });
  await repo.updateSettings({ groups: groups.filter((x) => x.id !== id) });
}

export function moveGroup(groups: PersonGroup[], id: string, delta: -1 | 1) {
  const i = groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= groups.length) return;
  const next = [...groups];
  [next[i], next[j]] = [next[j], next[i]];
  return repo.updateSettings({ groups: next });
}

/** Botón con el grupo de la persona; al pulsarlo se elige otro o se crea uno nuevo. */
export function GroupPicker({ name, compact = false }: { name: string; compact?: boolean }) {
  const { settings, peopleCards } = useApp();
  const groups = settings.groups;
  const current = groupOf(name, peopleCards, groups);
  const [draft, setDraft] = useState('');
  return (
    <Popover width="w-60" trigger={(toggle) => (
      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }} title="Cambiar de grupo"
        className={`flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap ${current
          ? 'border-transparent font-medium' : 'border-dashed border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800'}`}
        style={current ? { background: `${current.color}22`, color: current.color } : undefined}>
        {current ? <span className="size-2 shrink-0 rounded-full" style={{ background: current.color }} /> : <FolderInput className="size-3.5" />}
        <span className="truncate">{current?.name ?? (compact ? 'Grupo' : 'Añadir a un grupo')}</span>
      </button>
    )}>
      {(close) => (
        <div className="p-1">
          {groups.map((g) => (
            <MenuItem key={g.id} onClick={() => { void movePersonToGroup(name, g); close(); }}>
              <span className="size-2.5 rounded-full" style={{ background: g.color }} />
              <span className="flex-1 truncate">{g.name}</span>
              {current?.id === g.id && <Check className="size-3.5 text-indigo-600" />}
            </MenuItem>
          ))}
          {current && <MenuItem onClick={() => { void movePersonToGroup(name, null); close(); }}><span className="text-zinc-500">Sin grupo</span></MenuItem>}
          <form className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700" onSubmit={async (e) => {
            e.preventDefault();
            const g = await createGroup(draft, groups);
            if (g) await movePersonToGroup(name, g);
            setDraft('');
            close();
          }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Grupo nuevo… (Enter)" autoFocus={!groups.length}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
          </form>
        </div>
      )}
    </Popover>
  );
}
