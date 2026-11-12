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
