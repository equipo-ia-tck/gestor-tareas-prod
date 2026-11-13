import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { TasksDB } from '../src/data/db';
import { DexieRepository } from '../src/data/repository';
import {
  actionItems, extractMentions, parseInline, parseMarkdown, plainLine, sectionOf, setChecked, setTaskMarker,
} from '../src/domain/markdown';
import { meetingTemplate, mentionsOf, noteExcerpt, noteLines, notesLinkingTask, projectLines } from '../src/domain/notes';
import type { Note, Project } from '../src/domain/types';

let repo: DexieRepository;
beforeEach(() => { repo = new DexieRepository(new TasksDB(`v4-${crypto.randomUUID()}`)); });

const note = (body: string, extra: Partial<Note> = {}): Note => ({
  id: crypto.randomUUID(), title: 'Daily', body, kind: 'meeting', date: '2026-10-07', project_id: null,
  people: extractMentions(body), pinned: false, task_id: null, meeting_url: null, sort_order: null, created_at: '', updated_at: '', deleted_at: null, ...extra,
});

describe('markdown', () => {
  it('bloques', () => {
    const b = parseMarkdown('# Título\n- uno\n- [ ] acción\n- [x] hecha [[t:abc]]\n1. primero\n> cita\n---\n\ntexto');
    expect(b.map((x) => x.type)).toEqual(['heading', 'bullet', 'task', 'task', 'ordered', 'quote', 'hr', 'blank', 'paragraph']);
    expect(b[3]).toMatchObject({ checked: true, taskId: 'abc' });
  });

  it('inlines: negrita, cursiva, código, enlaces, menciones, proyectos y claves', () => {
    const types = parseInline('**ojo** _ya_ `x` [doc](https://a.test/d) https://b.test @Diana #caixa US-12').map((i) => i.type);
    expect(types.filter((t) => t !== 'text')).toEqual(['bold', 'italic', 'code', 'link', 'link', 'mention', 'project', 'key']);
  });

  it('no confunde emails con menciones', () => {
    expect(extractMentions('escribe a ana@correo.com y a @Luis')).toEqual(['Luis']);
  });

  it('menciones sin duplicados y con guiones como espacios', () => {
    expect(extractMentions('@Diana dijo… @diana otra vez; @Ana-María')).toEqual(['Diana', 'Ana María']);
  });

  it('acciones, marcador de tarea y casillas', () => {
    let text = '## Acciones\n- [ ] enviar acta @Diana\n- [x] revisar\n- [ ] ';
    expect(actionItems(text)).toEqual([
      { line: 1, text: 'enviar acta @Diana', checked: false, taskId: null },
      { line: 2, text: 'revisar', checked: true, taskId: null },
    ]);
    text = setTaskMarker(text, 1, 't1');
    expect(text.split('\n')[1]).toBe('- [ ] enviar acta @Diana [[t:t1]]');
    expect(actionItems(text)[0].taskId).toBe('t1');
    text = setChecked(text, 1, true);
    expect(text.split('\n')[1]).toBe('- [x] enviar acta @Diana [[t:t1]]');
  });

  it('sección y texto plano', () => {
    const text = '## Decisiones\n- **login** va en `R2.3`';
    expect(sectionOf(text, 1)).toBe('Decisiones');
    expect(plainLine(text.split('\n')[1])).toBe('login va en R2.3');
  });
});

describe('notas', () => {
  it('quién dijo qué: menciones con su sección, sin la línea de asistentes', () => {
    const a = note(`${meetingTemplate(['Diana', 'Luis'])}\n`.replace('## Decisiones\n- ', '## Decisiones\n- @Diana: el login va en la R2.3'));
    const b = note('- @diana pide revisar los TS\n- @Luis nada', { date: '2026-10-09' });
    const m = mentionsOf('Diana', [a, b]);
    expect(m.map((x) => [x.note.date, x.text, x.section])).toEqual([
      ['2026-10-09', '@diana pide revisar los TS', null],
      ['2026-10-07', '@Diana: el login va en la R2.3', 'Decisiones'],
    ]);
  });

  it('líneas con #proyecto y @persona: van a su proyecto (y subproyectos) y recuerdan su tarea', () => {
    const proj = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id }) as Project;
    const projects = [proj('c', 'Caixa'), proj('s', 'Sprint 14', 'c'), proj('o', 'Otro')];
    const a = note('**Asistentes:** @Diana\n## Notas\n- #caixa revisar el login con @Diana\n- #sprint-14 demo el lunes [[t:t1]]\n- #nada sin proyecto\n- #caixa\n- ## título', { date: '2026-10-09' });
    const b = note('- @Luis lleva las pruebas\n- texto sin menciones', { project_id: 'c' });
    const c = note('- @Luis en otra parte', { project_id: 'o' });
    const all = noteLines([a, b, c], projects);
    expect(all.map((l) => [l.text, l.people, l.projectIds, l.taskId, l.section])).toEqual([
      ['#caixa revisar el login con @Diana', ['Diana'], ['c'], null, 'Notas'],
      ['#sprint-14 demo el lunes', [], ['s'], 't1', 'Notas'],
      ['@Luis lleva las pruebas', ['Luis'], [], null, null],
      ['@Luis en otra parte', ['Luis'], [], null, null],
    ]);
    expect(projectLines(new Set(['c', 's']), [a, b, c], projects).map((l) => l.text))
      .toEqual(['#caixa revisar el login con @Diana', '#sprint-14 demo el lunes', '@Luis lleva las pruebas']);
    expect(projectLines(new Set(['s']), [a, b, c], projects).map((l) => l.text)).toEqual(['#sprint-14 demo el lunes']);
  });

  it('notas que enlazan una tarea y resumen', () => {
    const a = note('- [ ] x [[t:t9]]');
    expect(notesLinkingTask('t9', [a, note('nada')])).toEqual([a]);
    expect(noteExcerpt(note('**Asistentes:** @A\n## Contexto\nArrancamos el sprint'))).toBe('Arrancamos el sprint');
  });

  it('repositorio: crear, guardar en silencio, deshacer y eliminar', async () => {
    const events: string[] = [];
    repo.onHistory((e) => events.push(`${e.type}:${e.entry.label}:${e.entry.silent ? 's' : ''}`));
    const n = await repo.createNote({ date: '2026-10-07', kind: 'meeting', title: 'Daily', body: meetingTemplate(['Diana']) });
    expect(n.people).toEqual(['Diana']);
    await repo.updateNote(n.id, { body: 'hablado con @Luis' }, { silent: true });
    expect((await repo.getNote(n.id))?.people).toEqual(['Luis']);
    expect(events).toEqual(['push:Acta creada:', 'push:Nota guardada:s']);
    await repo.undo();
    expect((await repo.getNote(n.id))?.people).toEqual(['Diana']);
    await repo.deleteNote(n.id);
    expect(await repo.listNotes()).toHaveLength(0);
    await repo.undo();
    expect(await repo.listNotes()).toHaveLength(1);
  });

  it('fichas de persona', async () => {
    await repo.savePerson({ name: 'Diana', role: 'PO', notes: '', email: '' });
    await repo.savePerson({ name: 'diana', role: 'Product Owner', notes: 'Prefiere Teams', email: 'diana@empresa.com' });
    expect(await repo.listPeople()).toEqual([{ name: 'Diana', role: 'Product Owner', notes: 'Prefiere Teams', email: 'diana@empresa.com' }]);
  });

  it('migración v3 → v4 añade el tipo Tema', async () => {
    const name = `mig4-${crypto.randomUUID()}`;
    const v3 = new Dexie(name);
    v3.version(3).stores({ projects: 'id', tasks: 'id', settings: 'key', meta: 'key', labels: 'name', item_types: 'id', releases: 'id' });
    await v3.table('item_types').add({ id: 'task', name: 'Tarea', short: '', color: '#000', order: 0, states: [{ id: 'task-todo', name: 'x', color: '#000', category: 'todo' }] });
    v3.close();
    const db = new TasksDB(name);
    expect((await db.item_types.toArray()).map((t) => t.id).sort()).toEqual(['task', 'topic']);
    expect(await db.notes.count()).toBe(0);
  });
});

describe('páginas (orden manual)', () => {
  it('ordena por sort_order y, sin él, por creación; reordenar devuelve solo los cambios', async () => {
    const { reorderPages, sortPages } = await import('../src/domain/notes');
    const a = note('', { id: 'a', sort_order: 1000, created_at: '2026-10-01' });
    const b = note('', { id: 'b', sort_order: 2000, created_at: '2026-10-02' });
    const c = note('', { id: 'c', sort_order: null, created_at: '2026-01-01T00:00:00Z' });
    expect(sortPages([b, a]).map((n) => n.id)).toEqual(['a', 'b']);
    expect(reorderPages([a, b], 'b', 'a')).toEqual([{ id: 'b', sort_order: 1000 }, { id: 'a', sort_order: 2000 }]);
    expect(reorderPages([a, b], 'a', null)).toEqual([{ id: 'b', sort_order: 1000 }, { id: 'a', sort_order: 2000 }]);
    expect(sortPages([a, c]).map((n) => n.id)).toEqual(['a', 'c']);
  });
});

describe('enlace de acción en cualquier posición', () => {
  it('se reconoce aunque se escriba detrás', () => {
    const text = '- [ ] enviar acta [[t:t1]] a Diana';
    expect(actionItems(text)[0]).toMatchObject({ text: 'enviar acta a Diana', taskId: 't1' });
    expect(setTaskMarker(text, 0, 't2')).toBe('- [ ] enviar acta a Diana [[t:t2]]');
    expect(plainLine(text)).toBe('enviar acta a Diana');
  });
});
