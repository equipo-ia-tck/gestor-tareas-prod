import { useEffect, useRef, useState } from 'react';
import { AlarmClock, Check, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { MenuItem, Popover } from '../../components/ui/Popover';
import { repo } from '../../data/services';
import { formatDay } from '../../domain/dates';
import { dueReminders, formatReminder, nextReminderAt, quickReminders } from '../../domain/reminders';
import { showNotification } from './notifications';

const CHECK_MS = 15_000;

/**
 * Vigila los recordatorios mientras la app está abierta: notificación del sistema al llegar la hora
 * y aviso en la app hasta que se atiende. Los que vencieron con la app cerrada aparecen al abrirla.
 */
export function ReminderCenter() {
  const { tasks, editTask } = useApp();
  const [now, setNow] = useState(() => new Date());
  const notified = useRef(new Set<string>());

  // Revisión periódica y temporizador exacto hasta el siguiente aviso.
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), CHECK_MS);
    const next = nextReminderAt(tasks, new Date());
    const exact = next ? setTimeout(() => setNow(new Date()), Math.min(Date.parse(next) - Date.now() + 200, 2 ** 31 - 1)) : undefined;
    return () => { clearInterval(tick); if (exact) clearTimeout(exact); };
  }, [tasks]);

  const due = dueReminders(tasks, now);

  useEffect(() => {
    for (const t of due) {
      const key = `${t.id}@${t.remind_at}`;
      if (notified.current.has(key)) continue;
      notified.current.add(key);
      // Solo notificación del sistema para los que vencen ahora (no para los atrasados al abrir).
      if (now.getTime() - Date.parse(t.remind_at!) < 5 * 60_000) showNotification('⏰ Recordatorio', t.title, () => editTask(t));
    }
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = due.length ? `(${due.length}) ${base}` : base;
  }, [due, now, editTask]);

  if (!due.length) return null;

  const snooze = (id: string, at: string) => void repo.batch('Recordatorio pospuesto', () => repo.updateTask(id, { remind_at: at }));
  const dismiss = (id: string) => void repo.batch('Recordatorio descartado', () => repo.updateTask(id, { remind_at: null }));

  return (
    <section aria-label="Recordatorios" className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 dark:border-orange-900 dark:bg-orange-950/40">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-orange-800 dark:text-orange-200">
        <AlarmClock className="size-4" />Recordatorios · {due.length}
      </h2>
      <ul className="space-y-1">
        {due.map((t) => {
          const late = now.getTime() - Date.parse(t.remind_at!) > 5 * 60_000;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" onClick={() => editTask(t)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">{t.title}</button>
              <span className="text-xs text-orange-700 dark:text-orange-300">{late ? 'se pasó ' : ''}{formatReminder(t.remind_at!, now, formatDay).toLowerCase()}</span>
              <button type="button" title="Completar" onClick={() => void repo.batch('Tarea completada', async () => { await repo.setCompleted(t.id, true); await repo.updateTask(t.id, { remind_at: null }); })}
                className="flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-xs hover:bg-emerald-50 dark:bg-zinc-900 dark:hover:bg-emerald-900/60"><Check className="size-3" />Hecha</button>
              <Popover align="right" width="w-48" trigger={(toggle) => (
                <button type="button" onClick={toggle} className="rounded-md bg-white px-2 py-0.5 text-xs hover:bg-orange-100 dark:bg-zinc-900 dark:hover:bg-orange-900/60">Posponer ▾</button>
              )}>
                {(close) => [{ label: 'En 10 minutos', at: new Date(Date.now() + 10 * 60_000).toISOString() }, ...quickReminders(new Date())].map((o) => (
                  <MenuItem key={o.label} onClick={() => { close(); snooze(t.id, o.at); }}>{o.label}</MenuItem>
                ))}
              </Popover>
              <button type="button" title="Descartar aviso" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-orange-700 hover:bg-orange-100 dark:text-orange-300"><X className="size-3.5" /></button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
