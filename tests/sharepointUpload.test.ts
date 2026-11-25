import { describe, expect, it, vi } from 'vitest';

// La extensión de Chrome, de mentira: lo que le pide Marea y lo que contesta SharePoint.
const calls: { op: string; args: Record<string, unknown> }[] = [];
vi.mock('../src/features/mslist/extension', () => ({
  extensionVersion: () => '1.6.0',
  isOutdated: () => false,
  extDocs: async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    if (op === 'resolve') return { siteUrl: SITE, folder: FOLDER };
    if (op === 'folder') return { path: FOLDER, site: '/sites/Equipo', url: `https://caixa.sharepoint.com${encodeURI(FOLDER)}`, entries: [], truncated: false };
    if (op === 'upload') {
      if (args.name === 'repe.docx') throw new Error('Ya hay un archivo con el nombre «repe.docx» en la carpeta.');
      return { name: args.name, url: 'https://x' };
    }
    throw new Error(op);
  },
}));

const SITE = 'https://caixa.sharepoint.com/sites/Equipo';
const FOLDER = '/sites/Equipo/Shared Documents/Entregas';

describe('SharePoint: subir archivos a la carpeta que se ve', () => {
  it('sube con la extensión, sin sustituir, salta los de más de 15 MB y vuelve a leer la carpeta', async () => {
    const { openWithExtension, uploadFiles, canUpload, MAX_UPLOAD_BYTES } = await import('../src/features/sharepoint/sharepointStore');
    await expect(uploadFiles([new File(['x'], 'a.txt')])).rejects.toThrow(/extensión/);
    await openWithExtension(`${SITE}/Shared%20Documents/Entregas`);
    expect(canUpload()).toBe(true);
    calls.length = 0;
    const big = new File(['x'], 'grande.zip');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    const progress: number[] = [];
    const r = await uploadFiles([new File(['hola'], 'informe.docx'), new File(['x'], 'repe.docx'), big], (done) => progress.push(done));
    expect(r).toEqual([
      { name: 'informe.docx', error: null },
      { name: 'repe.docx', error: 'Ya hay un archivo con el nombre «repe.docx» en la carpeta.' },
      { name: 'grande.zip', error: 'pesa más de 15 MB: súbelo en SharePoint' },
    ]);
    expect(progress).toEqual([0, 1, 2, 3]);
    const up = calls.filter((c) => c.op === 'upload');
    expect(up.map((c) => c.args.name)).toEqual(['informe.docx', 'repe.docx']);
    expect(up[0].args).toMatchObject({ siteUrl: SITE, folder: FOLDER, base64: btoa('hola') });
    expect(calls.at(-1)?.op).toBe('folder'); // se vuelve a leer la carpeta
  });
});
