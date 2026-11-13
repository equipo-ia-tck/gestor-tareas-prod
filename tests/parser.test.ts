import { describe, expect, it } from 'vitest';
import { parseCapture } from '../src/parser/parseCapture';
import { tokenKey, type CaptureContext } from '../src/parser/types';

// Fecha de referencia de la especificación: lunes 5 de octubre de 2026.
const ctx: CaptureContext = {
  today: '2026-10-05',
  projects: [
    { id: 'p-caixa', name: 'caixa' },
    { id: 'p-fc', name: 'Fundación Cadete' },
  ],
  people: ['Diana', 'Ana María'],
};

const one = (text: string, extra: Partial<CaptureContext> = {}) => {
  const r = parseCapture(text, { ...ctx, ...extra });
  expect(r).toHaveLength(1);
  return r[0];
};

describe('ejemplos de la especificación', () => {
  it('mañana mandar guía de etiquetado a @Diana #caixa', () => {
    const t = one('mañana mandar guía de etiquetado a @Diana #caixa');
    expect(t.due_date).toBe('2026-10-06');
    expect(t.people).toEqual(['Diana']);
    expect(t.project).toEqual({ id: 'p-caixa', name: 'caixa' });
    expect(t.title).toBe('mandar guía de etiquetado a Diana');
    expect(t.raw_input).toBe('mañana mandar guía de etiquetado a @Diana #caixa');
  });

  it('revisar defects cada lunes !1', () => {
    const t = one('revisar defects cada lunes !1');
    expect(t.recurrence).toEqual({ freq: 'weekly', interval: 1, weekdays: [1] });
    expect(t.priority).toBe(1);
    expect(t.due_date).toBe('2026-10-05'); // hoy es lunes: primera ocurrencia
    expect(t.title).toBe('revisar defects');
  });

  it('preparar demo el jueves ~2h !1', () => {
    const t = one('preparar demo el jueves ~2h !1');
    expect(t.due_date).toBe('2026-10-08');
    expect(t.estimated_minutes).toBe(120);
    expect(t.priority).toBe(1);
    expect(t.title).toBe('preparar demo');
  });

  it('llamar al dentista → sin fecha ni proyecto', () => {
    const t = one('llamar al dentista');
    expect(t).toMatchObject({ title: 'llamar al dentista', due_date: null, project: null, priority: null });
  });

  it('comprar café; renovar el DNI el viernes', () => {
    const r = parseCapture('comprar café; renovar el DNI el viernes', ctx);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'comprar café', due_date: null });
    expect(r[1]).toMatchObject({ title: 'renovar el DNI', due_date: '2026-10-09' });
  });

  it('pasado mañana revisar informe #trabajo ~45m', () => {
    const t = one('pasado mañana revisar informe #trabajo ~45m');
    expect(t.due_date).toBe('2026-10-07');
    expect(t.project).toEqual({ id: null, name: 'trabajo', parent_id: null }); // proyecto nuevo
    expect(t.estimated_minutes).toBe(45);
    expect(t.title).toBe('revisar informe');
  });
});

describe('fechas', () => {
  it.each([
    ['hoy', '2026-10-05'],
    ['mañana', '2026-10-06'],
    ['manana sin tilde', '2026-10-06'],
    ['el miércoles', '2026-10-07'],
    ['el miercoles', '2026-10-07'],
    ['el sábado', '2026-10-10'],
    ['el lunes que viene', '2026-10-12'],
    ['el próximo martes', '2026-10-06'],
    ['la semana que viene', '2026-10-12'],
    ['fin de mes', '2026-10-31'],
    ['15 oct', '2026-10-15'],
    ['15 de octubre', '2026-10-15'],
    ['el 3 de noviembre', '2026-11-03'],
    ['1 ene', '2027-01-01'],
    ['el 15 de octubre de 2027', '2027-10-15'],
    ['20/10', '2026-10-20'],
    ['dentro de 3 días', '2026-10-08'],
    ['en dos semanas', '2026-10-19'],
    ['esta tarde', '2026-10-05'],
  ])('%s → %s', (phrase, expected) => {
    expect(one(`hacer algo ${phrase}`).due_date).toBe(expected);
  });

  it('"el lunes" dicho en lunes es el de la semana siguiente', () => {
    expect(one('reunión el lunes').due_date).toBe('2026-10-12');
  });

  it('"este lunes" dicho en lunes es hoy', () => {
    expect(one('reunión este lunes').due_date).toBe('2026-10-05');
  });

  it('una fecha ya pasada sin año se entiende del año siguiente', () => {
    expect(one('renovar seguro 2 oct').due_date).toBe('2027-10-02');
  });

  it('rechaza fechas imposibles', () => {
    expect(one('pagar 31/02').due_date).toBeNull();
  });

  it('solo toma la primera fecha; el resto queda en el título', () => {
    const t = one('mañana preparar lo del viernes');
    expect(t.due_date).toBe('2026-10-06');
    expect(t.title).toBe('preparar lo del viernes');
  });
});

describe('palabras que parecen fechas pero no lo son', () => {
  it.each([
    'llamar por la mañana',
    'revisar el informe de marzo',
    'quedar con Mayo',
    'llamar a las 5',
    'comprar 2 libros',
    'repasar los lunes de la academia',
  ])('%s → sin fecha', (text) => {
    expect(one(text).due_date).toBeNull();
  });

  it('un email no es una persona', () => {
    expect(one('escribir a ana@correo.com').people).toEqual([]);
  });

  it('un # en medio de una palabra no es proyecto', () => {
    expect(one('arreglar issue C#').project).toBeNull();
  });
});

describe('tokens con símbolo', () => {
  it('reconoce proyectos sin importar mayúsculas, tildes ni guiones', () => {
    expect(one('tarea #fundacion-cadete').project).toEqual({ id: 'p-fc', name: 'Fundación Cadete' });
    expect(one('tarea #CAIXA').project?.id).toBe('p-caixa');
  });

  it('normaliza personas conocidas y admite varias', () => {
    const t = one('revisar con @diana y @ana-maría y @Pedro');
    expect(t.people).toEqual(['Diana', 'Ana María', 'Pedro']);
    expect(t.title).toBe('revisar con Diana y Ana María y Pedro');
  });

  it.each([
    ['~30m', 30], ['~45min', 45], ['~2h', 120], ['~1h30', 90], ['~1,5h', 90], ['~90', 90],
  ])('estimación %s → %i min', (tok, min) => {
    expect(one(`tarea ${tok}`).estimated_minutes).toBe(min);
  });

  it('deja como texto los tokens mal escritos', () => {
    const t = one('tarea !5 ~abc ~0m ! #');
    expect(t.priority).toBeNull();
    expect(t.estimated_minutes).toBeNull();
    expect(t.project).toBeNull();
    expect(t.title).toBe('tarea !5 ~abc ~0m ! #');
  });

  it('solo cuenta el primer proyecto y la primera prioridad', () => {
    const t = one('tarea #caixa #otro !2 !1');
    expect(t.project?.id).toBe('p-caixa');
    expect(t.priority).toBe(2);
    expect(t.title).toBe('tarea #otro !1');
  });

  it('etiquetas con +', () => {
    expect(one('tarea +urgente +casa').tags).toEqual(['urgente', 'casa']);
  });

  it('una fecha dentro de un token no se interpreta', () => {
    const t = one('tarea #mañana');
    expect(t.due_date).toBeNull();
    expect(t.project?.name).toBe('mañana');
  });
});

describe('recurrencia', () => {
  it.each([
    ['cada día', { freq: 'daily', interval: 1 }, '2026-10-05'],
    ['todos los días', { freq: 'daily', interval: 1 }, '2026-10-05'],
    ['cada 3 días', { freq: 'daily', interval: 3 }, '2026-10-05'],
    ['todos los lunes y jueves', { freq: 'weekly', interval: 1, weekdays: [1, 4] }, '2026-10-05'],
    ['cada martes, jueves y viernes', { freq: 'weekly', interval: 1, weekdays: [2, 4, 5] }, '2026-10-06'],
    ['cada día laborable', { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }, '2026-10-05'],
    ['cada semana', { freq: 'weekly', interval: 1, weekdays: [1] }, '2026-10-05'],
    ['cada mes', { freq: 'monthly', interval: 1, monthDay: 5 }, '2026-10-05'],
    ['el 20 de cada mes', { freq: 'monthly', interval: 1, monthDay: 20 }, '2026-10-20'],
  ])('%s', (phrase, rule, due) => {
    const t = one(`pagar ${phrase}`);
    expect(t.recurrence).toEqual(rule);
    expect(t.due_date).toBe(due);
    expect(t.title).toBe('pagar');
  });

  it('"cada mes" con fecha se ancla en esa fecha', () => {
    const t = one('pagar alquiler cada mes empezando el 15 oct');
    expect(t.recurrence).toEqual({ freq: 'monthly', interval: 1, monthDay: 15 });
    expect(t.due_date).toBe('2026-10-15');
  });

  it('"cada lunes" no se confunde con la fecha "el lunes"', () => {
    const t = one('revisar cada lunes');
    expect(t.tokens.map((x) => x.kind)).toEqual(['recurrence']);
  });
});

describe('varias tareas y casos límite', () => {
  it('texto vacío o solo separadores → ninguna tarea', () => {
    expect(parseCapture('', ctx)).toEqual([]);
    expect(parseCapture('   ', ctx)).toEqual([]);
    expect(parseCapture(' ; \n ;', ctx)).toEqual([]);
  });

  it('separa por saltos de línea (notas de reunión pegadas)', () => {
    const r = parseCapture('enviar acta @Diana\n\nrevisar presupuesto #caixa mañana\n', ctx);
    expect(r.map((t) => t.title)).toEqual(['enviar acta', 'revisar presupuesto']);
    expect(r[1].due_date).toBe('2026-10-06');
  });

  it('solo tokens → título vacío', () => {
    expect(one('mañana #caixa').title).toBe('');
  });

  it('los offsets de los tokens son relativos al texto completo', () => {
    const text = 'comprar café; renovar el DNI el viernes';
    const r = parseCapture(text, ctx);
    const tok = r[1].tokens[0];
    expect(text.slice(tok.start, tok.end)).toBe('el viernes');
  });

  it('la persona solo se queda en el título tras una preposición', () => {
    expect(one('revisar login @Diana').title).toBe('revisar login');
    expect(one('@Diana revisar login').title).toBe('revisar login');
    expect(one('hablar con @Diana del login').title).toBe('hablar con Diana del login');
  });

  it('un token descartado se queda en el título', () => {
    const ignore = [tokenKey({ kind: 'date', text: 'mañana' })];
    const t = one('llamar mañana a Luis', { ignore });
    expect(t.due_date).toBeNull();
    expect(t.title).toBe('llamar mañana a Luis');
  });

  it('descartar una recurrencia no la convierte en fecha', () => {
    const ignore = [tokenKey({ kind: 'recurrence', text: 'cada lunes' })];
    const t = one('revisar cada lunes', { ignore });
    expect(t.recurrence).toBeNull();
    expect(t.due_date).toBeNull();
  });
});

describe('claves externas y releases (fase 7)', () => {
  const ctx7: CaptureContext = {
    ...ctx,
    types: [{ id: 'task', short: '' }, { id: 'us', short: 'US' }, { id: 'ts', short: 'TS' }],
    releases: [{ id: 'r1', name: 'R2.3' }],
  };
  const one7 = (text: string) => parseCapture(text, ctx7)[0];

  it('US-1234 → User Story con ID externo, fuera del título', () => {
    const t = one7('US-1234 login con SSO #caixa');
    expect(t).toMatchObject({ external_id: 'US-1234', type_id: 'us', title: 'login con SSO' });
  });

  it('TS-55 → Test Scenario', () => {
    expect(one7('revisar TS-55 mañana')).toMatchObject({ external_id: 'TS-55', type_id: 'ts', due_date: '2026-10-06' });
  });

  it('F/FE → Feature y DE → Defect (tipos de Rally)', () => {
    const rally = { ...ctx7, types: [...ctx7.types!, { id: 'fe', short: 'FE' }, { id: 'de', short: 'DE' }] };
    expect(parseCapture('F12345 nueva home', rally)[0]).toMatchObject({ external_id: 'F12345', type_id: 'fe' });
    expect(parseCapture('FE-12 nueva home', rally)[0]).toMatchObject({ type_id: 'fe' });
    expect(parseCapture('DE998877 login roto', rally)[0]).toMatchObject({ type_id: 'de' });
  });

  it('otras claves se guardan sin cambiar el tipo', () => {
    expect(one7('mirar QA-17')).toMatchObject({ external_id: 'QA-17', type_id: null });
  });

  it('no confunde minúsculas ni palabras con guion', () => {
    expect(one7('protocolo covid-19 y us-12').external_id).toBeNull();
    expect(one7('el wi-fi del piso').external_id).toBeNull();
  });

  it('^release existente o nueva', () => {
    expect(one7('desplegar ^r2.3').release).toEqual({ id: 'r1', name: 'R2.3' });
    expect(one7('desplegar ^R3.0').release).toEqual({ id: null, name: 'R3.0' });
    expect(one7('desplegar ^R3.0').title).toBe('desplegar');
  });
});

describe('recordatorios (fase 9)', () => {
  // 5 oct 2026, 10:00 hora local.
  const now = new Date(2026, 9, 5, 10, 0);
  const r = (text: string) => parseCapture(text, { ...ctx, now })[0];
  const local = (iso: string | null) => {
    const d = new Date(iso!);
    return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  it('recuérdame a las 17:00 → hoy a las 17:00', () => {
    const t = r('recuérdame a las 17:00 llamar a Luis');
    expect(local(t.remind_at)).toBe('5/10 17:00');
    expect(t.title).toBe('llamar a Luis');
    expect(t.due_date).toBeNull();
  });

  it('si la hora ya pasó y no hay fecha, mañana', () => {
    expect(local(r('avísame a las 9 revisar TS').remind_at)).toBe('6/10 9:00');
  });

  it('con fecha, el aviso es ese día', () => {
    const t = r('el jueves preparar demo recuérdame a las 8.30');
    expect(t.due_date).toBe('2026-10-08');
    expect(local(t.remind_at)).toBe('8/10 8:30');
  });

  it('"a las 5" sin "recuérdame" sigue sin ser nada', () => {
    expect(r('llamar a las 5').remind_at).toBeNull();
  });

  it('horas imposibles se quedan como texto', () => {
    expect(r('recuérdame a las 27 algo').remind_at).toBeNull();
  });
});

describe('subproyectos en la captura (fase 10)', () => {
  const ctx10: CaptureContext = {
    ...ctx,
    projects: [
      { id: 'c', name: 'caixa', parent_id: null },
      { id: 's14', name: 'Sprint 14', parent_id: 'c' },
    ],
  };
  const p10 = (text: string) => parseCapture(text, ctx10)[0].project;

  it('#padre/hijo resuelve el subproyecto', () => {
    expect(p10('revisar #caixa/sprint-14')).toEqual({ id: 's14', name: 'Sprint 14' });
    expect(p10('revisar #sprint-14')).toEqual({ id: 's14', name: 'Sprint 14' });
  });

  it('#padre/nuevo propone un subproyecto nuevo', () => {
    expect(p10('revisar #caixa/sprint-15')).toEqual({ id: null, name: 'sprint 15', parent_id: 'c' });
    expect(p10('revisar #otro')).toEqual({ id: null, name: 'otro', parent_id: null });
  });

  it('reconoce los IDs de Rally sin guion y pone el tipo', () => {
    const types = [{ id: 'us', name: 'User Story', short: 'US', color: '', states: [], order: 1 }, { id: 'ts', name: 'Test Scenario', short: 'TS', color: '', states: [], order: 2 }];
    const us = parseCapture('US1764574 Alta Bizum', { ...ctx, types } as never)[0];
    expect(us).toMatchObject({ external_id: 'US1764574', type_id: 'us', title: 'Alta Bizum' });
    expect(parseCapture('TS92615 transferencias', { ...ctx, types } as never)[0]).toMatchObject({ external_id: 'TS92615', type_id: 'ts' });
    expect(parseCapture('revisar COVID19 y US12', { ...ctx, types } as never)[0].external_id).toBeNull();
  });
});
