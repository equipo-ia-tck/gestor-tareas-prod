import { describe, expect, it } from 'vitest';
import { blockedText, commentShape, TS_MOVE_COMMENTS, unreadyText } from '../src/domain/rallyComments';

describe('comentarios de Rally: US y TS', () => {
  it('las US van siempre al Owner, sin opcionales', () => {
    for (const step of ['defined', 'doing', 'blocked', 'done', 'accepted', 'unready'] as const) {
      expect(commentShape('US', step)).toEqual({ addressee: 'owner', optional: false, analystExpected: false, ccEveryone: false });
    }
    expect(unreadyText('US')).toBe('Tengo la guía validada por si la quieres revisar antes de la reunión con PO y PO IT');
    expect(blockedText('US')).toBe('Guía bloqueada');
  });

  it('los TS: Completed y quitar Ready, opcional y para el analista; Need Review para el PO IT; Accepted con todos', () => {
    expect(commentShape('TS', 'done')).toMatchObject({ addressee: 'analyst', optional: true });
    expect(commentShape('TS', 'unready')).toEqual(commentShape('TS', 'done'));
    expect(unreadyText('TS')).toBe(TS_MOVE_COMMENTS.done);
    expect(commentShape('TS', 'need-review')).toMatchObject({ addressee: 'po-it', analystExpected: true, optional: false });
    expect(commentShape('TS', 'accepted')).toMatchObject({ addressee: 'owner', ccEveryone: true });
    expect(commentShape('TS', 'doing')).toMatchObject({ addressee: 'owner', optional: false });
    expect(blockedText('TS')).toBe('TS bloqueada');
  });
});
