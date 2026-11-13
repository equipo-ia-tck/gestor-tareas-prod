import { describe, expect, it } from 'vitest';
import { fillTemplate, parseTemplate, promptsOf, templatesFor } from '../src/domain/templates';
import { DEFAULT_ITEM_TYPES } from '../src/domain/workflows';
import { makeTask } from './factories';

const us = DEFAULT_ITEM_TYPES.find((t) => t.id === 'us')!;
const task = DEFAULT_ITEM_TYPES.find((t) => t.id === 'task')!;

const tpl = parseTemplate('entrega-us', `---
nombre: Entrega de US
tipos: US, ts
---
Hola {para}:

Te paso la {id} · {titulo} ({estado}).
Hecho:
{hecho}
Pendiente:
{pendiente}
Enlace: {enlace}
Notas: {descripcion}
{desconocido}`);

describe('plantillas de mensajes', () => {
  it('lee la cabecera y filtra por tipo', () => {
    expect(tpl).toMatchObject({ name: 'Entrega de US', types: ['us', 'ts'] });
    expect(templatesFor([tpl], us)).toHaveLength(1);
    expect(templatesFor([tpl], task)).toHaveLength(0);
    expect(templatesFor([parseTemplate('libre', 'Hola')], task)[0]).toMatchObject({ name: 'libre', body: 'Hola' });
  });

  it('rellena los campos y quita las líneas que quedan vacías', () => {
    const t = makeTask({
      title: 'Alta Bizum', type_id: 'us', state_id: 'us-qa', external_id: 'US1764574', people: ['Mike Ross', 'Rosa'],
      checklist: [{ id: '1', text: 'Etiquetado', done: true }, { id: '2', text: 'Validación de Mike', done: false }],
    });
    expect(fillTemplate(tpl, t, { type: us, link: null })).toBe(
      'Hola Mike y Rosa:\n\nTe paso la US1764574 · Alta Bizum (En QA).\nHecho:\n✓ Etiquetado\nPendiente:\n• Validación de Mike\n{desconocido}',
    );
    expect(fillTemplate(tpl, t, { type: us, link: 'https://rally/x', recipients: ['Ana'] })).toContain('Hola Ana:');
    expect(fillTemplate(tpl, t, { type: us, link: 'https://rally/x' })).toContain('Enlace: https://rally/x');
  });

  it('pregunta los huecos y usa las personas de la tarea por defecto', () => {
    const t2 = parseTemplate('defect', '---\ngrupo: Validaciones\n---\nHola {?PO IT|para},\nHe creado el defect {?Número de defect}.\ncc {?Analista}, {?PO IT|para}');
    expect(t2.group).toBe('Validaciones');
    expect(promptsOf(t2)).toEqual([{ label: 'PO IT', from: 'para' }, { label: 'Número de defect', from: null }, { label: 'Analista', from: null }]);
    const task = makeTask({ people: ['Mike'] });
    expect(fillTemplate(t2, task, { type: us })).toBe('Hola Mike,\nHe creado el defect <Número de defect>.\ncc <Analista>, Mike');
    expect(fillTemplate(t2, makeTask(), { type: us }, { 'Número de defect': 'DE125701', Analista: 'Ana' }))
      .toBe('Hola <PO IT>,\nHe creado el defect DE125701.\ncc Ana, <PO IT>');
  });
});

describe('templateComment', () => {
  it('la entrega de la guía sin huecos: «Hola,» y sin la línea de cc', async () => {
    const { readFileSync } = await import('node:fs');
    const { templateComment } = await import('../src/domain/templates');
    const text = templateComment(parseTemplate('guia-5-entrega', readFileSync('plantillas/guia-5-entrega.md', 'utf8')));
    expect(text.startsWith('Hola,\n\nDejo adjunta la guía')).toBe(true);
    expect(text.endsWith('Un saludo')).toBe(true);
    expect(text).not.toMatch(/\{|cc/);
  });
});
