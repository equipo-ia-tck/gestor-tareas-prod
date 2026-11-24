import { repo } from '../../data/services';
import { folderNameFromUrl, isSharePointUrl, type SharePointFolder } from '../../domain/sharepoint';
import type { Project, Settings } from '../../domain/types';

/** Acceso nuevo a partir de un enlace (y un nombre opcional); null si el enlace no es de SharePoint. */
export function newFolder(url: string, name = ''): SharePointFolder | null {
  const clean = url.trim();
  if (!isSharePointUrl(clean)) return null;
  return { id: crypto.randomUUID(), name: (name.trim() || folderNameFromUrl(clean) || 'Carpeta').slice(0, 120), url: clean };
}

/**
 * Dónde va un acceso: en los ajustes (personal, `projectId` null) o en el proyecto (lo ve quien ve el proyecto; con
 * «Deshacer»).
 */
export async function saveFolders(projectId: string | null, folders: SharePointFolder[], label: string) {
  if (projectId) await repo.batch(label, () => repo.updateProject(projectId, { folders }));
  else await repo.updateSettings({ sharepoint_folders: folders });
}

export const foldersOf = (projectId: string | null, projects: Project[], settings: Settings): SharePointFolder[] =>
  projectId ? projects.find((p) => p.id === projectId)?.folders ?? [] : settings.sharepoint_folders;
