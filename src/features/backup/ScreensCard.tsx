import { useEffect, useState } from 'react';
import { Eye, EyeOff, LayoutGrid, RotateCcw } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { sync, useSync, type AdminUser } from '../../data/sync';
import { HIDDEN_FOR_ALL, SCREENS } from '../../domain/screens';

const button = 'inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

/**
 * Ajustes → Pantallas (solo administradores; migración 013): qué pantallas ve cada persona. Una fila por cuenta y una
 * columna por pantalla; la fila «Por defecto» vale para las cuentas nuevas y para las que no tienen las suyas. Hoy y
 * Ajustes siempre se ven.
 */
export function ScreensCard() {
  const { user } = useSync();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await sync().adminData();
      setUsers(r.users.filter((u) => !u.disabled));
      setDefaults(r.defaultHiddenScreens ?? []);
      if (!r.users.some((u) => 'hiddenScreens' in u)) setError('Falta preparar las pantallas en Supabase: un administrador tiene que ejecutar supabase/migrations/013_pantallas.sql.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hiddenOf = (u: AdminUser) => u.hiddenScreens ?? defaults;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const cell = (key: string, visible: boolean, onClick: () => void, label: string) => (
    <td key={key} className="px-1 py-1 text-center">
      <button type="button" disabled={busy} onClick={onClick} aria-pressed={visible} aria-label={label} title={label}
        className={`inline-flex size-7 items-center justify-center rounded-md border ${visible
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
          : 'border-zinc-200 text-zinc-300 dark:border-zinc-700 dark:text-zinc-600'} hover:opacity-80`}>
        {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </td>
  );

  return (
    <section className="mb-4 rounded-lg border border-indigo-200 p-4 dark:border-indigo-900">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><LayoutGrid className="size-4 text-indigo-500" />Pantallas</h2>
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Qué pantallas ve cada persona en la app (solo lo ven los administradores). Ocultar una quita su entrada de la barra lateral y no deja
        abrirla, pero no cambia qué datos ve nadie. Hoy y Ajustes siempre se ven. La fila «Por defecto» vale para las cuentas nuevas y para las
        que no tienen las suyas. Los cambios le llegan a cada persona en menos de un minuto.
      </p>
      {HIDDEN_FOR_ALL.length > 0 && (
        <p className="mb-3 rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          Apagadas para todo el mundo desde el código, digan lo que digan estas casillas: {SCREENS.filter((s) => HIDDEN_FOR_ALL.includes(s.id)).map((s) => s.label).join(', ')}.
        </p>
      )}
      {error && <p className="mb-3 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-xs text-zinc-500">
              <th className="py-1 pr-2 text-left font-medium">Persona</th>
              {SCREENS.map((s) => <th key={s.id} className="px-1 py-1 text-center font-medium" title={s.hint}>{s.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-zinc-200 bg-indigo-50/50 dark:border-zinc-800 dark:bg-indigo-950/30">
              <td className="py-1.5 pr-2">
                <div className="font-medium">Por defecto</div>
                <div className="text-xs text-zinc-500">cuentas nuevas y las que no se han tocado</div>
              </td>
              {SCREENS.map((s) => cell(s.id, !defaults.includes(s.id),
                () => void run(() => sync().setDefaultScreens(toggle(defaults, s.id))),
                `${defaults.includes(s.id) ? 'Mostrar' : 'Ocultar'} ${s.label} por defecto`))}
              <td className="py-1.5 pl-2">
                <button type="button" className={button} disabled={busy || users.every((u) => u.hiddenScreens == null)}
                  onClick={() => { if (confirm('¿Aplicar las pantallas por defecto a todas las cuentas? Se pierden las que se hayan elegido a mano.')) void run(() => sync().setScreens(users.map((u) => u.id), null), 'Todas las cuentas usan las pantallas por defecto'); }}>
                  Aplicar a todas
                </button>
              </td>
            </tr>
            {users.map((u) => {
              const hidden = hiddenOf(u);
              return (
                <tr key={u.id} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium">{u.name}{u.id === user?.id && ' (tú)'}{u.isAdmin && <span className="ml-1 text-xs font-normal text-indigo-600 dark:text-indigo-400">admin</span>}</div>
                    <div className="text-xs text-zinc-500">{u.hiddenScreens == null ? 'por defecto' : 'elegidas a mano'}</div>
                  </td>
                  {SCREENS.map((s) => cell(s.id, !hidden.includes(s.id),
                    () => void run(() => sync().setScreens([u.id], toggle(hidden, s.id))),
                    `${hidden.includes(s.id) ? 'Mostrar' : 'Ocultar'} ${s.label} a ${u.name}`))}
                  <td className="py-1.5 pl-2">
                    {u.hiddenScreens != null && (
                      <button type="button" className={button} disabled={busy} title="Volver a las pantallas por defecto"
                        onClick={() => void run(() => sync().setScreens([u.id], null), `${u.name} usa las pantallas por defecto`)}>
                        <RotateCcw className="size-3" />Por defecto
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
