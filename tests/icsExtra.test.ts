import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { IcsExtra, icsExtraRoute, SqliteIcsAccounts, trimIcs } from '../servidor/icsExtra.ts';
import { SupabaseIcsAccounts } from '../servidor/supabaseAccounts.ts';
import { parseIcs } from '../src/domain/ics';

const event = (uid: string, start: string, extra: string[] = []) =>
  ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:Reunión ${uid}`, `DTSTART:${start}`, ...extra, 'END:VEVENT'];
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:Romance Standard Time', 'END:VTIMEZONE',
  ...event('vieja', '20240105T090000Z'),
  ...event('cerca', '20261120T090000Z'),
  ...event('semanal', '20230102T080000Z', ['RRULE:FREQ=WEEKLY;BYDAY=MO']),
  ...event('lejana', '20280101T090000Z'),
  'END:VCALENDAR',
].join('\r\n');

const marta = { id: 'u-marta', login: 'marta@vml.com', name: 'Marta' };
const luis = { id: 'u-luis', login: 'luis@vml.com', name: 'Luis' };

function setup(body = ICS, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => { calls.push(url); return new Response(body, { status }); }) as unknown as typeof fetch;
  return { cal: new IcsExtra(new SqliteIcsAccounts(new DatabaseSync(':memory:')), fetcher), calls };
}

describe('otro calendario por enlace ICS', () => {
  it('recorta a las reuniones cercanas y deja las recurrentes y las zonas horarias', () => {
    const out = trimIcs(ICS, '20261001', '20270301');
    expect(out).toContain('UID:cerca');
    expect(out).toContain('UID:semanal');
    expect(out).toContain('TZID:Romance Standard Time');
    expect(out).not.toContain('UID:vieja');
    expect(out).not.toContain('UID:lejana');
    expect(parseIcs(out, '2026-11-20', '2026-11-20').map((e) => e.uid)).toEqual(['cerca']);
  });

  it('conecta con nombre, no devuelve el enlace y cada persona tiene el suyo', async () => {
    const { cal, calls } = setup();
    expect(await cal.status(marta)).toEqual({ connected: false, name: null, host: null });
    await expect(cal.ics(marta)).rejects.toThrow(/Conecta/);
    const status = await cal.connect(marta, { url: 'webcal://outlook.office365.com/owa/calendar/x/y/calendar.ics', name: '  La   Caixa ' });
    expect(status).toEqual({ connected: true, name: 'La Caixa', host: 'outlook.office365.com' });
    expect(JSON.stringify(status)).not.toContain('calendar.ics');
    expect(calls).toEqual(['https://outlook.office365.com/owa/calendar/x/y/calendar.ics']);
    expect(await cal.status(luis)).toMatchObject({ connected: false });
    const r = await cal.ics(marta, new Date('2026-11-19T10:00:00Z'));
    expect(r.name).toBe('La Caixa');
    expect(r.ics).toContain('UID:cerca');
    expect(r.ics).not.toContain('UID:vieja');
    expect(await cal.disconnect(marta)).toMatchObject({ connected: false });
  });

  it('rechaza enlaces que no son de un calendario publicado', async () => {
    await expect(setup().cal.connect(marta, { url: 'https://127.0.0.1/x.ics' })).rejects.toThrow(/no es/);
    await expect(setup('<html></html>').cal.connect(marta, { url: 'https://example.com/x.ics' })).rejects.toThrow(/no devuelve un calendario/);
    await expect(setup('', 404).cal.connect(marta, { url: 'https://example.com/x.ics' })).rejects.toThrow(/ya no existe/);
  });

  it('rutas: estado, conectar, .ics, quitar y 404', async () => {
    const { cal } = setup();
    const body = async () => ({ url: 'https://example.com/c.ics', name: 'Caixa' });
    expect(await icsExtraRoute(cal, marta, 'POST', '/api/calendario-extra/connect', body)).toMatchObject({ connected: true, name: 'Caixa' });
    expect(await icsExtraRoute(cal, marta, 'GET', '/api/calendario-extra', body)).toMatchObject({ connected: true });
    expect(await icsExtraRoute(cal, marta, 'GET', '/api/calendario-extra/ics', body)).toMatchObject({ name: 'Caixa' });
    expect(await icsExtraRoute(cal, marta, 'POST', '/api/calendario-extra/disconnect', body)).toMatchObject({ connected: false });
    await expect(icsExtraRoute(cal, marta, 'GET', '/api/calendario-extra/otra', body)).rejects.toThrow(/No existe/);
  });

  it('en Vercel el enlace se guarda cifrado en Supabase', async () => {
    const stored: Record<string, unknown> = {};
    const fetcher = (async (url: string, init: RequestInit) => {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(args.p_connector).toBe('calendario-ics');
      if (fn === 'set_my_connector') { stored.row = { secret: args.p_secret, info: args.p_info }; return new Response(''); }
      if (fn === 'delete_my_connector') { delete stored.row; return new Response(''); }
      return Response.json(stored.row ?? null);
    }) as unknown as typeof fetch;
    const accounts = new SupabaseIcsAccounts({ url: 'https://x.supabase.co', key: 'anon' }, 'token', 'secreto', fetcher);
    expect(await accounts.get()).toBeUndefined();
    await accounts.set('u', { url: 'https://outlook.office365.com/owa/calendar/x/calendar.ics', name: 'La Caixa' });
    expect(JSON.stringify(stored)).not.toContain('outlook.office365.com');
    expect(await accounts.get()).toEqual({ url: 'https://outlook.office365.com/owa/calendar/x/calendar.ics', name: 'La Caixa' });
    expect(await new SupabaseIcsAccounts({ url: 'https://x.supabase.co', key: 'anon' }, 'token', 'otro-secreto', fetcher).get()).toBeUndefined();
    await accounts.remove();
    expect(await accounts.get()).toBeUndefined();
  });
});
