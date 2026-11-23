import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileSize, folderNameFromUrl, isSharePointOrigin, isSharePointUrl, parseSnapshot } from '../src/domain/sharepoint';
import { bookmarkletCode } from '../src/features/sharepoint/bookmarklet';
import { newFolder } from '../src/features/sharepoint/folders';

const SITE = 'https://caixa.sharepoint.com';
const LIB = `${SITE}/sites/Etiquetado/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FEtiquetado%2FShared%20Documents%2FGu%C3%ADas%2FApp`;

describe('SharePoint: enlaces', () => {
  it('solo acepta https de *.sharepoint.com', () => {
    expect(isSharePointUrl(LIB)).toBe(true);
    expect(isSharePointUrl('https://caixa-my.sharepoint.com/personal/x')).toBe(true);
    expect(isSharePointUrl('http://caixa.sharepoint.com/sites/x')).toBe(false);
    expect(isSharePointUrl('https://caixa.sharepoint.com.evil.com/sites/x')).toBe(false);
    expect(isSharePointUrl('https://evil.com/?u=sharepoint.com')).toBe(false);
    expect(isSharePointUrl('javascript:alert(1)')).toBe(false);
    expect(isSharePointUrl('https://user:pw@caixa.sharepoint.com/sites/x')).toBe(false);
    expect(isSharePointOrigin('https://caixa.sharepoint.com')).toBe(true);
    expect(isSharePointOrigin('https://caixa.sharepoint.com.evil.com')).toBe(false);
  });

  it('propone el nombre de la carpeta', () => {
    expect(folderNameFromUrl(LIB)).toBe('App');
    expect(folderNameFromUrl(`${SITE}/sites/Etiquetado/Shared%20Documents/Gu%C3%ADas`)).toBe('Guías');
    expect(folderNameFromUrl(`${SITE}/:f:/r/sites/Etiquetado/Shared%20Documents/Entregas?csf=1`)).toBe('Entregas');
    expect(folderNameFromUrl('https://otra.com/x')).toBe('');
    expect(newFolder(LIB, '  ')).toMatchObject({ name: 'App', url: LIB });
    expect(newFolder('https://otra.com/x')).toBeNull();
  });

  it('valida lo que manda el marcador y quita lo que no es de SharePoint', () => {
    const snap = parseSnapshot({
      url: `${SITE}/sites/Etiquetado/Shared%20Documents/Gu%C3%ADas`, path: '/sites/Etiquetado/Shared Documents/Guías',
      entries: [
        { kind: 'file', name: 'b.docx', url: `${SITE}/sites/Etiquetado/b.docx?web=1`, size: 2048, modified: '2026-11-20T10:00:00Z' },
        { kind: 'folder', name: 'Z', url: `${SITE}/sites/Etiquetado/Z`, size: 3, modified: null },
        { kind: 'file', name: 'malo', url: 'javascript:alert(1)', size: 1 },
        { kind: 'otro', name: 'x', url: `${SITE}/x` },
      ],
    })!;
    expect(snap.entries.map((e) => e.name)).toEqual(['Z', 'b.docx']); // carpetas primero
    expect(snap.host).toBe('caixa.sharepoint.com');
    expect(parseSnapshot({ url: 'https://evil.com', entries: [] })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(fileSize(2048)).toBe('2 KB');
  });
});

describe('SharePoint: marcador', () => {
  afterEach(() => { vi.useRealTimers(); });

  function run(href: string, folders: unknown[], files: unknown[]) {
    vi.useFakeTimers();
    const app = 'https://marea.example';
    const sent: { msg: Record<string, unknown>; origin: string }[] = [];
    const requests: string[] = [];
    let listener: ((e: unknown) => void) | null = null;
    const marea = { postMessage: (msg: Record<string, unknown>, origin: string) => sent.push({ msg, origin }) };
    const opened: string[] = [];
    const win = {
      open: (url: string) => { opened.push(url); return marea; },
      addEventListener: (_: string, fn: (e: unknown) => void) => { listener = fn; },
      removeEventListener: () => { listener = null; },
    };
    const el = () => ({ style: {}, remove() {}, textContent: '' });
    const doc = { getElementById: () => null, createElement: el, body: { appendChild() {} } };
    const loc = new URL(href);
    const fetch = async (url: string) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => ({ value: url.includes('/Folders?') ? folders : files }) };
    };
    new Function('window', 'document', 'location', 'fetch', bookmarkletCode(app))(win, doc, loc, fetch);
    return { app, sent, requests, opened, marea, reply: () => listener?.({ origin: app, source: marea, data: { type: 'marea-sp:ready' } }) };
  }

  it('lee la carpeta abierta con la sesión y se la manda solo a Marea', async () => {
    const r = run(LIB,
      [{ Name: 'Forms', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Forms' }, { Name: 'Sub', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Guías/App/Sub', ItemCount: 2, TimeLastModified: '2026-11-19T09:00:00Z' }],
      [{ Name: 'Guía #1.docx', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Guías/App/Guía #1.docx', Length: '1200', TimeLastModified: '2026-11-20T09:00:00Z' }]);
    expect(r.opened).toEqual([`${r.app}/#/sharepoint`]);
    vi.advanceTimersByTime(800);
    expect(r.sent[0]).toEqual({ msg: { type: 'marea-sp:hello' }, origin: r.app });
    r.reply();
    await vi.runAllTimersAsync();
    expect(r.requests).toHaveLength(2);
    expect(r.requests[0]).toContain('https://caixa.sharepoint.com/sites/Etiquetado/_api/web/GetFolderByServerRelativePath(decodedurl=@u)/');
    expect(decodeURIComponent(r.requests[0])).toContain("@u='/sites/Etiquetado/Shared Documents/Guías/App'");
    const data = r.sent.find((s) => s.msg.type === 'marea-sp:folder')!;
    expect(data.origin).toBe(r.app);
    const snap = parseSnapshot(data.msg)!;
    expect(snap.path).toBe('/sites/Etiquetado/Shared Documents/Guías/App');
    // Sin la carpeta interna «Forms»; los nombres con # van codificados y los documentos se abren en el navegador.
    expect(snap.entries.map((e) => [e.kind, e.name])).toEqual([['folder', 'Sub'], ['file', 'Guía #1.docx']]);
    expect(snap.entries[1].url).toBe('https://caixa.sharepoint.com/sites/Etiquetado/Shared%20Documents/Gu%C3%ADas/App/Gu%C3%ADa%20%231.docx?web=1');
    expect(snap.entries[1].size).toBe(1200);
  });

  it('fuera de una biblioteca no lee nada ni abre Marea', () => {
    const r = run(`${SITE}/_layouts/15/sharepoint.aspx`, [], []);
    expect(r.opened).toEqual([]);
    expect(r.requests).toEqual([]);
  });
});
