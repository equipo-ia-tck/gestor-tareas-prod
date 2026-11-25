import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Api } from './fakeAccounts.ts';
import { Calendar, findGestorFile, normalizeIcsUrl, oneDriveDirs } from '../servidor/calendar.ts';
import { parseIcs } from '../src/domain/ics';
import { nameFromEmail, outlookToCalendar, trimOutlookEvents } from '../src/domain/outlookEvents';

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Daily', 'DTSTART:20261029T080000Z', 'DTEND:20261029T081500Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function setup(body = ICS, status = 200, file: string | null = null) {
  const db = new DatabaseSync(':memory:');
  const api = new Api(db);
  const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
  const calls: string[] = [];
  const fetcher = (async (url: string) => { calls.push(url); return new Response(body, { status }); }) as unknown as typeof fetch;
  const luis = api.register({ login: 'luis@vml.com', name: 'Luis', password: 'contraseña-larga', code: api.teamCode }).user;
  return { calendar: new Calendar(db, fetcher, () => file), marta, luis, calls, db };
}

describe('calendario de Outlook (enlace ICS)', () => {
  it('valida el enlace: https público, webcal se trata como https', () => {
    expect(normalizeIcsUrl('webcal://outlook.office365.com/owa/calendar/a/b/calendar.ics')).toBe('https://outlook.office365.com/owa/calendar/a/b/calendar.ics');
    expect(() => normalizeIcsUrl('http://outlook.office365.com/x.ics')).toThrow(/https/);
    expect(() => normalizeIcsUrl('https://127.0.0.1/x.ics')).toThrow(/no es/);
    expect(() => normalizeIcsUrl('https://localhost/x.ics')).toThrow(/no es/);
    expect(() => normalizeIcsUrl('no es un enlace')).toThrow(/completo/);
  });

  it('conecta, guarda en caché, refresca y desconecta sin devolver el enlace', async () => {
    const { calendar, marta, calls } = setup();
    expect(calendar.status(marta)).toEqual({ connected: false, host: null, file: { linked: false, found: false } });
    await expect(calendar.ics(marta)).rejects.toThrow(/Conecta/);
    expect(await calendar.connect(marta, { url: 'https://outlook.office365.com/owa/calendar/a/b/calendar.ics' }))
      .toMatchObject({ connected: true, host: 'outlook.office365.com' });
    expect(await calendar.ics(marta)).toBe(ICS);
    expect(calls).toHaveLength(1); // de la caché
    await calendar.ics(marta, true);
    expect(calls).toHaveLength(2);
    calendar.disconnect(marta);
    expect(calendar.status(marta).connected).toBe(false);
  });

  it('rechaza lo que no es un calendario y los enlaces caducados', async () => {
    await expect(setup('<html></html>').calendar.connect(setup().marta, { url: 'https://outlook.office365.com/x/calendar.html' })).rejects.toThrow(/ICS/);
    const gone = setup('', 404);
    await expect(gone.calendar.connect(gone.marta, { url: 'https://outlook.office365.com/x/calendar.ics' })).rejects.toThrow(/ya no existe/);
  });

  it('lee la hora de fin y si es provisional', () => {
    expect(parseIcs(ICS, '2026-10-29', '2026-10-29')[0]).toMatchObject({ time: '09:00', end: '09:15', showAs: 'busy' });
    const tentative = ICS.replace('DTEND', 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE\r\nDTEND');
    expect(parseIcs(tentative, '2026-10-29', '2026-10-29')[0].showAs).toBe('tentative');
  });

  // Lo que devuelve «Obtener vista de calendario de eventos (V3)» de Power Automate (horas en UTC, sin zona).
  const V3 = [
    { subject: 'Equipo · daily', start: '2026-10-29T09:00:00.0000000', end: '2026-10-29T09:30:00.0000000', isAllDay: false,
      showAs: 'tentative', organizer: 'diana.perez@empresa.com', requiredAttendees: 'luis.gomez@empresa.com;ana.lopez@empresa.com;',
      optionalAttendees: '', location: 'Reunión de Microsoft Teams', iCalUId: 'abc',
      body: '<p>Unirse: <a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&amp;x=1">aquí</a></p>' },
    { subject: 'Cancelado: Repesca', start: '2026-10-29T10:00:00.0000000', end: '2026-10-29T11:00:00.0000000' },
    { subject: 'Festivo', start: '2026-10-30T00:00:00.0000000', end: '2026-10-31T00:00:00.0000000', isAllDay: true },
  ];

  it('lee las reuniones del flujo de Power Automate (títulos, hora local, Teams, provisionales)', () => {
    const events = trimOutlookEvents({ value: V3 });
    expect(events).toHaveLength(2); // sin la cancelada
    const [daily, holiday] = outlookToCalendar(events, '2026-10-26', '2026-11-01');
    expect(daily).toMatchObject({
      title: 'Equipo · daily', date: '2026-10-29', time: '10:00', end: '10:30', showAs: 'tentative', // UTC+1 en invierno
      organizer: { name: 'Diana Perez', email: 'diana.perez@empresa.com' },
      url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&x=1',
    });
    expect(daily.attendees.map((a) => a.name)).toEqual(['Diana Perez', 'Luis Gomez', 'Ana Lopez']);
    expect(holiday).toMatchObject({ date: '2026-10-30', time: null });
    expect(nameFromEmail('ana_lopez2@empresa.com')).toBe('Ana Lopez');
  });

  it('vincula el archivo del flujo a una sola cuenta y lo vuelve a leer al cambiar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    const path = join(dir, 'calendario.json');
    writeFileSync(path, JSON.stringify(V3));
    const { calendar, marta, luis } = setup(ICS, 200, path);
    expect(calendar.status(marta).file).toEqual({ linked: false, found: true });
    calendar.linkFile(marta);
    expect(() => calendar.linkFile(luis)).toThrow(/otra cuenta/);
    await expect(calendar.events(luis)).rejects.toThrow(/Vincula/);
    expect((await calendar.events(marta)).events.map((e) => e.title)).toEqual(['Equipo · daily', 'Festivo']);
    writeFileSync(path, '\uFEFF' + JSON.stringify([V3[0]]));
    const { utimesSync } = await import('node:fs');
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect((await calendar.events(marta)).events).toHaveLength(1);
    writeFileSync(path, 'no es json');
    utimesSync(path, new Date(), new Date(Date.now() + 10000));
    await expect(calendar.events(marta)).rejects.toThrow(/JSON/);
    calendar.unlinkFile(marta);
    expect(calendar.status(marta).file.linked).toBe(false);
  });

  it('tras pasar a Supabase, la misma persona (mismo email) recupera el archivo de su cuenta de antes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-'));
    const path = join(dir, 'calendario.json');
    writeFileSync(path, JSON.stringify(V3));
    const { calendar, marta, luis, db } = setup(ICS, 200, path);
    // La tabla de cuentas que tenía este servidor antes de Supabase.
    db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO users (id, login) VALUES (?, ?)').run(marta.id, marta.login);
    calendar.linkFile(marta);
    const martaSupabase = { id: 'id-de-supabase', login: 'MARTA@vml.com', name: 'Marta' };
    expect(calendar.linkFile(martaSupabase).file.linked).toBe(true);
    expect(calendar.status(marta).file.linked).toBe(false);
    expect(() => calendar.linkFile(luis)).toThrow(/otra cuenta/);
  });
});

describe('oneDriveDirs (Mac y Windows)', () => {
  it('encuentra Gestor/calendario.json en el OneDrive de empresa de un perfil de Windows', () => {
    const home = mkdtempSync(join(tmpdir(), 'od-'));
    mkdirSync(join(home, 'OneDrive - WPP', 'Gestor'), { recursive: true });
    mkdirSync(join(home, 'Documents'));
    writeFileSync(join(home, 'OneDrive - WPP', 'Gestor', 'calendario.json'), '[]');
    expect(oneDriveDirs(home, {})).toEqual([join(home, 'OneDrive - WPP')]);
    expect(oneDriveDirs(home, { OneDriveCommercial: 'C:\\x' })[0]).toBe('C:\\x');
    expect(findGestorFile('calendario.json', 'NO_EXISTE_VAR', home)).toBe(join(home, 'OneDrive - WPP', 'Gestor', 'calendario.json'));
  });
});

describe('tope del flujo de Power Automate', async () => {
  const { looksCapped } = await import('../src/domain/outlookEvents');
  it('avisa cerca de 256 reuniones (sin las canceladas), no con menos ni con el flujo a 1000', () => {
    expect([100, 239, 240, 246, 255, 256, 257, 312, 1000].map(looksCapped)).toEqual([false, false, true, true, true, true, false, false, false]);
  });
});
