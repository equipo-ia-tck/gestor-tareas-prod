import { describe, expect, it } from 'vitest';
import { editDistance, SearchIndex, type Chunk } from '../src/domain/knowledge';
import { pickContext } from '../src/domain/rag';

const doc = (id: string, ref: string, title: string, text: string, section?: string): Chunk => ({ id, source: 'doc', ref, title, section, text });

// Como en Confluence: una página larga de prioridades (una parte por fecha) y la tabla de responsables en inglés.
const chunks: Chunk[] = [
  ...Array.from({ length: 12 }, (_, i) => doc(`p${i}`, 'prioridades', 'Prioridades de equipo',
    `Onboarding: Camila y Fran con la analista de turno revisan Banksy (semana ${i + 1}).`, `${i + 1} jun 2025`)),
  doc('t', 'responsables', 'Equipo y responsables por VS',
    'Value Stream: Onboarding | Data Analyst: Carolina Gibert Codina | Owner: Alejandro Hipólito | Weekly: jueves 16:30'),
  doc('h', 'responsables', 'Equipo y responsables por VS', 'Value Stream: Hipotecas | Data Analyst: Carolina Gibert Codina'),
];

describe('Búsqueda: erratas, sinónimos y variedad de páginas', () => {
  it('distancia de edición con transposiciones', () => {
    expect(editDistance('onboardinf', 'onboarding')).toBe(1);
    expect(editDistance('analsita', 'analista')).toBe(1);
    expect(editDistance('owner', 'tower', 1)).toBe(2);
  });

  it('una errata busca la palabra que sí existe y «analista» encuentra «Data Analyst»', () => {
    const index = new SearchIndex(chunks);
    expect(index.expand('quien es la analista de onboardinf')).toEqual([['analista', 'analyst'], ['onboarding']]);
    const hits = index.search('quien es la analista de onboardinf', { limit: 5 });
    expect(hits[0].chunk.id).toBe('t');
    expect(index.search('owner de onboarding')[0].chunk.id).toBe('t');
    expect(index.search('responsable de onboarding')[0].chunk.id).toBe('t');
  });

  it('a la IA le llegan como mucho 3 partes de la misma página', () => {
    const ranked = [...chunks.slice(0, 12), chunks[12]];
    const picked = pickContext(ranked, 26000, 20);
    expect(picked.filter((s) => s.chunk.ref === 'prioridades')).toHaveLength(3);
    expect(picked.some((s) => s.chunk.id === 't')).toBe(true);
  });
});
