import { describe, expect, it } from 'vitest';
import { describeListaView, isSameListaView, saveListaView, type ListaViewState } from '../src/domain/msListView';
import { settingsSchema } from '../src/domain/schemas';

const base: ListaViewState = { viewId: '', filters: {}, groupBy: null, sort: null, hideDone: true, q: '' };
const matias: ListaViewState = { ...base, filters: { 'Líder técnico': { values: ['Matías Rodríguez'] } }, groupBy: 'Estado' };

describe('Lista: vistas guardadas', () => {
  it('reconoce la vista activa aunque los filtros vengan en otro orden o con columnas vacías', () => {
    expect(isSameListaView(matias, { ...matias, filters: { Estado: { values: [] }, 'Líder técnico': { values: ['Matías Rodríguez'] } } })).toBe(true);
    expect(isSameListaView(matias, { ...matias, groupBy: null })).toBe(false);
    expect(isSameListaView(matias, { ...matias, q: '  ' })).toBe(true);
  });

  it('guardar con el mismo nombre la sustituye (sin mayúsculas ni tildes); con otro, la añade', () => {
    let list = saveListaView([], 'Vista Matías', matias, 'a');
    expect(list).toHaveLength(1);
    list = saveListaView(list, 'vista matias', { ...matias, hideDone: false }, 'b');
    expect(list).toEqual([expect.objectContaining({ id: 'a', name: 'vista matias', hideDone: false })]);
    list = saveListaView(list, 'Bloqueados', { ...base, filters: { Estado: { values: ['dependencia'] } } }, 'c');
    expect(list.map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('describe la vista para el título del botón', () => {
    expect(describeListaView({ ...matias, viewId: 'v1', sort: { column: 'ID', dir: 'desc' } }, [{ id: 'v1', title: 'Activos' }]))
      .toBe('vista «Activos» · Líder técnico: Matías Rodríguez · agrupado por Estado · orden ID ↓');
    expect(describeListaView(base, [])).toBe('Sin filtros');
  });

  it('los ajustes de antes (sin vistas) se siguen leyendo', () => {
    expect(settingsSchema.parse({}).lista_views).toEqual([]);
    const [v] = settingsSchema.parse({ lista_views: [{ id: 'a', name: 'Vista Matías', filters: { 'Líder técnico': { values: ['Matías'] } } }] }).lista_views;
    expect(v).toMatchObject({ viewId: '', groupBy: null, sort: null, hideDone: true, q: '' });
  });
});
