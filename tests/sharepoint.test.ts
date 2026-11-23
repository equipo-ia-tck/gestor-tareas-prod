import { afterEach, describe, expect, it, vi } from 'vitest';
import { breadcrumbs, fileSize, folderLocation, folderNameFromUrl, isSharePointOrigin, isSharePointUrl, parseSnapshot, previewType } from '../src/domain/sharepoint';
import { handleBridgeMessage, openFolder, sharePointState, showFolder } from '../src/features/sharepoint/sharepointStore';
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
        { kind: 'file', name: 'b.docx', path: '/sites/Etiquetado/b.docx', url: `${SITE}/sites/Etiquetado/b.docx?web=1`, size: 2048, modified: '2026-11-20T10:00:00Z' },
        { kind: 'folder', name: 'Z', path: '/sites/Etiquetado/Z', url: `${SITE}/sites/Etiquetado/Z`, size: 3, modified: null },
        { kind: 'file', name: 'malo', path: '/sites/x', url: 'javascript:alert(1)', size: 1 },
        { kind: 'file', name: 'sin ruta', url: `${SITE}/x` },
        { kind: 'otro', name: 'x', path: '/x', url: `${SITE}/x` },
      ],
    })!;
    expect(snap.entries.map((e) => e.name)).toEqual(['Z', 'b.docx']); // carpetas primero
    expect(snap.host).toBe('caixa.sharepoint.com');
    expect(parseSnapshot({ url: 'https://evil.com', entries: [] })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(fileSize(2048)).toBe('2 KB');
  });

  it('saca la carpeta de un enlace guardado', () => {
    expect(folderLocation(LIB)).toEqual({ origin: SITE, path: '/sites/Etiquetado/Shared Documents/Guías/App' });
    expect(folderLocation(`${SITE}/sites/Etiquetado/Shared%20Documents/Gu%C3%ADas`)).toEqual({ origin: SITE, path: '/sites/Etiquetado/Shared Documents/Guías' });
    expect(folderLocation(`${SITE}/:f:/r/sites/Etiquetado/Shared%20Documents/Entregas?csf=1&web=1`)).toEqual({ origin: SITE, path: '/sites/Etiquetado/Shared Documents/Entregas' });
    expect(folderLocation(`${SITE}/:f:/s/Etiquetado/EabcdEFG123`)).toBeNull(); // enlace de compartir con código
    expect(folderLocation('https://otra.com/sites/x/y')).toBeNull();
  });

  it('migas de pan desde la biblioteca y qué se puede ver dentro', () => {
    expect(breadcrumbs('/sites/E/Shared Documents/Guías/App', '/sites/E').map((c) => c.name)).toEqual(['Shared Documents', 'Guías', 'App']);
    expect(breadcrumbs('/sites/E/Shared Documents/Guías', '/sites/E')[1].path).toBe('/sites/E/Shared Documents/Guías');
    expect(breadcrumbs('/sites/Otro/A', '/sites/E')).toEqual([]);
    expect(['a.PDF', 'b.jpg', 'c.docx', 'd.webp'].map(previewType)).toEqual(['application/pdf', 'image/jpeg', null, 'image/webp']);
  });
});

describe('SharePoint: marcador', () => {
  afterEach(() => { vi.useRealTimers(); });

  function run(href: string, folders: unknown[], files: unknown[], withOpener = false) {
    vi.useFakeTimers();
    const app = 'https://marea.example';
    const sent: { msg: Record<string, unknown>; origin: string }[] = [];
    const requests: string[] = [];
    let listener: ((e: unknown) => void) | null = null;
    const marea = { postMessage: (msg: Record<string, unknown>, origin: string) => sent.push({ msg, origin }) };
    const opened: string[] = [];
    const win = {
      opener: withOpener ? marea : null,
      open: (url: string) => { opened.push(url); return marea; },
      addEventListener: (_: string, fn: (e: unknown) => void) => { listener = fn; },
      removeEventListener: () => { listener = null; },
    };
    const el = () => ({ style: {}, remove() {}, textContent: '' });
    const doc = { getElementById: () => null, createElement: el, body: { appendChild() {} } };
    const loc = new URL(href);
    const fetch = async (url: string) => {
      requests.push(url);
      if (url.includes('GetFileByServerRelativePath')) {
        const buf = new ArrayBuffer(8);
        return { ok: true, status: 200, headers: { get: () => '8' }, arrayBuffer: async () => buf };
      }
      return { ok: true, status: 200, json: async () => ({ value: url.includes('/Folders?') ? folders : files }) };
    };
    new Function('window', 'document', 'location', 'fetch', bookmarkletCode(app))(win, doc, loc, fetch);
    const send = (data: unknown, from: unknown = marea, origin = app) => listener?.({ origin, source: from, data });
    return { app, sent, requests, opened, marea, send, reply: () => send({ type: 'marea-sp:ready' }) };
  }

  it('lee la carpeta abierta con la sesión y se la manda solo a Marea', async () => {
    const r = run(LIB,
      [{ Name: 'Forms', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Forms' }, { Name: 'Sub', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Guías/App/Sub', ItemCount: 2, TimeLastModified: '2026-11-19T09:00:00Z' }],
      [{ Name: 'Guía #1.docx', ServerRelativeUrl: '/sites/Etiquetado/Shared Documents/Guías/App/Guía #1.docx', Length: '1200', TimeLastModified: '2026-11-20T09:00:00Z' }]);
    expect(r.opened).toEqual([`${r.app}/#/sharepoint`]);
    vi.advanceTimersByTime(800);
    expect(r.sent[0]).toEqual({ msg: { type: 'marea-sp:hello', v: 3 }, origin: r.app });
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
    expect(snap.site).toBe('/sites/Etiquetado');

    // Se queda de puente: otra carpeta del mismo sitio, sí; de otro sitio o de otra web, no.
    r.send({ type: 'marea-sp:list', path: '/sites/Etiquetado/Shared Documents/Guías', request: 7 });
    await vi.runAllTimersAsync();
    expect(r.sent.at(-1)!.msg).toMatchObject({ type: 'marea-sp:folder', request: 7, path: '/sites/Etiquetado/Shared Documents/Guías' });
    // Otro sitio del mismo SharePoint, sí (con la sesión de la persona); una ruta que no es de un sitio, no.
    r.send({ type: 'marea-sp:list', path: '/sites/Otro/Shared Documents', request: 8 });
    await vi.runAllTimersAsync();
    expect(r.sent.at(-1)!.msg).toMatchObject({ type: 'marea-sp:folder', request: 8, site: '/sites/Otro' });
    expect(r.requests.at(-1)).toContain('https://caixa.sharepoint.com/sites/Otro/_api/');
    r.send({ type: 'marea-sp:list', path: '/_layouts/../x', request: 12 });
    await vi.runAllTimersAsync();
    expect(r.sent.at(-1)!.msg).toMatchObject({ type: 'marea-sp:error', request: 12 });
    const before = r.sent.length;
    r.send({ type: 'marea-sp:list', path: '/sites/Etiquetado/x', request: 9 }, {}, 'https://evil.com');
    await vi.runAllTimersAsync();
    expect(r.sent.length).toBe(before);

    // Archivos: solo PDF e imágenes.
    r.send({ type: 'marea-sp:file', path: '/sites/Etiquetado/Shared Documents/a.pdf', request: 10 });
    await vi.runAllTimersAsync();
    expect(r.sent.at(-1)!.msg).toMatchObject({ type: 'marea-sp:filedata', request: 10 });
    expect(r.sent.at(-1)!.msg.buffer).toBeInstanceOf(ArrayBuffer);
    r.send({ type: 'marea-sp:file', path: '/sites/Etiquetado/Shared Documents/a.docx', request: 11 });
    await vi.runAllTimersAsync();
    expect(r.sent.at(-1)!.msg).toMatchObject({ type: 'marea-sp:error', request: 11 });
  });

  it('si la pestaña la abrió Marea, habla con esa pestaña y no abre otra', async () => {
    const r = run(LIB, [], [], true);
    expect(r.opened).toEqual([]);
    r.reply();
    await vi.runAllTimersAsync();
    expect(r.opened).toEqual([]);
    expect(r.sent.some((x) => x.msg.type === 'marea-sp:folder')).toBe(true);
  });

  it('fuera de una biblioteca no lee nada ni abre Marea', () => {
    const r = run(`${SITE}/_layouts/15/sharepoint.aspx`, [], []);
    expect(r.opened).toEqual([]);
    expect(r.requests).toEqual([]);
  });
});

describe('SharePoint: Marea habla con el puente', () => {
  it('solo acepta mensajes de *.sharepoint.com y las respuestas del puente conectado', async () => {
    const posted: unknown[] = [];
    const sp = { closed: false, postMessage: (m: unknown) => posted.push(m) } as unknown as Window;
    handleBridgeMessage({ origin: 'https://evil.com', source: sp, data: { type: 'marea-sp:hello', v: 3 } } as MessageEvent);
    expect(posted).toEqual([]);
    // Marcador antiguo (sin versión): no se conecta y avisa de volver a arrastrarlo.
    handleBridgeMessage({ origin: SITE, source: sp, data: { type: 'marea-sp:hello' } } as MessageEvent);
    expect(posted).toEqual([]);
    expect(sharePointState().error).toMatch(/versión anterior/);
    handleBridgeMessage({ origin: SITE, source: sp, data: { type: 'marea-sp:hello', v: 3 } } as MessageEvent);
    expect(posted).toEqual([{ type: 'marea-sp:ready' }]);

    const going = openFolder('/sites/E/Shared Documents/B');
    const req = posted.at(-1) as { type: string; path: string; request: number };
    expect(req).toMatchObject({ type: 'marea-sp:list', path: '/sites/E/Shared Documents/B' });
    const answer = { type: 'marea-sp:folder', request: req.request, path: '/sites/E/Shared Documents/B', site: '/sites/E',
      url: `${SITE}/sites/E/Shared%20Documents/B`, entries: [] };
    // Una respuesta de otra ventana se ignora; la del puente, vale.
    handleBridgeMessage({ origin: SITE, source: {} as Window, data: answer } as MessageEvent);
    expect(sharePointState().loading).toBe(true);
    handleBridgeMessage({ origin: SITE, source: sp, data: answer } as MessageEvent);
    await going;
    expect(sharePointState()).toMatchObject({ loading: false, error: null, connected: true, snapshot: { path: '/sites/E/Shared Documents/B', site: '/sites/E' } });
  });
});

describe('SharePoint: carpeta guardada antes de conectar', () => {
  it('espera al marcador y, al conectar, abre la carpeta pedida', async () => {
    const posted: { type: string; path?: string; request?: number }[] = [];
    const sp = { closed: false, postMessage: (m: never) => posted.push(m) } as unknown as Window;
    // Otro SharePoint: no hay puente con él, así que queda esperando.
    expect(showFolder({ id: '1', name: 'Entregas', url: 'https://otro.sharepoint.com/sites/E/Shared%20Documents/Entregas' })).toBe(true);
    expect(sharePointState().waitingFor).toMatchObject({ name: 'Entregas', path: '/sites/E/Shared Documents/Entregas' });
    const ORIGIN = 'https://otro.sharepoint.com';
    handleBridgeMessage({ origin: ORIGIN, source: sp, data: { type: 'marea-sp:hello', v: 3 } } as MessageEvent);
    handleBridgeMessage({ origin: ORIGIN, source: sp, data: { type: 'marea-sp:folder', path: '/sites/E/Shared Documents', site: '/sites/E',
      url: `${ORIGIN}/sites/E/Shared%20Documents`, entries: [] } } as MessageEvent);
    expect(sharePointState().waitingFor).toBeNull();
    expect(posted.at(-1)).toMatchObject({ type: 'marea-sp:list', path: '/sites/E/Shared Documents/Entregas' });
    // Un enlace de compartir con código no dice qué carpeta es: se abre en SharePoint.
    expect(showFolder({ id: '2', name: 'x', url: `${ORIGIN}/:f:/s/E/EabcDEF` })).toBe(false);
  });
});
