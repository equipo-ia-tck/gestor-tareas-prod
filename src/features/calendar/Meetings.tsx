import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, FileText, MapPin, RefreshCw, Users, Video } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { navigate, routeHref } from '../../app/router';
import { Popover } from '../../components/ui/Popover';
import { repo } from '../../data/services';
import type { CalendarEvent } from '../../domain/ics';
import { teamsLinkProps, useTeamsApp } from '../../hooks/useTeamsApp';
import { createMeetingNote, meetingNoteFor } from '../notes/IcsImport';
import { connectOutlook, disconnectOutlook, hasCalendar, isPendingMeeting, removePendingMeeting, linkOutlookFile, loadOutlook, unlinkOutlookFile, uploadTokenApi, useOutlook } from './outlook';

export const timeRange = (e: CalendarEvent) => (e.time ? `${e.time}${e.end ? `–${e.end}` : ''}` : 'Todo el día');

/** Reunión de Outlook en el Calendario: al pulsarla, su ficha con Unirse y Crear/Abrir acta. */
export function MeetingItem({ event, compact }: { event: CalendarEvent; compact?: boolean }) {
  return (
    <Popover width="w-80" trigger={(toggle, open) => (
      <button
        type="button"
        onClick={toggle}
        title={`${timeRange(event)} · ${event.title}`}
        className={`flex w-full items-center gap-1.5 truncate rounded text-left hover:bg-violet-100 dark:hover:bg-violet-950
          ${compact ? 'px-1 py-0.5 text-[11px]' : 'px-2 py-1 text-sm'} ${open ? 'bg-violet-100 dark:bg-violet-950' : ''}`}
      >
        <span className={`shrink-0 rounded-sm bg-violet-500 ${compact ? 'h-3 w-0.5' : 'h-4 w-1'}`} />
        <span className={`shrink-0 tabular-nums text-violet-700 dark:text-violet-300 ${compact ? '' : 'w-24 text-xs'}`}>
          {compact ? event.time ?? '' : timeRange(event)}
        </span>
        <span className="min-w-0 flex-1 truncate">{event.title}</span>
        {!compact && event.attendees.length > 0 && <span className="shrink-0 text-xs text-zinc-400"><Users className="mr-0.5 inline size-3" />{event.attendees.length}</span>}
        {!compact && event.url && <Video className="size-3.5 shrink-0 text-violet-500" />}
      </button>
    )}>
      {(close) => <MeetingDetails event={event} close={close} />}
    </Popover>
  );
}

export function MeetingDetails({ event, close }: { event: CalendarEvent; close: () => void }) {
  const { notes, peopleCards, today } = useApp();
  const note = meetingNoteFor(event, notes);
  const [showAll, setShowAll] = useState(false);
  const [teamsApp] = useTeamsApp();
  const people = showAll ? event.attendees : event.attendees.slice(0, 8);
  const description = event.description.replace(/_{5,}[\s\S]*$/, '').trim(); // sin el bloque "Unirse a Teams…" de Outlook

  async function openNote() {
    close();
    if (note) { navigate({ view: 'notes', id: note.id }); return; }
    let id = '';
    await repo.batch(`Acta de «${event.title}»`, async () => { id = (await createMeetingNote(event, peopleCards)).id; });
    navigate({ view: 'notes', id });
  }

  return (
    <div className="p-2">
      <p className="font-semibold leading-snug">{event.title}</p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
        <CalendarClock className="size-3.5" />
        {new Date(`${event.date}T12:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })} · {timeRange(event)}
        {event.date === today && <span className="ml-1 rounded bg-indigo-600 px-1 text-[10px] font-semibold text-white">Hoy</span>}
      </p>
      {event.location && !event.location.startsWith('http') && (
        <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500"><MapPin className="size-3.5 shrink-0" /><span className="truncate">{event.location}</span></p>
      )}
      {event.organizer && <p className="mt-2 text-xs text-zinc-500">Organiza <b className="text-zinc-700 dark:text-zinc-300">{event.organizer.name}</b></p>}
      {event.attendees.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-xs text-zinc-500">{event.attendees.length} asistente{event.attendees.length === 1 ? '' : 's'}</p>
          <div className="flex flex-wrap gap-1">
            {people.map((a) => (
              <a key={a.email || a.name} href={routeHref({ view: 'person', name: a.name })} onClick={close}
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">{a.name}</a>
            ))}
            {!showAll && event.attendees.length > people.length && (
              <button type="button" onClick={() => setShowAll(true)} className="px-1 text-xs text-zinc-500 hover:underline">+{event.attendees.length - people.length}</button>
            )}
          </div>
        </div>
      )}
      {isPendingMeeting(event) && (
        <p className="mt-2 rounded-md bg-violet-50 px-2 py-1 text-xs text-violet-800 dark:bg-violet-950 dark:text-violet-300">
          Pendiente: creada desde el gestor. Aparecerá con sus datos cuando llegue de Outlook (si la enviaste en Teams).
          <button type="button" onClick={() => { removePendingMeeting(event.uid); close(); }} className="ml-1 font-medium underline">Quitar</button>
        </p>
      )}
      {description && <p className="mt-2 line-clamp-6 text-xs whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{description}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {event.url && (
          <a {...teamsLinkProps(event.url, teamsApp)} onClick={close}
            className="inline-flex items-center gap-1 rounded-md bg-[#5b5fc7] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4b4fb7]">
            <Video className="size-3.5" />Unirse
          </a>
        )}
        <button type="button" onClick={() => void openNote()}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
          <FileText className="size-3.5" />{note ? 'Abrir acta' : 'Crear acta'}
        </button>
      </div>
    </div>
  );
}

/** En la cabecera del Calendario: mostrar u ocultar reuniones y refrescarlas, o el enlace para conectar Outlook. */
export function OutlookControls({ show, setShow }: { show: boolean; setShow: (v: boolean) => void }) {
  const { status, loading, error, at } = useOutlook();
  if (!status) return null;
  if (!hasCalendar(status)) {
    return (
      <a href={routeHref({ view: 'settings' })} className="mr-2 inline-flex items-center gap-1 text-xs text-violet-600 hover:underline dark:text-violet-400">
        <CalendarClock className="size-3.5" />Conectar Outlook
      </a>
    );
  }
  return (
    <span className="mr-2 inline-flex items-center gap-1.5 text-xs text-zinc-500">
      <label className="flex items-center gap-1.5" title="Reuniones de tu calendario de Outlook/Teams">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        <span className="size-2 rounded-sm bg-violet-500" />Reuniones
      </label>
      <button type="button" onClick={() => void loadOutlook(true)} disabled={loading}
        title={error ?? (at ? `Actualizado a las ${new Date(at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}. Pulsa para actualizar.` : 'Actualizar')}
        className={`rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${error ? 'text-amber-600' : ''}`}>
        <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </span>
  );
}

const clock = (iso: string | number) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Ajustes → Calendario de Outlook: el archivo de Power Automate (con títulos) y el enlace ICS publicado (disponibilidad). */
export function OutlookSettings() {
  const { server, status } = useOutlook();
  return (
    <div className="space-y-5 text-sm">
      <UploadSettings />
      {server ? (
        <>
          <FlowSettings />
          <IcsSettings />
        </>
      ) : status && (
        <p className="text-xs text-zinc-500">
          Sin el servidor local (<code>npm start</code>) no se puede vincular el archivo directamente ni el enlace ICS: en la app
          publicada, las reuniones llegan con la subida desde el Mac.
        </p>
      )}
      <TeamsAppSetting />
    </div>
  );
}

/**
 * Subida desde el Mac (`npm run subir`): lleva a Supabase las reuniones de OneDrive/Gestor/calendario.json, para verlas
 * en la app publicada (Vercel), que no ve las carpetas del Mac. Va con una clave de subida, no con la contraseña.
 */
function UploadSettings() {
  const { cloud } = useOutlook();
  const [info, setInfo] = useState<{ hasToken: boolean; createdAt: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { uploadTokenApi.info().then(setInfo, (e: Error) => setError(e.message)); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const generate = () => run(async () => {
    if (info?.hasToken && !confirm('La clave anterior dejará de valer: tendrás que poner la nueva en el Mac. ¿Seguir?')) return;
    setToken(await uploadTokenApi.create());
    setCopied(false);
    setInfo(await uploadTokenApi.info());
  });
  const revoke = () => run(async () => {
    if (!confirm('Se borra la clave y las reuniones subidas. El Mac dejará de subirlas. ¿Seguir?')) return;
    await uploadTokenApi.revoke();
    setToken(null);
    setInfo(await uploadTokenApi.info());
    await loadOutlook(true);
  });
  const command = token ? `npm run subir -- ${token}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); } catch { /* se puede copiar a mano */ }
  };
  const stale = cloud && Date.now() - new Date(cloud.uploadedAt).getTime() > 60 * 60_000;

  return (
    <section>
      <h3 className="font-medium">Subida desde el Mac <span className="font-normal text-zinc-500">(para la app publicada)</span></h3>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">
        La app publicada no ve las carpetas de tu Mac. Un pequeño proceso del Mac sube tus reuniones de
        {' '}<code>OneDrive/Gestor/calendario.json</code> a tu cuenta cada vez que el flujo lo actualiza. Solo tú las ves.
      </p>
      {cloud && (
        <p className={`mt-1 text-xs ${stale ? 'text-amber-600' : 'text-zinc-500'}`}>
          ✓ {cloud.events.length} reuniones subidas el {clock(cloud.uploadedAt)}
          {stale ? ': hace más de una hora. ¿Está el Mac encendido y «npm run subir» en marcha?' : '.'}
        </p>
      )}
      {token ? (
        <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-2 text-xs dark:border-indigo-900 dark:bg-indigo-950/40">
          <p>Copia esta orden y ejecútala en la carpeta del gestor, en la Terminal del Mac. <b>La clave solo se ve ahora.</b></p>
          <div className="mt-1.5 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 dark:bg-zinc-900" title={command}>{command}</code>
            <button type="button" onClick={() => void copy()} className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-white dark:border-zinc-600 dark:hover:bg-zinc-800">
              {copied ? 'Copiada' : 'Copiar'}
            </button>
          </div>
          <p className="mt-1.5 text-zinc-500">
            Se queda vigilando el archivo. Para que siga solo aunque cierres la Terminal: <code>npm run subir -- --instalar</code>.
          </p>
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void generate()} disabled={busy || !info}
          className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          {info?.hasToken ? 'Generar otra clave' : 'Generar clave de subida'}
        </button>
        {info?.hasToken && (
          <button type="button" onClick={() => void revoke()} disabled={busy} className="rounded-md px-3 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">Quitar</button>
        )}
      </div>
      {error && <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
    </section>
  );
}

/** Reuniones con título: un flujo de Power Automate las guarda en OneDrive/Gestor/calendario.json. */
function FlowSettings() {
  const { status, events, fileAt, error, loading } = useOutlook();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFormError(null);
    try { await fn(); } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  };
  const linked = !!status?.file.linked;
  // El flujo se ejecuta cada pocos minutos: si lleva más de una hora sin escribir, algo pasa.
  const stale = fileAt && Date.now() - new Date(fileAt).getTime() > 60 * 60_000;

  return (
    <section>
      <h3 className="font-medium">Reuniones con título (Power Automate)</h3>
      {linked ? (
        <>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Vinculado a <code>OneDrive/Gestor/calendario.json</code>. {events ? `${events.length} reuniones.` : ''}
            {fileAt && <span className={stale ? 'text-amber-600' : ''}> El flujo lo actualizó el {clock(fileAt)}{stale ? ': hace más de una hora, revisa que el flujo esté activo.' : '.'}</span>}
          </p>
          {error && <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">{error}</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void loadOutlook(true)} disabled={loading}
              className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
              {loading ? 'Leyendo…' : 'Leer ahora'}
            </button>
            <button type="button" onClick={() => void run(unlinkOutlookFile)} className="rounded-md px-3 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">Desvincular</button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Un flujo de Power Automate guarda tus reuniones (con título, asistentes y enlace de Teams) en tu OneDrive cada pocos minutos.
            OneDrive lo sincroniza a este ordenador y el gestor lo lee de aquí: no sale de tus cuentas de WPP.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {status?.file.found ? '✓ Archivo encontrado en tu OneDrive.' : 'Aún no hay Gestor/calendario.json en tu OneDrive: crea el flujo y ejecútalo una vez.'}
          </p>
          <button type="button" onClick={() => void run(linkOutlookFile)} disabled={busy || !status?.file.found}
            className="mt-2 rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            {busy ? 'Vinculando…' : 'Vincular a mi cuenta'}
          </button>
        </>
      )}
      {formError && <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{formError}</p>}
    </section>
  );
}

/** Enlace ICS publicado de Outlook (en WPP solo da la disponibilidad: «Busy», «Tentative»). */
function IcsSettings() {
  const { status, error, at, loading, events } = useOutlook();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await connectOutlook(url);
      setUrl('');
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="font-medium">Enlace ICS publicado <span className="font-normal text-zinc-500">(solo disponibilidad)</span></h3>
      {status?.connected ? (
        <>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Conectado a <b>{status.host}</b>.{' '}
            {events ? 'No se usa mientras haya reuniones del flujo de Power Automate.' : <>Se actualiza cada 5 minutos.{at && ` Última lectura: ${clock(at)}.`}</>}
          </p>
          {!events && error && <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">{error}</p>}
          <div className="mt-2 flex gap-2">
            {!events && (
              <button type="button" onClick={() => void loadOutlook(true)} disabled={loading}
                className="rounded-md border border-zinc-300 px-3 py-1 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                {loading ? 'Actualizando…' : 'Actualizar ahora'}
              </button>
            )}
            <button type="button" onClick={() => void disconnectOutlook()} className="rounded-md px-3 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">Desconectar</button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <p className="mt-1 mb-2 text-zinc-600 dark:text-zinc-400">
            Si tu empresa deja publicar el calendario, pega su enlace <b>ICS</b> (Outlook web → Configuración → Calendario → Calendarios
            compartidos → Publicar un calendario). Se guarda solo en el servidor.
          </p>
          <div className="flex gap-2">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
            <button type="submit" disabled={busy || !url.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
              {busy ? 'Comprobando…' : 'Conectar'}
            </button>
          </div>
          {formError && <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{formError}</p>}
        </form>
      )}
    </section>
  );
}

/** Abrir Unirse, chats y reuniones nuevas directamente en la app de Teams, sin dejar una pestaña abierta en Chrome. */
function TeamsAppSetting() {
  const [teamsApp, setTeamsApp] = useTeamsApp();
  return (
    <section>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={teamsApp} onChange={(e) => setTeamsApp(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-medium">Abrir Teams directamente en la aplicación</span>
          <span className="block text-xs text-zinc-500">
            «Unirse», los chats y las reuniones nuevas van a la app de Teams sin abrir una pestaña en el navegador. La primera vez
            Chrome pregunta si abrir Microsoft Teams: marca «Permitir siempre». Desmárcalo si no tienes la app instalada.
          </span>
        </span>
      </label>
    </section>
  );
}
