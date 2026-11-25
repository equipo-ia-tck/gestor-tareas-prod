import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/domain/ics';

// Los tests corren con TZ=Europe/Madrid (tests/setup.ts).
const ARGENTINA = [
  'BEGIN:VTIMEZONE', 'TZID:Argentina Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
const ROMANCE = [
  'BEGIN:VTIMEZONE', 'TZID:Romance Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
const ics = (zones: string[], ...event: string[]) => ['BEGIN:VCALENDAR', ...zones, 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Sync', ...event, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const one = (text: string, from = '2026-01-01', to = '2026-12-31') => parseIcs(text, from, to).map((e) => `${e.date} ${e.time}-${e.end}`);

describe('calendario .ics: zonas horarias', () => {
  it('una reunión puesta desde Argentina a las 10:00 sale a las 14:00 en Madrid (15:00 en verano)', () => {
    expect(one(ics(ARGENTINA, 'DTSTART;TZID=Argentina Standard Time:20261125T100000', 'DTEND;TZID=Argentina Standard Time:20261125T110000'))).toEqual(['2026-11-25 14:00-15:00']);
    expect(one(ics(ARGENTINA, 'DTSTART;TZID=Argentina Standard Time:20260610T100000', 'DTEND;TZID=Argentina Standard Time:20260610T103000'))).toEqual(['2026-06-10 15:00-15:30']);
  });

  it('sin VTIMEZONE: nombres de Windows e IANA', () => {
    expect(one(ics([], 'DTSTART;TZID=Argentina Standard Time:20261125T100000'))).toEqual(['2026-11-25 14:00-null']);
    expect(one(ics([], 'DTSTART;TZID=America/Argentina/Buenos_Aires:20261125T100000'))).toEqual(['2026-11-25 14:00-null']);
  });

  it('la zona de aquí y las desconocidas se quedan como vienen', () => {
    expect(one(ics(ROMANCE, 'DTSTART;TZID=Romance Standard Time:20261125T100000', 'DTEND;TZID=Romance Standard Time:20261125T110000'))).toEqual(['2026-11-25 10:00-11:00']);
    expect(one(ics(ROMANCE, 'DTSTART;TZID=Romance Standard Time:20260610T100000'))).toEqual(['2026-06-10 10:00-null']);
    expect(one(ics([], 'DTSTART;TZID=Zona Inventada:20261125T100000'))).toEqual(['2026-11-25 10:00-null']);
    expect(one(ics([], 'DTSTART:20261125T100000Z'))).toEqual(['2026-11-25 11:00-null']);
  });

  it('una semanal desde Argentina cambia de hora aquí con el cambio de horario de España', () => {
    const text = ics(ARGENTINA, 'DTSTART;TZID=Argentina Standard Time:20261021T100000', 'DTEND;TZID=Argentina Standard Time:20261021T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=Argentina Standard Time:20261104T100000');
    expect(one(text, '2026-10-20', '2026-11-12')).toEqual(['2026-10-21 15:00-16:00', '2026-10-28 14:00-15:00', '2026-11-11 14:00-15:00']);
  });

  it('una reunión tarde en Argentina cae al día siguiente aquí', () => {
    expect(one(ics(ARGENTINA, 'DTSTART;TZID=Argentina Standard Time:20261125T220000', 'DTEND;TZID=Argentina Standard Time:20261125T230000'))).toEqual(['2026-11-26 02:00-03:00']);
  });
});
