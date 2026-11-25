import { describe, expect, it } from 'vitest';
import { directorySites } from '../src/domain/sharepoint';
import { spDocs } from '../src/features/assistant/spDocs';

const SITE = 'https://banco.sharepoint.com/sites/Equipo';
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json;odata=nometadata' } });

async function withFetch<T>(f: (url: string, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

describe('Directorio de La Caixa para las reuniones', () => {
  it('busca en un sitio por dominio de las carpetas guardadas', () => {
    expect(directorySites([
      { url: `${SITE}/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FEquipo%2FShared%20Documents%2FGu%C3%ADas` },
      { url: 'https://banco.sharepoint.com/sites/Otro/Shared%20Documents' },
      { url: 'https://agencia.sharepoint.com/teams/Analitica/Documentos' },
      { url: 'https://no-es-sharepoint.com/x' },
    ])).toEqual([SITE, 'https://agencia.sharepoint.com/teams/Analitica']);
    expect(directorySites([])).toEqual([]);
  });

  it('usa el selector de personas de SharePoint (nombre, email y cargo, sin repetidos)', async () => {
    const asked: { url: string; body?: string }[] = [];
    const people = await withFetch(async (url, init) => {
      asked.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/_api/contextinfo')) return json({ FormDigestValue: 'dg' });
      return json({ value: JSON.stringify([
        { Key: 'i:0#.f|membership|ana.perez@banco.com', DisplayText: 'Ana Pérez', EntityData: { Email: 'Ana.Perez@banco.com', Title: 'PO' } },
        { Key: 'i:0#.f|membership|luis@banco.com', DisplayText: 'Luis Gil', EntityData: {} },
        { Key: 'x', DisplayText: 'Ana otra vez', EntityData: { Email: 'ana.perez@banco.com' } },
        { Key: 'grupo', DisplayText: 'Grupo sin email', EntityData: {} },
      ]) });
    }, () => spDocs('people', { siteUrl: SITE, query: 'ana' }));
    expect(people).toEqual({ people: [
      { name: 'Ana Pérez', email: 'ana.perez@banco.com', title: 'PO' },
      { name: 'Luis Gil', email: 'luis@banco.com', title: '' },
    ] });
    expect(JSON.parse(asked[1].body!).queryParams.QueryString).toBe('ana');
  });

  it('si el selector no deja, prueba con el buscador de personas; con menos de 2 letras no busca', async () => {
    const people = await withFetch(async (url) => {
      if (url.endsWith('/_api/contextinfo')) return new Response('', { status: 403 });
      return json({ PrimaryQueryResult: { RelevantResults: { Table: { Rows: [
        { Cells: [{ Key: 'PreferredName', Value: 'Marta Ruiz' }, { Key: 'WorkEmail', Value: 'marta@banco.com' }, { Key: 'JobTitle', Value: 'Analista' }] },
      ] } } } });
    }, () => spDocs('people', { siteUrl: SITE, query: 'marta' }));
    expect(people).toEqual({ people: [{ name: 'Marta Ruiz', email: 'marta@banco.com', title: 'Analista' }] });
    expect(await spDocs('people', { siteUrl: SITE, query: 'a' })).toEqual({ people: [] });
    await expect(spDocs('people', { siteUrl: 'https://evil.es', query: 'ana' })).rejects.toThrow(/no es de SharePoint/);
  });
});
