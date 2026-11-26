import { describe, expect, it } from 'vitest';
import { htmlToText, keepLinks } from '../servidor/rally';
import { linkParts, sharePointTarget } from '../src/domain/sharepoint';

const SP = 'https://banco.sharepoint.com';

describe('Discusión de Rally: enlaces que se pueden pulsar', () => {
  it('no pierde la dirección de un enlace aunque su texto sea otro', () => {
    const html = 'Mira <a href="https://banco.sharepoint.com/sites/A/Docs/g.pdf?a=1&amp;b=2">la guía</a> y <a href="https://x.com/y">https://x.com/y</a>';
    expect(htmlToText(keepLinks(html)).replace(/ {2,}/g, ' ')).toBe('Mira la guía (https://banco.sharepoint.com/sites/A/Docs/g.pdf?a=1&b=2) y https://x.com/y');
  });

  it('parte el texto en trozos y enlaces, sin el punto final', () => {
    expect(linkParts('Ver https://a.com/x. Y (https://b.com/y) fin')).toEqual([
      { text: 'Ver ' }, { text: 'https://a.com/x', url: 'https://a.com/x' }, { text: '. Y (' },
      { text: 'https://b.com/y', url: 'https://b.com/y' }, { text: ') fin' },
    ]);
    expect(linkParts('sin enlaces')).toEqual([{ text: 'sin enlaces' }]);
  });

  it('sabe si un enlace de SharePoint es una carpeta o un archivo', () => {
    expect(sharePointTarget(`${SP}/sites/A/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FA%2FShared%20Documents%2FGu%C3%ADas`))
      .toMatchObject({ kind: 'folder' });
    expect(sharePointTarget(`${SP}/:f:/s/A/EAbc123`)).toMatchObject({ kind: 'folder' });
    expect(sharePointTarget(`${SP}/:b:/r/sites/A/Shared%20Documents/Gu%C3%ADas/plan.pdf?csf=1`)).toEqual({
      kind: 'file', folderUrl: `${SP}/sites/A/Shared%20Documents/Gu%C3%ADas`, path: '/sites/A/Shared Documents/Guías/plan.pdf', name: 'plan.pdf',
    });
    expect(sharePointTarget(`${SP}/sites/A/Shared%20Documents/Gu%C3%ADas/plan.docx?web=1`)).toMatchObject({ kind: 'file', name: 'plan.docx' });
    expect(sharePointTarget(`${SP}/:w:/s/A/EFxyz`)).toBeNull(); // compartir un archivo: se abre en SharePoint
    expect(sharePointTarget(`${SP}/:w:/r/sites/A/_layouts/15/Doc.aspx?sourcedoc={1}&file=a.docx`)).toBeNull();
    expect(sharePointTarget('https://otra.com/x')).toBeNull();
  });
});
