import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApp } from '../../app/AppContext';
import { navigate, openSearch } from '../../app/router';
import { useToast } from '../../components/Toast';
import { fuzzyScore } from '../../domain/text';
import type { NewTask } from '../../domain/types';
import { CaptureInput } from '../capture/CaptureInput';
import { useSelection } from '../selection/SelectionContext';
import { buildCommands, type Command } from './commands';
import { DistributePreview } from '../maintenance/DistributePreview';
import { ShortcutsHelp } from './ShortcutsHelp';

type Mode =
  | { kind: 'capture'; defaults?: Partial<NewTask> }
  | { kind: 'palette'; query?: string }
  | { kind: 'shortcuts' }
  | { kind: 'distribute' };

interface CommandCenterApi {
  open: (mode: Mode) => void;
  close: () => void;
}

const Ctx = createContext<CommandCenterApi>({ open: () => {}, close: () => {} });
export const useCommandCenter = () => useContext(Ctx);

export const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const GOTO: Record<string, Parameters<typeof navigate>[0]> = {
  h: { view: 'today' }, s: { view: 'week' }, b: { view: 'inbox' }, t: { view: 'board' }, c: { view: 'calendar' }, n: { view: 'notes' }, l: { view: 'log' }, v: { view: 'review' },
  e: { view: 'people' }, a: { view: 'settings' },
};

export function CommandCenterProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const open = useCallback((m: Mode) => setMode(m), []);
  const close = useCallback(() => setMode(null), []);
  const api = useMemo(() => ({ open, close }), [open, close]);
  const pendingG = useRef(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && key === 'k') { e.preventDefault(); setMode({ kind: 'capture' }); return; }
      if (mod && e.shiftKey && key === 'p') { e.preventDefault(); setMode({ kind: 'palette' }); return; }
      if (mod || e.altKey || isEditable(e.target) || document.querySelector('[role="dialog"]')) return;

      if (Date.now() - pendingG.current < 1200 && GOTO[key]) {
        e.preventDefault();
        pendingG.current = 0;
        navigate(GOTO[key]);
        return;
      }
      pendingG.current = 0;
      if (key === 'g') { pendingG.current = Date.now(); return; }
      if (e.key === '?') { e.preventDefault(); setMode({ kind: 'shortcuts' }); return; }
      if (e.key === '/') { e.preventDefault(); openSearch(); return; }
      if (key === 'n' || key === 'q') { e.preventDefault(); setMode({ kind: 'capture' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      {mode && (
        <Overlay onClose={close} wide={mode.kind === 'shortcuts'}>
          {mode.kind === 'capture' && (
            <div className="p-3">
              <CaptureInput
                large
                autoFocus
                defaults={mode.defaults}
                onDone={close}
                onCancel={close}
                onCommandMode={(query) => setMode({ kind: 'palette', query })}
              />
              <p className="mt-2 px-1 text-xs text-zinc-400">
                Enter para crear · Shift+Enter o ; para varias · <kbd>&gt;</kbd> comandos · / buscar · Esc para cerrar
              </p>
            </div>
          )}
          {mode.kind === 'palette' && (
            <Palette
              initialQuery={mode.query ?? ''}
              onClose={close}
              onBackToCapture={() => setMode({ kind: 'capture' })}
              openCapture={() => setMode({ kind: 'capture' })}
              openShortcuts={() => setMode({ kind: 'shortcuts' })}
              openDistribute={() => setMode({ kind: 'distribute' })}
            />
          )}
          {mode.kind === 'shortcuts' && <ShortcutsHelp onClose={close} />}
          {mode.kind === 'distribute' && <DistributePreview onClose={close} />}
        </Overlay>
      )}
    </Ctx.Provider>
  );
}

function Overlay({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-[14vh] dark:bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" className={`w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900`}>
        {children}
      </div>
    </div>
  );
}

function Palette({ initialQuery, onClose, onBackToCapture, openCapture, openShortcuts, openDistribute }: {
  initialQuery: string;
  onClose: () => void;
  onBackToCapture: () => void;
  openCapture: () => void;
  openShortcuts: () => void;
  openDistribute: () => void;
}) {
  const { tasks, projects, today, settings } = useApp();
  const toast = useToast();
  const { targetsFor, selectAll } = useSelection();
  const selection = targetsFor(null);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [pendingInput, setPendingInput] = useState<Command | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo(
    () => buildCommands({ tasks, projects, today, settings, openCapture, openShortcuts, openDistribute, toast, selection, selectAll }),
    [tasks, projects, today, settings, openCapture, openShortcuts, openDistribute, toast, selection, selectAll],
  );

  const results = useMemo(() => {
    if (pendingInput) return [];
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, `${c.title} ${c.keywords ?? ''}`) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score! - a.score!)
      .map((x) => x.c);
  }, [commands, query, pendingInput]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  async function execute(c: Command | undefined) {
    if (!c) return;
    if (c.input) { setPendingInput(c); setQuery(''); return; }
    const keepsOpen = c.id === 'new-task' || c.id === 'shortcuts' || c.id === 'distribute';
    if (!keepsOpen) onClose();
    await c.run?.();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(results.length, 1);
      setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pendingInput) { onClose(); void pendingInput.input!.run(query); }
      else void execute(results[selected]);
    } else if (e.key === 'Backspace' && query === '') {
      e.preventDefault();
      if (pendingInput) setPendingInput(null); else onBackToCapture();
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-700">
        <span className="text-zinc-400">{pendingInput ? `${pendingInput.title}:` : '>'}</span>
        <input
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          onKeyDown={onKeyDown}
          placeholder={pendingInput ? pendingInput.input!.placeholder : 'Buscar comando…'}
          aria-label="Buscar comando"
          className="w-full bg-transparent py-3 text-base outline-none placeholder:text-zinc-400"
        />
      </div>
      {!pendingInput && (
        <ul ref={listRef} role="listbox" className="max-h-80 overflow-y-auto py-1">
          {results.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => void execute(c)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 text-sm ${i === selected ? 'bg-indigo-50 dark:bg-indigo-900/40' : ''}`}
            >
              <span className="flex-1">{c.title}</span>
              <span className="text-xs text-zinc-400">{c.section}</span>
              {c.shortcut && <kbd className="rounded border border-zinc-200 px-1.5 text-[10px] text-zinc-500 dark:border-zinc-700">{c.shortcut}</kbd>}
            </li>
          ))}
          {results.length === 0 && <li className="px-4 py-3 text-sm text-zinc-400">Ningún comando coincide.</li>}
        </ul>
      )}
      {pendingInput && <p className="px-4 py-3 text-xs text-zinc-400">Enter para confirmar · Retroceso para volver</p>}
    </div>
  );
}
