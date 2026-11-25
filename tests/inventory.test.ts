import { describe, expect, it } from 'vitest';
import { inventory } from '../src/domain/inventory';
import type { Chunk } from '../src/domain/knowledge';

const doc = (id: string, title: string, text: string, section?: string): Chunk => ({ id, source: 'doc', ref: `https://wiki/${id}`, title, section, text });

const chunks: Chunk[] = [
  doc('a', 'Variables de Adobe', 'Variable: eVar69 | Uso: login del usuario | Ejemplo: ok\nVariable: eVar12 | Uso: idioma\nTexto suelto que habla de la evar69 otra vez', 'Tabla'),
  doc('b', 'Onboarding', 'En onboarding se rellenan la eVar 161 y la evar_12.\nTambién prop5.'),
  doc('c', 'Calendario', 'El evento 2026 se celebra en marzo.'),
  { id: 't', source: 'task', ref: 't1', title: 'Revisar eVar99', text: 'Revisar eVar99' },
];

describe('Asistente: lista exacta («dame las evar que hay»)', () => {
  it('saca cada evar una vez, por orden, con su mejor línea y dónde sale', () => {
    const inv = inventory(chunks, 'me puedes dar las evar que hay')!;
    expect(inv.term).toBe('evar');
    expect(inv.items.map((i) => i.id)).toEqual(['eVar12', 'eVar69', 'eVar161']);
    const v69 = inv.items.find((i) => i.num === 69)!;
    expect(v69.line).toBe('Variable: eVar69 | Uso: login del usuario | Ejemplo: ok'); // la fila de la tabla, no la frase suelta
    expect(v69.count).toBe(2);
    expect(v69.sources).toEqual([{ title: 'Variables de Adobe', section: 'Tabla', source: 'doc', ref: 'https://wiki/a' }]);
    expect(inv.items.find((i) => i.num === 12)!.sources.map((s) => s.title)).toEqual(['Variables de Adobe', 'Onboarding']);
    // Las tareas no cuentan (no son documentación).
    expect(inv.items.some((i) => i.num === 99)).toBe(false);
  });

  it('también en plural y con otras formas de pedirlo', () => {
    expect(inventory(chunks, '¿Qué evars tenemos?')?.items).toHaveLength(3);
    expect(inventory(chunks, 'lista de todas las eVar')?.items).toHaveLength(3);
  });

  it('«qué evar se usan para las cosas de onboarding»: solo las de donde se habla de onboarding', () => {
    const inv = inventory(chunks, 'que evar se usan para las cosas de onboarding')!;
    expect(inv.items.map((i) => i.id)).toEqual(['eVar12', 'eVar161']);
    expect(inv.about).toEqual(['onboarding']);
    expect(inv.items[0].sources.map((s) => s.title)).toEqual(['Onboarding']);
  });

  it('no salta con preguntas concretas ni sin una familia de identificadores', () => {
    expect(inventory(chunks, 'qué evar se usa para el login')).toBeNull();
    expect(inventory(chunks, 'cómo se entrega una guía')).toBeNull();
    expect(inventory(chunks, 'dame los props')).toBeNull(); // solo hay uno: no es una lista
    expect(inventory(chunks, 'qué eventos hay')).toBeNull(); // «evento 2026» suelto
  });
});
