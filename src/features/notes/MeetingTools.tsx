import { useEffect, useState } from 'react';
import { track } from '../usage/track';
import { Copy, MessageCircle, Share2, Video } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { routeHref } from '../../app/router';
import { MenuItem, Popover } from '../../components/ui/Popover';
import { useToast } from '../../components/Toast';
import { repo } from '../../data/services';
import { nameKey } from '../../domain/text';
import { meetingSummary, teamsChatUrl } from '../../domain/teams';
import type { Note } from '../../domain/types';
import { openTeams, teamsLinkProps, useTeamsApp } from '../../hooks/useTeamsApp';

/** Enlace de la reunión (Teams u otra) con botón "Unirse". */
export function MeetingLink({ note }: { note: Note }) {
  const [value, setValue] = useState(note.meeting_url ?? '');
  useEffect(() => setValue(note.meeting_url ?? ''), [note.meeting_url]);
  const [teamsApp] = useTeamsApp();
  const save = () => {
    const v = value.trim() || null;
    if (v !== note.meeting_url) void repo.updateNote(note.id, { meeting_url: v });
  };
  return (
    <div className="mb-3 flex items-center gap-2 text-sm">
      <Video className="size-4 shrink-0 text-zinc-400" />
      <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder="Pega el enlace de la reunión de Teams…"
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-zinc-600 outline-none placeholder:text-zinc-400 hover:border-zinc-200 focus:border-indigo-500 dark:text-zinc-300 dark:hover:border-zinc-700" />
      {note.meeting_url && (
        <a {...teamsLinkProps(note.meeting_url, teamsApp)} onClick={() => track('meeting-join', 'notes')}
          className="flex shrink-0 items-center gap-1 rounded-md bg-[#5b5fc7] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4b4fb7]">
          <Video className="size-3.5" />Unirse
        </a>
      )}
    </div>
  );
}

/** Compartir el acta: copiar el resumen o abrir un chat de Teams con los asistentes. */
export function ShareMeeting({ note }: { note: Note }) {
  const { tasks, peopleCards } = useApp();
  const toast = useToast();
  const summary = meetingSummary(note, new Map(tasks.map((t) => [t.id, t])));
  const emailOf = (name: string) => peopleCards.find((c) => nameKey(c.name) === nameKey(name))?.email ?? '';
  const missing = note.people.filter((p) => !emailOf(p));
  const [teamsApp] = useTeamsApp();
  const chat = teamsChatUrl(note.people.map(emailOf).filter(Boolean), note.title, summary);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      toast('No se pudo copiar al portapapeles');
    }
  }

  return (
    <Popover align="right" width="w-72" trigger={(toggle) => (
      <button type="button" onClick={toggle} title="Compartir" className="flex items-center gap-1 rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
        <Share2 className="size-4" />
      </button>
    )}>
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); void copy(summary, 'Resumen copiado: pégalo en Teams o en un correo'); }}>
            <Copy className="size-4 text-zinc-400" />Copiar resumen (decisiones y acciones)
          </MenuItem>
          <MenuItem onClick={() => { close(); void copy(note.body, 'Acta copiada en Markdown'); }}>
            <Copy className="size-4 text-zinc-400" />Copiar acta completa
          </MenuItem>
          {chat ? (
            <MenuItem onClick={() => { close(); openTeams(chat, teamsApp); }}>
              <MessageCircle className="size-4 text-[#5b5fc7]" />Abrir chat de Teams con los asistentes
            </MenuItem>
          ) : (
            <p className="px-2 py-1.5 text-xs text-zinc-500">
              Para abrir un chat de Teams, añade el email de los asistentes en su ficha.
            </p>
          )}
          {missing.length > 0 && (
            <p className="border-t border-zinc-100 px-2 pt-1.5 text-[11px] text-zinc-400 dark:border-zinc-800">
              Sin email: {missing.map((p, i) => (
                <span key={p}>{i > 0 && ', '}<a href={routeHref({ view: 'person', name: p })} className="underline">{p}</a></span>
              ))}
            </p>
          )}
        </>
      )}
    </Popover>
  );
}
