import { describe, expect, it } from 'vitest';
import type { Chunk } from '../src/domain/knowledge';
import { buildMessages, chunkKey, citedSources, cosine, fuseRanks, hashText, isNotFound, NOT_FOUND, pickContext, splitCitations } from '../src/domain/rag';

const chunk = (id: string, text: string, extra: Partial<Chunk> = {}): Chunk => ({ id, source: 'doc', ref: id, title: `Doc ${id}`, text, ...extra });

describe('rag', () => {
  it('hashText y chunkKey cambian si cambia el texto', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(chunkKey(chunk('a', 'uno'))).not.toBe(chunkKey(chunk('a', 'dos')));
  });

  it('cosine de vectores normalizados', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('fuseRanks premia lo que sale arriba en las dos listas', () => {
    expect(fuseRanks([['a', 'b', 'c'], ['b', 'c', 'a']])[0]).toBe('b');
    expect(fuseRanks([['a'], ['z']])).toEqual(['a', 'z']);
  });

  it('pickContext numera, quita repetidos y vacíos y respeta el presupuesto', () => {
    const long = 'x'.repeat(3000);
    const picked = pickContext([chunk('a', 'La eVar69 es para el login.'), chunk('a', 'repetido'), chunk('p', '', { source: 'project', title: 'P' }), chunk('b', long), chunk('c', long), chunk('d', long), chunk('e', long), chunk('f', long)]);
    expect(picked.map((s) => s.n)).toEqual(picked.map((_, i) => i + 1));
    expect(picked[0].chunk.id).toBe('a');
    expect(picked.some((s) => s.chunk.id === 'p')).toBe(false);
    expect(picked.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(6500);
    expect(picked[1].text.length).toBeLessThanOrEqual(1601);
  });

  it('buildMessages lleva las fuentes numeradas y la pregunta', () => {
    const [system, , , user] = buildMessages('¿Qué evar uso para el login?', pickContext([chunk('a', 'La eVar69 es para el login.')]), '2026-11-24');
    expect(system.content).toContain(NOT_FOUND);
    expect(user.content).toContain('[1] (Documento) Doc a\nLa eVar69 es para el login.');
    expect(user.content).toContain('PREGUNTA: ¿Qué evar uso para el login?');
  });

  it('splitCitations y citedSources leen [1], [1, 2] y [1][3] e ignoran las que no existen', () => {
    expect(splitCitations('Usa la eVar69 [1]. También [2, 3] y [9].', 3)).toEqual(['Usa la eVar69 ', 1, '. También ', 2, 3, ' y [9].']);
    expect(citedSources('a [2][1] b [2]', 3)).toEqual([2, 1]);
  });

  it('isNotFound', () => {
    expect(isNotFound(`«${NOT_FOUND}»`)).toBe(true);
    expect(isNotFound('La eVar69 [1].')).toBe(false);
  });
});

describe('Preguntar a Claude', () => {
  it('el enlace lleva la pregunta y la indicación de usar el conector de Marea', async () => {
    const { claudePrompt, claudeUrl } = await import('../src/features/assistant/askClaude');
    expect(claudePrompt('  ¿Qué evar uso para el login? ')).toMatch(/conector de Marea[\s\S]*Pregunta: ¿Qué evar uso para el login\?$/);
    const url = new URL(claudeUrl('¿Qué evar?'));
    expect(url.origin + url.pathname).toBe('https://claude.ai/new');
    expect(url.searchParams.get('q')).toContain('Pregunta: ¿Qué evar?');
  });

  it('con id, pide guardar la respuesta en Marea; los ids valen para la migración 015', async () => {
    const { claudePrompt, newRequestId } = await import('../src/features/assistant/askClaude');
    const id = newRequestId();
    expect(id).toMatch(/^[a-z0-9-]{6,64}$/);
    expect(newRequestId()).not.toBe(id);
    expect(claudePrompt('¿PO?', id)).toContain(`«responder_en_marea» (id de Marea: ${id})`);
    expect(claudePrompt('¿PO?')).not.toContain('responder_en_marea');
  });
});
