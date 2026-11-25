/**
 * Zonas horarias de los calendarios .ics. Una reunión creada por alguien de otro país llega con su hora y su zona
 * (`DTSTART;TZID=Argentina Standard Time:20261125T100000`) y hay que pasarla a la hora de aquí (14:00 en Madrid).
 *
 * Por orden: la definición `VTIMEZONE` del propio archivo (Outlook la incluye siempre), el nombre IANA
 * (`America/Argentina/Buenos_Aires`) con `Intl`, y los nombres de Windows más habituales. Si no se reconoce la zona, la hora
 * se deja como viene (lo de antes).
 */

/** Regla de un tramo (STANDARD o DAYLIGHT) de un VTIMEZONE. */
export interface ZoneRule {
  kind: 'STANDARD' | 'DAYLIGHT';
  /** Minutos respecto a UTC en el tramo (TZOFFSETTO). */
  offset: number;
  /** Desde qué año vale (de su DTSTART). */
  fromYear: number;
  /** Mes (1-12), semana (1…4, -1 = la última) y día (0 = domingo) del cambio, si se repite cada año. */
  month?: number;
  week?: number;
  weekday?: number;
  /** Hora local del cambio, en minutos. */
  at: number;
}

export type ZoneTable = Map<string, ZoneRule[]>;

const WEEKDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** «+0100», «-0300» o «+053000» → minutos. */
function offsetMinutes(v: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Lee los VTIMEZONE de un .ics (ya con las líneas desplegadas). */
export function parseZones(lines: string[]): ZoneTable {
  const zones: ZoneTable = new Map();
  let tzid: string | null = null;
  let rules: ZoneRule[] = [];
  let cur: Partial<ZoneRule> & { kind?: ZoneRule['kind'] } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const up = line.toUpperCase();
    if (up === 'BEGIN:VTIMEZONE') { tzid = null; rules = []; continue; }
    if (up === 'END:VTIMEZONE') { if (tzid && rules.length) zones.set(tzid, rules); tzid = null; continue; }
    if (up === 'BEGIN:STANDARD' || up === 'BEGIN:DAYLIGHT') { cur = { kind: up.slice(6) as ZoneRule['kind'] }; continue; }
    if (up === 'END:STANDARD' || up === 'END:DAYLIGHT') {
      if (cur?.kind && cur.offset != null) rules.push({ fromYear: 0, at: 0, ...cur } as ZoneRule);
      cur = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0].toUpperCase();
    const value = line.slice(colon + 1);
    if (!cur) { if (name === 'TZID') tzid = value.trim(); continue; }
    if (name === 'TZOFFSETTO') cur.offset = offsetMinutes(value) ?? undefined;
    else if (name === 'DTSTART') {
      const m = /^(\d{4})\d{4}T(\d{2})(\d{2})/.exec(value.trim());
      if (m) { cur.fromYear = Number(m[1]); cur.at = Number(m[2]) * 60 + Number(m[3]); }
    } else if (name === 'RRULE') {
      const r = Object.fromEntries(value.split(';').map((kv) => kv.split('=') as [string, string]));
      const day = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(r.BYDAY ?? '');
      if (r.BYMONTH && day) { cur.month = Number(r.BYMONTH); cur.week = day[1] ? Number(day[1]) : 1; cur.weekday = WEEKDAY[day[2]]; }
    }
  }
  return zones;
}

/** Día del mes del cambio de un año: la semana N (o la última, -1) del día de la semana indicado. */
function transitionDay(year: number, month: number, week: number, weekday: number): number {
  if (week > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (week - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return lastDate - ((last - weekday + 7) % 7);
}

/** Minutos respecto a UTC de una hora local (año, mes, día, minutos del día) según las reglas de un VTIMEZONE. */
function ruleOffset(rules: ZoneRule[], y: number, mo: number, d: number, minutes: number): number {
  const pick = (kind: ZoneRule['kind']) => rules.filter((r) => r.kind === kind && r.fromYear <= y).sort((a, b) => b.fromYear - a.fromYear)[0]
    ?? rules.filter((r) => r.kind === kind).sort((a, b) => a.fromYear - b.fromYear)[0];
  const std = pick('STANDARD');
  const dst = pick('DAYLIGHT');
  if (!std || !dst || std.month == null || dst.month == null) return (std ?? dst ?? rules[0]).offset;
  // Momento del año como número comparable (mes, día, minutos), en hora local.
  const key = (m: number, day: number, mins: number) => (m * 32 + day) * 1440 + mins;
  const now = key(mo, d, minutes);
  const toDst = key(dst.month, transitionDay(y, dst.month, dst.week ?? 1, dst.weekday ?? 0), dst.at);
  const toStd = key(std.month, transitionDay(y, std.month, std.week ?? 1, std.weekday ?? 0), std.at);
  // Hemisferio norte: horario de verano entre el cambio a verano y el de vuelta; sur: al revés.
  const summer = toDst < toStd ? now >= toDst && now < toStd : now >= toDst || now < toStd;
  return summer ? dst.offset : std.offset;
}

/** Nombres de Windows (los que pone Outlook) más habituales → IANA, por si el archivo no trae su VTIMEZONE. */
const WINDOWS_ZONES: Record<string, string> = {
  'romance standard time': 'Europe/Madrid',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'gtb standard time': 'Europe/Bucharest',
  'utc': 'UTC',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'e. south america standard time': 'America/Sao_Paulo',
  'pacific sa standard time': 'America/Santiago',
  'montevideo standard time': 'America/Montevideo',
  'paraguay standard time': 'America/Asuncion',
  'sa western standard time': 'America/La_Paz',
  'sa pacific standard time': 'America/Bogota',
  'sa eastern standard time': 'America/Cayenne',
  'venezuela standard time': 'America/Caracas',
  'central standard time (mexico)': 'America/Mexico_City',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata',
};

const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Minutos respecto a UTC de una zona IANA en un instante. */
function ianaOffset(tz: string, utcMs: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((wall - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/**
 * Instante (ms UTC) de una hora local en una zona del .ics, o null si la zona no se reconoce (y entonces la hora se deja
 * como viene).
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tzid: string, zones: ZoneTable): number | null {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const rules = zones.get(tzid);
  if (rules?.length) return wall - ruleOffset(rules, y, mo, d, h * 60 + mi) * 60_000;
  const clean = tzid.replace(/^\/+|"/g, '').trim();
  const iana = validZone(clean) ? clean : WINDOWS_ZONES[clean.toLowerCase()];
  if (!iana || !validZone(iana)) return null;
  // Dos pasadas: el desfase depende del instante, que depende del desfase (cambios de hora).
  let utc = wall - ianaOffset(iana, wall) * 60_000;
  utc = wall - ianaOffset(iana, utc) * 60_000;
  return utc;
}
