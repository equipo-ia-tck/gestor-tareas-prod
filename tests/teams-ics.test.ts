import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/domain/ics';
import { notesByTask, notesForTask } from '../src/domain/notes';
import { findTeamsLink, meetingContacts, meetingSummary, teamsAppUrl, teamsChatUrl, teamsMeetingUrl, teamsWebUrl } from '../src/domain/teams';
import type { Note } from '../src/domain/types';
import { makeTask } from './factories';

const note = (extra: Partial<Note>): Note => ({
  id: crypto.randomUUID(), title: 'Daily', body: '', kind: 'meeting', date: '2026-10-07', project_id: null, people: [],
  pinned: false, task_id: null, meeting_url: null, sort_order: null, created_at: '2026-10-07T09:00:00Z', updated_at: '', deleted_at: null, ...extra,
});

describe('notas de elementos', () => {
  it('por elemento, las más recientes primero; grupos por la nota más reciente', () => {
    const a1 = note({ task_id: 'a', date: '2026-10-01' });
    const a2 = note({ task_id: 'a', date: '2026-10-05' });
    const b1 = note({ task_id: 'b', date: '2026-10-06' });
    const other = note({ task_id: 'c', date: '2026-10-07' });
    const gone = note({ task_id: 'a', deleted_at: 'x' });
    expect(notesForTask('a', [a1, a2, gone]).map((n) => n.date)).toEqual(['2026-10-05', '2026-10-01']);
    expect(notesByTask(new Set(['a', 'b']), [a1, a2, b1, other]).map((g) => [g.taskId, g.notes.length])).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('Teams', () => {
  const body = `**Asistentes:** @Diana @Luis

## Decisiones
- @Diana: el **login** va en la R2.3

## Acciones
- [ ] enviar resumen a @Diana [[t:t1]]
- [x] actualizar tablero`;

  it('resumen del acta con decisiones y acciones (estado de la tarea enlazada)', () => {
    const tasks = new Map([['t1', makeTask({ id: 't1', status: 'done', due_date: '2026-10-08' })]]);
    expect(meetingSummary(note({ title: 'Revisión sprint', body, people: ['Diana', 'Luis'] }), tasks)).toBe([
      'Revisión sprint · 07/10/2026',
      'Asistentes: Diana, Luis',
      '',
      'Decisiones:',
      '• Diana: el login va en la R2.3',
      '',
      'Acciones:',
      '☑ enviar resumen a Diana (08/10)',
      '☑ actualizar tablero',
    ].join('\n'));
  });

  it('enlace de chat con varias personas, tema y mensaje', () => {
    const url = teamsChatUrl(['diana@empresa.com', ' luis@empresa.com', 'no-es-email'], 'Revisión', 'Hola');
    expect(url).toBe('https://teams.microsoft.com/l/chat/0/0?users=diana%40empresa.com%2Cluis%40empresa.com&topicName=Revisi%C3%B3n&message=Hola');
    expect(teamsChatUrl(['no-es-email'])).toBeNull();
  });

  it('encuentra el enlace de reunión de Teams en un texto', () => {
    expect(findTeamsLink('Unirse: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x <fin>'))
      .toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x');
    expect(findTeamsLink('sin enlace')).toBeNull();
  });
});

describe('archivo .ics', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a1',
    'SUMMARY:Revisión sprint 14',
    'DTSTART;TZID=Romance Standard Time:20261008T100000',
    'ORGANIZER;CN="Diana Pérez":mailto:diana@empresa.com',
    'ATTENDEE;ROLE=REQ-PARTICIPANT;CN=Luis Gómez:mailto:luis@empresa.com',
    'DESCRIPTION:Únete: https://teams.microsoft.com/l/meetup-join/19%3a',
    ' meeting_xyz%40thread.v2/0\\nAgenda\\, temas',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:daily',
    'SUMMARY:Daily QA',
    'DTSTART:20261005T070000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
    'EXDATE:20261009T070000Z',
    'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/daily',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c',
    'SUMMARY:Cancelada',
    'STATUS:CANCELLED',
    'DTSTART;VALUE=DATE:20261008',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:old',
    'SUMMARY:Antigua',
    'DTSTART;VALUE=DATE:20250101',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcs(ics, '2026-10-01', '2026-10-31');

  it('lee título, fecha, hora, asistentes y enlace de Teams (con líneas plegadas)', () => {
    const e = events.find((x) => x.uid === 'a1')!;
    expect(e).toMatchObject({ title: 'Revisión sprint 14', date: '2026-10-08', time: '10:00' });
    expect(e.attendees).toEqual([{ name: 'Diana Pérez', email: 'diana@empresa.com' }, { name: 'Luis Gómez', email: 'luis@empresa.com' }]);
    expect(e.url).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz%40thread.v2/0');
    expect(e.description).toContain('Agenda, temas');
  });

  it('expande las recurrentes en la ventana y respeta EXDATE y COUNT', () => {
    const daily = events.filter((x) => x.uid === 'daily').map((x) => x.date);
    expect(daily).toEqual(['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14', '2026-10-16']);
    expect(events.find((x) => x.uid === 'daily')!.time).toBe('09:00'); // 07:00 UTC = 09:00 en Madrid (horario de verano)
  });

  it('ignora canceladas y eventos fuera de la ventana', () => {
    expect(events.map((x) => x.title)).not.toContain('Cancelada');
    expect(events.map((x) => x.title)).not.toContain('Antigua');
  });
});

describe('reunión nueva en Teams', () => {
  it('enlace con título, inicio y fin con zona horaria, asistentes válidos y descripción', () => {
    const url = new URL(teamsMeetingUrl({ title: 'Revisión', date: '2026-10-29', time: '10:30', minutes: 45, attendees: ['ana@empresa.com', 'no-es-email'], content: 'Agenda' }));
    expect(url.origin + url.pathname).toBe('https://teams.microsoft.com/l/meeting/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      subject: 'Revisión', startTime: '2026-10-29T10:30:00+01:00', endTime: '2026-10-29T11:15:00+01:00', attendees: 'ana@empresa.com', content: 'Agenda',
    });
    // En verano, +02:00.
    expect(new URL(teamsMeetingUrl({ title: '', date: '2026-07-01', time: '09:00', minutes: 30, attendees: [] })).searchParams.get('startTime')).toBe('2026-07-01T09:00:00+02:00');
  });

  it('contactos de las reuniones y las fichas, por frecuencia y sin repetir email', () => {
    const meetings = [
      { attendees: [{ name: 'Ana López', email: 'ana@empresa.com' }, { name: 'Luis', email: 'luis@empresa.com' }] },
      { attendees: [{ name: 'Ana', email: 'ANA@empresa.com' }, { name: 'Sala 3', email: 'sala' }] },
    ];
    expect(meetingContacts(meetings, [{ name: 'Diana', email: 'diana@empresa.com' }, { name: 'Sin email' }]).map((c) => c.email))
      .toEqual(['ana@empresa.com', 'luis@empresa.com', 'diana@empresa.com']);
  });
});

it('los enlaces de teams.microsoft.com se abren en la app (msteams:)', () => {
  expect(teamsAppUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d')).toBe('msteams:/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d');
  expect(teamsAppUrl('https://teams.live.com/meet/123')).toBe('https://teams.live.com/meet/123');
});

it('teamsWebUrl: abre la reunión en Teams web sin lanzar la app', () => {
  const join = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d';
  const web = new URL(teamsWebUrl(join));
  expect(web.origin + web.pathname).toBe('https://teams.microsoft.com/dl/launcher/launcher.html');
  expect(web.searchParams.get('url')).toBe('/_#/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d');
  expect(web.searchParams.get('msLaunch')).toBe('false');
  expect(web.searchParams.get('suppressPrompt')).toBe('true');
  expect(web.searchParams.get('type')).toBe('meetup-join');
  const short = new URL(teamsWebUrl('https://teams.microsoft.com/meet/3477372698?p=AbCdEf'));
  expect(short.searchParams.get('url')).toBe('/_#/meet/3477372698?p=AbCdEf');
  expect(short.searchParams.get('type')).toBe('meet');
  expect(short.searchParams.get('msLaunch')).toBe('false');
  expect(teamsWebUrl('https://teams.live.com/meet/123')).toBe('https://teams.live.com/meet/123');
  expect(teamsWebUrl('https://zoom.us/j/1')).toBe('https://zoom.us/j/1');
});
