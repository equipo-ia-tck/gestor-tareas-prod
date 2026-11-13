import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Video, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { Modal } from '../../components/Modal';
import { Avatar } from '../../components/ui/Badges';
import { addDays } from '../../domain/dates';
import { outlookToCalendar } from '../../domain/outlookEvents';
import { meetingContacts, teamsMeetingUrl } from '../../domain/teams';
import { fold } from '../../domain/text';
import type { ISODate } from '../../domain/types';
import { openTeams, useTeamsApp } from '../../hooks/useTeamsApp';
import { addPendingMeeting, useOutlook } from './outlook';

const DURATIONS = [15, 30, 45, 60, 90, 120];

/** Próxima media hora en punto (hora local, "HH:MM"), para proponer la reunión. */
export function nextSlot(now = new Date()): string {
  const m = now.getHours() * 60 + now.getMinutes();
  const next = Math.min(Math.ceil((m + 1) / 30) * 30, 23 * 60 + 30);
  return `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
}
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());

/**
 * Reunión nueva de Teams desde el Calendario (doble clic en una hora vacía). No escribe en Outlook: abre en Teams el
 * formulario de reunión ya rellenado y, al enviarlo allí, queda en el calendario real. Mientras llega del calendario,
 * el gestor la muestra como pendiente. También se abre desde la ficha de una persona («Nueva reunión»): `title` y `invite`
 * vienen ya puestos, y a quien no trae email se le busca entre los contactos por su nombre.
 */
export function NewMeeting({ date: initialDate, time: initialTime, title: initialTitle = '', invite = [], onClose }: {
  date: ISODate;
  time: string;
  title?: string;
  invite?: { name: string; email?: string | null }[];
  onClose: () => void;
}) {
  const { peopleCards, today } = useApp();
  const { events } = useOutlook();
  const [title, setTitle] = useState(initialTitle);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [minutes, setMinutes] = useState(30);
  const [attendees, setAttendees] = useState<{ name: string; email: string }[]>(
    () => invite.filter((p) => p.email && isEmail(p.email)).map((p) => ({ name: p.name, email: p.email!.trim() })));
  const [query, setQuery] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [teamsApp] = useTeamsApp();

  // A quién se puede invitar: quien sale en tus reuniones (de los últimos y próximos días) y las fichas con email.
  const contacts = useMemo(
    () => meetingContacts(events ? outlookToCalendar(events, addDays(today, -60), addDays(today, 60)) : [], peopleCards),
    [events, peopleCards, today],
  );
  // Invitados sin email en su ficha: el de sus reuniones, si sale con el mismo nombre.
  const [missing, setMissing] = useState(() => invite.filter((p) => !p.email || !isEmail(p.email)).map((p) => p.name));
  useEffect(() => {
    if (!missing.length || !contacts.length) return;
    const found = missing.map((n) => contacts.find((c) => fold(c.name) === fold(n))).filter((c): c is { name: string; email: string } => !!c);
    if (!found.length) return;
    setAttendees((list) => [...list, ...found.filter((c) => !list.some((a) => a.email.toLowerCase() === c.email.toLowerCase()))]);
    setMissing((m) => m.filter((n) => !found.some((c) => fold(c.name) === fold(n))));
  }, [contacts, missing]);
  const q = fold(query.trim());
  const suggestions = q
    ? contacts.filter((c) => !attendees.some((a) => a.email.toLowerCase() === c.email.toLowerCase())
      && (fold(c.name).includes(q) || c.email.toLowerCase().includes(q))).slice(0, 6)
    : [];

  function add(c: { name: string; email: string }) {
    if (!attendees.some((a) => a.email.toLowerCase() === c.email.toLowerCase())) setAttendees([...attendees, c]);
    setQuery('');
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && query.trim()) {
      e.preventDefault();
      if (suggestions[0]) add(suggestions[0]);
      else if (isEmail(query)) add({ name: query.trim(), email: query.trim() });
      else setError('Escribe un email completo o elige a alguien de la lista.');
    } else if (e.key === 'Backspace' && !query && attendees.length) {
      setAttendees(attendees.slice(0, -1));
    }
  }

  function create() {
    if (!title.trim()) { setError('Ponle un título.'); return; }
    if (!date || !/^\d{2}:\d{2}$/.test(time)) { setError('Revisa el día y la hora.'); return; }
    const url = teamsMeetingUrl({ title, date, time, minutes, attendees: attendees.map((a) => a.email), content });
    openTeams(url, teamsApp);
    const end = new Date(new Date(`${date}T${time}:00`).getTime() + minutes * 60_000);
    addPendingMeeting({
      title: title.trim(), date, time,
      end: `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`,
      attendees, organizer: null, description: content, location: '', url: null, showAs: 'tentative',
    });
    onClose();
  }

  const field = 'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900';

  return (
    <Modal title="Nueva reunión de Teams" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }} className="space-y-3 text-sm">
        <input autoFocus value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} placeholder="Título de la reunión" className={`${field} text-base font-medium`} />
        <div className="flex flex-wrap gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} w-auto`} />
          <input type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} className={`${field} w-auto`} />
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`${field} w-auto`}>
            {DURATIONS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`.replace('.5', ',5')}</option>)}
          </select>
        </div>

        <div className="relative">
          <div className={`${field} flex flex-wrap items-center gap-1`}>
            {attendees.map((a) => (
              <span key={a.email} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pr-1 pl-0.5 text-xs dark:bg-indigo-950" title={a.email}>
                <Avatar name={a.name} size={18} />{a.name}
                <button type="button" onClick={() => setAttendees(attendees.filter((x) => x !== a))} className="rounded-full p-0.5 hover:bg-indigo-100 dark:hover:bg-indigo-900" aria-label={`Quitar a ${a.name}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input value={query} onChange={(e) => { setQuery(e.target.value); setError(null); }} onKeyDown={onKey}
              placeholder={attendees.length ? '' : 'Asistentes: nombre o email'} className="min-w-32 flex-1 bg-transparent py-0.5 outline-none" />
          </div>
          {suggestions.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {suggestions.map((c) => (
                <li key={c.email}>
                  <button type="button" onClick={() => add(c)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <Avatar name={c.name} size={20} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="truncate text-xs text-zinc-400">{c.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {missing.length > 0 && (
          <p className="text-xs text-amber-600">Sin email: {missing.join(', ')}. Escríbelo en Asistentes (o ponlo en su ficha).</p>
        )}
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="Descripción o agenda (opcional)" className={`${field} resize-y`} />

        {error && <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
        <p className="text-xs text-zinc-500">
          Se abre Teams con la reunión rellenada: revísala y pulsa <b>Enviar</b> allí para que quede en tu calendario e invite a la gente.
          Aquí se verá como pendiente hasta que llegue de Outlook.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-[#5b5fc7] px-3 py-1.5 font-medium text-white hover:bg-[#4b4fb7]">
            <Video className="size-4" />Crear en Teams
          </button>
        </div>
      </form>
    </Modal>
  );
}
