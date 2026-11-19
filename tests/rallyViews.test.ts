import { describe, expect, it } from 'vitest';
import type { RallyItem } from '../src/domain/rally';
import { inRallyView, RALLY_VIEWS } from '../src/domain/rallyViews';

const item = (p: Partial<RallyItem>) => ({ name: '', tags: [], state: 'New', ready: false, ...p }) as RallyItem;
const view = (id: string) => RALLY_VIEWS.find((v) => v.id === id)!;

describe('vistas guardadas de Rally', () => {
  it('tienen los nombres de Rally', () => {
    expect(RALLY_VIEWS.map((v) => v.name)).toContain('12. US/ TS sin VS asignado');
    expect(new Set(RALLY_VIEWS.map((v) => v.id)).size).toBe(RALLY_VIEWS.length);
  });
  it('por etiqueta, sin distinguir mayúsculas; mismo campo = o', () => {
    expect(inRallyView(view('02'), item({ tags: ['pagos transaccionales'] }))).toBe(true);
    expect(inRallyView(view('02'), item({ tags: ['Seguros'] }))).toBe(false);
    // La 05 pide las dos etiquetas a la vez, como las dos filas del filtro de Rally.
    expect(inRallyView(view('05'), item({ tags: ['onboarding', 'ANA_etiquetado'] }))).toBe(true);
    expect(inRallyView(view('05'), item({ tags: ['ANA_etiquetado'] }))).toBe(false);
    expect(inRallyView(view('05'), item({ tags: ['Onboarding'] }))).toBe(false);
    expect(inRallyView(view('default'), item({}))).toBe(true);
  });
  it('sin VS: ninguna etiqueta de VS y ni Accepted ni Completed', () => {
    expect(inRallyView(view('12'), item({ tags: ['Otra'], state: 'Defined' }))).toBe(true);
    expect(inRallyView(view('12'), item({ tags: ['Seguros'], state: 'Defined' }))).toBe(false);
    expect(inRallyView(view('12'), item({ tags: [], state: 'Accepted' }))).toBe(false);
  });
  it('consultas, pendientes de validar y long tail (campos distintos = y)', () => {
    expect(inRallyView(view('11-consultas'), item({ tags: ['Consulta'], state: 'In-Progress' }))).toBe(true);
    expect(inRallyView(view('11-consultas'), item({ tags: ['Consulta'], state: 'Accepted' }))).toBe(false);
    expect(inRallyView(view('13'), item({ ready: true }))).toBe(true);
    expect(inRallyView(view('14'), item({ name: '[Miró Long Tail][APP]', tags: ['Longtail Etiquetado'] }))).toBe(true);
    expect(inRallyView(view('14'), item({ name: '[Miró LongTail][APP]', tags: [] }))).toBe(false);
  });
});
