import { describe, expect, it } from 'vitest';
import { childrenOf, countIn, findSynced, parseSyncedRoots, searchSynced, trimSharePointExport } from '../src/domain/sharepointSync';
import { uploadSharePoint } from '../scripts/subir-onedrive.ts';

const SITE = 'https://caixa.sharepoint.com/sites/Guias';
const link = (p: string) => `https://caixa.sharepoint.com/sites/Guias/${encodeURI(p)}`;
const FLOW = {
  generado: '2026-11-23T10:00:00Z',
  carpetas: [{
    sitio: SITE, carpeta: 'General',
    elementos: [
      { nombre: 'App', ruta: 'Documentos compartidos/General/App', esCarpeta: 'True', enlace: link('Documentos compartidos/General/App'), modificado: '2026-11-20T09:00:00Z' },
      { nombre: 'Guía login.pdf', ruta: 'Documentos compartidos/General/App/Guía login.pdf', esCarpeta: false, enlace: link('x.pdf'), modificado: '2026-11-21T09:00:00Z' },
      { nombre: 'Acta.docx', ruta: 'Documentos compartidos/General/Acta.docx', esCarpeta: false, enlace: link('Acta.docx'), modificado: 'no es fecha' },
      { nombre: 'malo', ruta: 'Documentos compartidos/General/malo', esCarpeta: false, enlace: 'https://evil.com/x' },
      { nombre: 'subir', ruta: 'Documentos compartidos/../secreto', esCarpeta: false, enlace: link('y') },
    ],
  }],
};

describe('SharePoint sincronizado (Power Automate)', () => {
  const [root] = trimSharePointExport(FLOW);

  it('recorta lo que escribe el flujo y descarta lo que no es de SharePoint', () => {
    expect(root.site).toBe(SITE);
    expect(root.root).toBe('Documentos compartidos/General');
    expect(root.items.map((i) => i.n)).toEqual(['App', 'Guía login.pdf', 'Acta.docx']);
    expect(root.items[0].f).toBe(true);
    expect(root.items[2].m).toBeNull();
    // También con los campos tal como los da SharePoint.
    const raw = trimSharePointExport({ carpetas: [{ sitio: SITE, elementos: [{ '{FilenameWithExtension}': 'a.pdf', '{FullPath}': 'Docs/A/a.pdf', '{IsFolder}': false, '{Link}': link('a.pdf'), Modified: '2026-11-01T00:00:00Z' }] }] });
    expect(raw[0]).toMatchObject({ root: 'Docs/A', items: [{ n: 'a.pdf', p: 'Docs/A/a.pdf', f: false }] });
    expect(trimSharePointExport({ carpetas: [{ sitio: 'https://evil.com', elementos: [] }] })).toEqual([]);
  });

  it('navega por carpetas y busca por nombre', () => {
    expect(childrenOf(root, root.root).map((i) => i.n)).toEqual(['App', 'Acta.docx']); // carpetas primero
    expect(childrenOf(root, 'Documentos compartidos/General/App').map((i) => i.n)).toEqual(['Guía login.pdf']);
    expect(countIn(root, 'Documentos compartidos/General/App')).toBe(1);
    expect(searchSynced([root], 'guia LOGIN').map((r) => r.item.n)).toEqual(['Guía login.pdf']);
    expect(searchSynced([root], ' ')).toEqual([]);
  });

  it('encuentra una carpeta guardada en lo sincronizado', () => {
    expect(findSynced([root], 'https://caixa.sharepoint.com', '/sites/Guias/Documentos compartidos/General')).toMatchObject({ path: 'Documentos compartidos/General' });
    expect(findSynced([root], 'https://caixa.sharepoint.com', '/sites/Guias/Documentos compartidos/General/App')).toMatchObject({ path: 'Documentos compartidos/General/App' });
    expect(findSynced([root], 'https://caixa.sharepoint.com', '/sites/Otro/Documentos compartidos/General')).toBeNull();
    expect(findSynced([root], 'https://otro.sharepoint.com', '/sites/Guias/Documentos compartidos/General')).toBeNull();
  });

  it('vuelve a comprobar lo que llega de Supabase', () => {
    const back = parseSyncedRoots(JSON.parse(JSON.stringify([root, { site: 'https://evil.com', items: [] }, { site: SITE, root: 'X', items: [{ n: 'a', p: 'X/a', u: 'javascript:1' }] }])));
    expect(back).toHaveLength(2);
    expect(back[0].items).toHaveLength(3);
    expect(back[1].items).toEqual([]);
  });

  it('el Mac sube la lista recortada con la clave', async () => {
    let body: Record<string, unknown> | null = null;
    const fake = (async (_: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify('Marta'), { status: 200 });
    }) as unknown as typeof fetch;
    const done = await uploadSharePoint({ url: 'https://abc.supabase.co', key: 'anon', token: 'gsub_1', text: `﻿${JSON.stringify(FLOW)}`, fileAt: new Date('2026-11-23T10:00:00Z') }, fake);
    expect(done).toEqual({ folders: 1, items: 3 });
    expect(body).toMatchObject({ p_token: 'gsub_1', p_kind: 'sharepoint', p_file_at: '2026-11-23T10:00:00.000Z' });
    const fail = (async () => new Response(JSON.stringify({ message: 'Tipo de archivo no admitido.' }), { status: 400 })) as unknown as typeof fetch;
    await expect(uploadSharePoint({ url: 'x', key: 'k', token: 't', text: '{}', fileAt: new Date() }, fail)).rejects.toThrow(/014/);
    await expect(uploadSharePoint({ url: 'x', key: 'k', token: 't', text: 'no json', fileAt: new Date() }, fake)).rejects.toThrow(/JSON/);
  });
});
