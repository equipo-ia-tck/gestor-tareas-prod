import { describe, expect, it } from 'vitest';
import { DEFAULT_ITEM_TYPES, stateForCategory } from '../src/domain/workflows';

describe('stateForCategory (columnas del tablero para cada tipo)', () => {
  const type = (id: string) => DEFAULT_ITEM_TYPES.find((t) => t.id === id)!;
  it('usa el primer estado de esa categoría', () => {
    const us = type('us');
    expect(stateForCategory(us, 'doing').name).toBe('En desarrollo');
    expect(stateForCategory(us, 'blocked').category).toBe('blocked');
  });
  it('si el tipo no la tiene (Para hablar), cae en su pendiente o su hecho', () => {
    const topic = DEFAULT_ITEM_TYPES.find((t) => t.states.some((s) => s.name === 'Hablado'))!;
    expect(stateForCategory(topic, 'blocked').name).toBe('Pendiente');
    expect(stateForCategory(topic, 'doing').name).toBe('Pendiente');
    expect(stateForCategory(topic, 'accepted').name).toBe('Hablado');
  });
});

describe('Mi día con temas para hablar', async () => {
  const { inMyDay } = await import('../src/domain/selectors');
  const { makeTask } = await import('./factories');
  const { TOPIC_TYPE_ID } = await import('../src/domain/types');
  it('los temas pendientes están siempre; las tareas, solo si se añadieron hoy', () => {
    const today = '2026-11-12';
    expect(inMyDay(makeTask({ type_id: TOPIC_TYPE_ID }), today)).toBe(true);
    expect(inMyDay(makeTask({ type_id: TOPIC_TYPE_ID, status: 'done' }), today)).toBe(false);
    expect(inMyDay(makeTask({}), today)).toBe(false);
    expect(inMyDay(makeTask({ my_day: today }), today)).toBe(true);
    expect(inMyDay(makeTask({ my_day: '2026-11-11' }), today)).toBe(false);
  });
});
