import { useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderPlus, NotebookPen } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { routeHref } from '../../app/router';
import { repo } from '../../data/services';
import { projectTree, withDescendants, type ProjectNode } from '../../domain/projects';
import { isActive } from '../../domain/selectors';
import type { Project } from '../../domain/types';
import { ViewHeader } from './ViewHeader';

/**
 * Pantalla Proyectos (`#/projects`, el título «Proyectos» de la barra lateral), como la de Grupos: alta de proyectos y un
 * bloque por proyecto con sus pendientes, atrasadas y notas (contando los subproyectos) y una tarjeta por subproyecto.
 */
export function ProjectsView() {
  const { projects } = useApp();
  const [draft, setDraft] = useState('');
  const tree = projectTree(projects);

  return (
    <>
      <ViewHeader title="Proyectos" subtitle="Todos tus proyectos con sus subproyectos; pulsa uno para abrirlo" />
      <form className="mb-5 flex items-center gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        await repo.createProject(draft.trim());
        setDraft('');
      }}>
        <FolderPlus className="size-4 text-zinc-400" />
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Nuevo proyecto…" aria-label="Nuevo proyecto"
          className="w-80 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
        <button type="submit" disabled={!draft.trim()} className="rounded-md bg-indigo-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Crear proyecto</button>
      </form>
      <div className="space-y-5">
        {tree.map((node) => <ProjectBlock key={node.project.id} node={node} />)}
      </div>
      {tree.length === 0 && <p className="px-2 text-sm text-zinc-400">Aún no hay proyectos. Créalo arriba o con # al capturar una tarea (#nombre).</p>}
    </>
  );
}

/** Pendientes, atrasadas y notas de un proyecto con todos sus subproyectos. */
function useProjectStats(p: Project) {
  const { tasks, notes, projects, today } = useApp();
  const ids = withDescendants(p.id, projects);
  const mine = tasks.filter((t) => t.project_id && ids.has(t.project_id) && isActive(t));
  return {
    open: mine.length,
    overdue: mine.filter((t) => t.due_date && t.due_date < today).length,
    notes: notes.filter((n) => !n.deleted_at && n.project_id && ids.has(n.project_id)).length,
  };
}

function Stats({ p }: { p: Project }) {
  const s = useProjectStats(p);
  return (
    <span className="flex items-center gap-3 text-xs text-zinc-500">
      <span className="inline-flex items-center gap-1" title="Pendientes"><CheckCircle2 className="size-3.5" />{s.open}</span>
      {s.overdue > 0 && <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400" title="Atrasadas"><AlertTriangle className="size-3.5" />{s.overdue}</span>}
      {s.notes > 0 && <span className="inline-flex items-center gap-1" title="Notas"><NotebookPen className="size-3.5" />{s.notes}</span>}
    </span>
  );
}

function ProjectBlock({ node }: { node: ProjectNode }) {
  const p = node.project;
  return (
    <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <header className="mb-2 flex items-center gap-2">
        <span className="size-3.5 shrink-0 rounded-full" style={{ background: p.color }} />
        <a href={routeHref({ view: 'project', id: p.id })} className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline">{p.name}</a>
        <Stats p={p} />
      </header>
      {node.children.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {node.children.map((c) => <SubCard key={c.project.id} node={c} />)}
        </div>
      ) : (
        <p className="text-xs text-zinc-400">Sin subproyectos</p>
      )}
    </section>
  );
}

function SubCard({ node }: { node: ProjectNode }) {
  const p = node.project;
  return (
    <a href={routeHref({ view: 'project', id: p.id })}
      className="block rounded-lg border border-zinc-200 bg-white px-3 py-2 hover:border-indigo-300 hover:shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-indigo-700">
      <span className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
      </span>
      <span className="mt-1 flex items-center justify-between gap-2">
        <Stats p={p} />
        {node.children.length > 0 && <span className="text-xs text-zinc-400">{node.children.length} subproyecto{node.children.length === 1 ? '' : 's'}</span>}
      </span>
    </a>
  );
}
