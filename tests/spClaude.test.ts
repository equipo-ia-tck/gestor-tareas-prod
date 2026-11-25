import { describe, expect, it } from 'vitest';
import { rootFor, sameFolderUrl, serverPath, textPart, PART, type SpRoot } from '../src/domain/spClaude';
import { describeRequest, handleSpRequest } from '../src/features/sharepoint/claudeBridge';
import { askSharePoint } from '../servidor/mcp';
import { findFolder, formatSpFolder, formatSpRead, formatSpSearch, type MareaData } from '../src/domain/mcpTools';

const SITE = 'https://caixa.sharepoint.com/sites/Equipo';
const ROOT = '/sites/Equipo/Shared Documents/Guías';
const FOLDER_URL = `${SITE}/Shared%20Documents/Forms/AllItems.aspx?id=${encodeURIComponent(ROOT)}`;
const root: SpRoot = { url: FOLDER_URL, name: 'Guías', siteUrl: SITE, folder: ROOT };

describe('SharePoint para Claude: solo dentro de las carpetas guardadas', () => {
  it('rutas y enlaces', () => {
    expect(serverPath(`${SITE}/Shared%20Documents/Gu%C3%ADas/a.docx?web=1`)).toEqual({ host: 'caixa.sharepoint.com', path: '/sites/Equipo/Shared Documents/Guías/a.docx' });
    expect(serverPath(FOLDER_URL)?.path).toBe(ROOT);
    expect(serverPath(`${ROOT}/../Privado/x.docx`)).toBeNull();
    expect(serverPath('https://evil.es/a')).toBeNull();
    expect(serverPath('relativa/a.docx')).toBeNull();
    expect(rootFor([root], `${ROOT}/2026/a.docx`)?.path).toBe(`${ROOT}/2026/a.docx`);
    expect(rootFor([root], `/sites/Equipo/Shared Documents/GuíasPrivadas/a.docx`)).toBeNull();
    expect(rootFor([root], `https://otra.sharepoint.com${encodeURI(ROOT)}/a.docx`)).toBeNull();
    expect(rootFor([root], `${ROOT.toUpperCase()}/A.DOCX`)).not.toBeNull();
    expect(sameFolderUrl('https://CAIXA.sharepoint.com/x/', 'https://caixa.sharepoint.com/x')).toBe(true);
  });

  it('el texto largo va por partes', () => {
    const t = 'a'.repeat(PART + 10);
    expect(textPart(t)).toMatchObject({ part: 1, parts: 2 });
    expect(textPart(t, 2).text).toBe('a'.repeat(10));
    expect(textPart(t, 9).part).toBe(2);
  });

  const folders = [{ id: 'f1', name: 'Guías', url: FOLDER_URL }];
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const ext = (async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    if (op === 'resolve') return { siteUrl: SITE, folder: ROOT };
    if (op === 'folder') return { path: args.folder, url: `${SITE}/x`, truncated: false, entries: [
      { kind: 'file', name: 'a.docx', path: `${ROOT}/a.docx`, url: `${SITE}/a.docx?web=1`, size: 2048, modified: '2026-11-20T10:00:00Z' }] };
    if (op === 'search') return { hits: [
      { title: 'Guía login', url: `${SITE}/Shared%20Documents/Gu%C3%ADas/login.docx`, summary: 'La <c0>evar</c0> 69<ddd/>', author: 'Ana', modified: '', type: 'docx' },
      { title: 'De fuera', url: `${SITE}/Shared%20Documents/Privado/x.docx`, summary: '', author: '', modified: '', type: 'docx' }] };
    if (op === 'text') return { name: 'a.docx', text: 'Hola', truncated: false };
    throw new Error('op');
  }) as never;

  it('la pestaña hace la petición con la extensión y rechaza lo de fuera', async () => {
    const listed = await handleSpRequest({ id: '1', op: 'folder', args: { folderUrl: FOLDER_URL } }, folders, ext) as { entries: unknown[]; folder: string };
    expect(listed).toMatchObject({ folder: 'Guías', path: ROOT });
    expect(listed.entries).toHaveLength(1);
    await expect(handleSpRequest({ id: '2', op: 'folder', args: { folderUrl: `${SITE}/Otra` } }, folders, ext)).rejects.toThrow(/no está guardada/);
    await expect(handleSpRequest({ id: '3', op: 'folder', args: { folderUrl: FOLDER_URL, path: '/sites/Equipo/Shared Documents/Privado' } }, folders, ext)).rejects.toThrow(/no está dentro/);
    await expect(handleSpRequest({ id: '4', op: 'read', args: { path: '/sites/Equipo/Shared Documents/Privado/x.docx' } }, folders, ext)).rejects.toThrow(/no está dentro de ninguna/);
    expect(await handleSpRequest({ id: '5', op: 'read', args: { path: `${ROOT}/a.docx` } }, folders, ext)).toMatchObject({ name: 'a.docx', text: 'Hola', folder: 'Guías' });
    const found = await handleSpRequest({ id: '6', op: 'search', args: { query: 'qué evar es el login' } }, folders, ext) as { results: { hits: { title: string; summary: string }[] }[] };
    expect(found.results[0].hits.map((h) => h.title)).toEqual(['Guía login']);
    expect(found.results[0].hits[0].summary).toBe('La evar 69…');
    expect(calls.find((c) => c.op === 'search')!.args.scope).toBe('https://caixa.sharepoint.com/sites/Equipo/Shared%20Documents/Gu%C3%ADas');
    await expect(handleSpRequest({ id: '7', op: 'read', args: { path: `${ROOT}/a.docx` } }, [], ext)).rejects.toThrow(/No hay carpetas/);
    expect(describeRequest({ id: '8', op: 'read', args: { path: `${ROOT}/a%20b.docx` } }, folders)).toBe('Leer a b.docx');
  });
});

describe('conector: herramientas de SharePoint', () => {
  const config = { url: 'https://sb.test', key: 'anon' };
  const fake = (collect: object[]) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      const fn = url.split('/rpc/')[1];
      seen.push(fn);
      if (fn === 'sp_request') return Response.json('req-1');
      if (fn === 'sp_collect') return Response.json(collect.shift() ?? { status: 'pending' });
      if (fn === 'sp_cancel') return Response.json(null);
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, seen };
  };

  it('espera la respuesta de la pestaña, da sus errores y se cansa si nadie contesta', async () => {
    const ok = fake([{ status: 'pending' }, { status: 'working' }, { status: 'done', result: { a: 1 } }]);
    expect(await askSharePoint(config, 't', 'folder', {}, ok.fetchImpl, 1000, 1)).toEqual({ a: 1 });
    const bad = fake([{ status: 'error', error: 'No es de una carpeta guardada.' }]);
    await expect(askSharePoint(config, 't', 'read', {}, bad.fetchImpl, 1000, 1)).rejects.toThrow('No es de una carpeta guardada.');
    const none = fake([]);
    await expect(askSharePoint(config, 't', 'read', {}, none.fetchImpl, 20, 5)).rejects.toThrow(/pestaña de Marea no contesta/);
    expect(none.seen).toContain('sp_cancel');
    const old = (async () => new Response(JSON.stringify({ message: 'Could not find the function' }), { status: 404 })) as unknown as typeof fetch;
    await expect(askSharePoint(config, 't', 'read', {}, old, 20, 5)).rejects.toThrow(/018_sharepoint_claude/);
  });

  it('busca la carpeta por nombre, enlace o proyecto y da formato a lo que llega', () => {
    const d = {
      folders: [{ id: 'f2', name: 'Mis guías', url: 'https://x.sharepoint.com/g' }],
      projects: [{ id: 'p1', name: 'Caixa', color: '#000', archived: false, created_at: '', parent_id: null, folders: [{ id: 'f1', name: 'Entregables', url: 'https://x.sharepoint.com/e' }] }],
    } as unknown as MareaData;
    expect(findFolder(d, 'entregables')?.folder.id).toBe('f1');
    expect(findFolder(d, 'https://x.sharepoint.com/g/')?.folder.id).toBe('f2');
    expect(findFolder(d, 'Caixa')?.folder.id).toBe('f1');
    expect(findFolder(d, 'nada')).toBeNull();
    const folder = formatSpFolder({ folder: 'Guías', path: `${ROOT}/2026`, url: 'https://u', truncated: false, entries: [
      { kind: 'folder', name: 'Q1', path: `${ROOT}/2026/Q1`, url: 'https://q', size: 3, modified: null },
      { kind: 'file', name: 'a.docx', path: `${ROOT}/2026/a.docx`, url: 'https://a', size: 2048, modified: '2026-11-20T10:00:00Z' }] });
    expect(folder).toContain('- Q1 · 3 elementos · ruta:');
    expect(folder).toContain('a.docx · 2 KB · 2026-11-20');
    expect(formatSpSearch('evar', { results: [], errors: [] })).toContain('No hay nada');
    expect(formatSpRead({ folder: 'Guías', name: 'a.docx', url: 'https://a', text: 'x'.repeat(PART + 1), truncated: false })).toContain('Parte 1 de 2');
  });
});
