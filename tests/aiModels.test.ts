import { describe, expect, it } from 'vitest';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { MODELS, modelLabel } from '../src/features/assistant/ai/engine';

describe('IA del Asistente: modelos que se pueden elegir', () => {
  it('los dos (normal y grande, f16 y f32) existen en WebLLM', () => {
    const ids = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
    for (const m of Object.values(MODELS)) {
      expect(ids.has(m.f16)).toBe(true);
      expect(ids.has(m.f32)).toBe(true);
    }
  });
  it('el nombre que se enseña sale del modelo cargado', () => {
    expect(modelLabel(MODELS.grande.f32)).toBe('Qwen2.5 7B');
    expect(modelLabel(MODELS.normal.f16)).toBe('Qwen2.5 3B');
  });
});
