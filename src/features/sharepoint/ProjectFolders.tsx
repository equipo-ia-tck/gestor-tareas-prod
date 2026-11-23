import { useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import type { Project } from '../../domain/types';
import { track } from '../usage/track';
import { AddFolder } from './SharePointView';
import { saveFolders } from './folders';

/**
 * Carpetas de SharePoint de un proyecto, en una línea debajo de las cifras: cada una abre la carpeta en SharePoint (con la
 * cuenta de CaixaBank). «Añadir carpeta» pega un enlace; las ve quien ve el proyecto. Solo se guarda nombre y enlace.
 */
export function ProjectFolders({ project }: { project: Project }) {
  const [adding, setAdding] = useState(false);
  const folders = project.folders ?? [];
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="mr-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Carpetas</span>
        {folders.map((f) => (
          <span key={f.id} className="group inline-flex items-center rounded-full border border-zinc-200 bg-white pr-1 dark:border-zinc-700 dark:bg-zinc-900">
            <a href={f.url} target="_blank" rel="noopener noreferrer" title={`Abrir en SharePoint: ${f.url}`} onClick={() => track('sharepoint', 'open-project')}
              className="inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 hover:underline">
              <Folder className="size-3.5 text-amber-500" />{f.name}
            </a>
            <button type="button" aria-label={`Quitar ${f.name}`} title="Quitar el acceso (la carpeta no se toca)"
              onClick={() => { if (window.confirm(`¿Quitar el acceso «${f.name}» de este proyecto?`)) void saveFolders(project.id, folders.filter((x) => x.id !== f.id), `Carpeta «${f.name}» quitada`); }}
              className="rounded-full p-0.5 text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600"><X className="size-3" /></button>
          </span>
        ))}
        <button type="button" onClick={() => setAdding(!adding)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:border-indigo-400 dark:border-zinc-600 dark:text-zinc-300">
          <FolderPlus className="size-3.5" />{folders.length ? 'Añadir' : 'Añadir carpeta de SharePoint'}
        </button>
      </div>
      {adding && <div className="mt-2"><AddFolder projectId={project.id} compact /></div>}
    </div>
  );
}
