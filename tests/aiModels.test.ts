import { describe, expect, it } from 'vitest';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { MODELS, modelLabel, withoutThinking } from '../src/features/assistant/ai/engine';
import { pickContext } from '../src/domain/rag';

describe('IA del Asistente: modelos que se pueden elegir', () => {
  it('los dos (normal y grande, f16 y f32) existen en WebLLM', () => {
    const ids = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
    for (const m of Object.values(MODELS)) {
      expect(ids.has(m.f16)).toBe(true);
      expect(ids.has(m.f32)).toBe(true);
    }
  });
  it('el nombre que se enseña sale del modelo cargado', () => {
    expect(modelLabel(MODELS.grande.f32)).toBe('Qwen3.5 9B');
    expect(modelLabel(MODELS.normal.f16)).toBe('Qwen2.5 3B');
  });

  it('el grande lee más documentación y no «piensa en voz alta»', () => {
    expect(MODELS.grande.context).toBeGreaterThan(MODELS.normal.context);
    const chunks = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, source: 'doc' as const, ref: `r${i}`, title: `Doc ${i}`, text: 'x'.repeat(900) }));
    expect(pickContext(chunks, MODELS.normal.budget.chars, MODELS.normal.budget.sources).length).toBeLessThanOrEqual(8);
    expect(pickContext(chunks, MODELS.grande.budget.chars, MODELS.grande.budget.sources)).toHaveLength(20);
    // El texto del prompt cabe en la ventana (unos 3 caracteres por token, más la respuesta).
    expect(MODELS.grande.budget.chars / 3 + MODELS.grande.budget.maxTokens + 1500).toBeLessThan(MODELS.grande.context);
    expect(withoutThinking('<think>\nmmm\n</think>\n\nLa eVar69 [1]')).toBe('La eVar69 [1]');
    expect(withoutThinking('<think>aún pensando')).toBe('');
    expect(withoutThinking('Sin pensar')).toBe('Sin pensar');
  });
});
