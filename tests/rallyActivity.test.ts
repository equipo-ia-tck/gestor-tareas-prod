import { describe, expect, it } from 'vitest';
import { artifactHash, matchTool, summarizeActivity, type RallyChange, type ToolEvent } from '../src/domain/rallyActivity';

const ch = (kind: RallyChange['kind'], artifact: string, at: string, user = 'Ana'): RallyChange => ({ kind, artifact, user, at });

describe('Rally: herramienta o Rally', () => {
  it('huella estable y sin distinguir mayúsculas', async () => {
    const h = await artifactHash('US123');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(await artifactHash(' us123 ')).toBe(h);
    expect(await artifactHash('US124')).not.toBe(h);
  });

  it('cruza por tipo, elemento y hora; cada apunte vale una vez por tipo', () => {
    const changes = [
      ch('flow', 'US1', '2026-11-17T10:00:30Z'), // movimiento desde la herramienta…
      ch('blocked', 'US1', '2026-11-17T10:00:30Z'), // …que también bloquea
      ch('flow', 'US1', '2026-11-17T10:02:00Z'), // otro movimiento en Rally poco después
      ch('comment', 'US1', '2026-11-17T10:01:00Z'),
      ch('comment', 'US2', '2026-11-17T10:01:00Z'), // otro elemento
      ch('attachment', 'US1', '2026-11-17T12:00:00Z'), // fuera de la ventana
    ];
    const hashes = changes.map((c) => c.artifact);
    const tool: ToolEvent[] = [
      { kind: 'change', hash: 'US1', at: '2026-11-17T10:00:31Z' },
      { kind: 'comment', hash: 'US1', at: '2026-11-17T10:01:01Z' },
      { kind: 'attachment', hash: 'US1', at: '2026-11-17T10:00:00Z' },
    ];
    expect(matchTool(changes, hashes, tool)).toEqual([true, true, false, true, false, false]);
  });

  it('resume por tipo, persona y semana, sin contar lo de antes de medir', () => {
    const changes = [
      ch('flow', 'US1', '2026-11-10T09:00:00Z', 'Ana'),
      ch('flow', 'US2', '2026-11-17T09:00:00Z', 'Ana'),
      ch('comment', 'US2', '2026-11-18T09:00:00Z', 'Luis'),
      ch('comment', 'US3', '2026-11-18T09:30:00Z', 'Luis'),
    ];
    const s = summarizeActivity(changes, [false, true, false, true], '2026-11-12T00:00:00Z', true);
    expect(s.before).toBe(1);
    expect(s.total).toEqual({ tool: 2, rally: 1 });
    expect(s.byKind.find((k) => k.kind === 'comment')).toMatchObject({ tool: 1, rally: 1 });
    expect(s.byPerson).toEqual([{ user: 'Luis', tool: 1, rally: 1 }, { user: 'Ana', tool: 1, rally: 0 }]);
    expect(s.byWeek).toEqual([{ week: '2026-11-16', tool: 2, rally: 1 }]);
    // Sin `onlySince` cuenta todo (y dice cuántos son de antes).
    const all = summarizeActivity(changes, [false, true, false, true], '2026-11-12T00:00:00Z');
    expect(all.total).toEqual({ tool: 2, rally: 2 });
    expect(all.before).toBe(1);
    expect(summarizeActivity(changes, [true, true, true, true], null).before).toBe(4);
  });

  it('el primer apunte no deja fuera su propio cambio (Rally guarda la hora un poco antes)', () => {
    const changes = [ch('ready', 'US1', '2026-11-18T15:41:38Z')];
    const s = summarizeActivity(changes, [true], '2026-11-18T15:41:39Z', true);
    expect(s).toMatchObject({ before: 0, total: { tool: 1, rally: 0 } });
  });
});
