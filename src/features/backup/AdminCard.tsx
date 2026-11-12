import { useEffect, useState } from 'react';
import { Ban, KeyRound, LogIn, RefreshCw, Shield, ShieldOff, UserCheck } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { sync, useSync, type AdminSpace, type AdminUser } from '../../data/sync';
import { SPACES_ENABLED } from '../../domain/spaces';

const button = 'inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

/** Administración de la herramienta: cuentas, roles, espacios y código de administración. Solo administradores. */
export function AdminCard() {
  const { user, spaces: mySpaces } = useSync();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [spaces, setSpaces] = useState<AdminSpace[]>([]);
  const [adminCode, setAdminCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [provisional, setProvisional] = useState<{ name: string; login: string; password: string } | null>(null);

  const load = async () => {
    try {
      const r = await sync().adminData();
      setUsers(r.users);
      setSpaces(r.spaces);
      setAdminCode(r.adminCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la administración.');
    }
  };
  useEffect(() => { void load(); }, [mySpaces.length]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      await load();
      if (done) toast(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo hacer.');
    }
  };
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? '—';
  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? '';

  return (
    <section className="mb-4 rounded-lg border border-indigo-200 p-4 dark:border-indigo-900">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><Shield className="size-4 text-indigo-500" />Administración</h2>
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Solo lo ven los administradores. Quien crea una cuenta entra como usuario normal: usa la herramienta pero no administra
        cuentas ni la configuración común (tipos, estados y colores de etiquetas). Para hacer administrador a alguien, «Hacer admin».
      </p>

      <h3 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Cuentas · {users.length}</h3>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="py-1 pr-2 font-medium">Persona</th>
              <th className="py-1 pr-2 font-medium">Rol</th>
              {SPACES_ENABLED && <th className="py-1 pr-2 font-medium">Espacios</th>}
              <th className="py-1 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={`border-t border-zinc-200 align-top dark:border-zinc-800 ${u.disabled ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2">
                  <div className="font-medium">{u.name}{u.id === user?.id && ' (tú)'}</div>
                  <div className="text-xs text-zinc-500">{u.login}</div>
                </td>
                <td className="py-1.5 pr-2">
                  {u.disabled ? <span className="text-xs text-red-600">Desactivada</span>
                    : u.isAdmin ? <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"><Shield className="size-3" />Administrador</span>
                    : <span className="text-xs text-zinc-500">Usuario</span>}
                </td>
                {SPACES_ENABLED && <td className="py-1.5 pr-2 text-xs text-zinc-600 dark:text-zinc-400">{u.spaces.map(spaceName).filter(Boolean).join(', ') || '—'}</td>}
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {!u.disabled && (u.isAdmin
                      ? <button type="button" className={button} onClick={() => void run(() => sync().setAdmin(u.id, false), `${u.name} ya no es administrador`)}><ShieldOff className="size-3" />Quitar admin</button>
                      : <button type="button" className={button} onClick={() => void run(() => sync().setAdmin(u.id, true), `${u.name} es administrador`)}><Shield className="size-3" />Hacer admin</button>)}
                    {u.id !== user?.id && (
                      <button type="button" className={button} title="Crea una contraseña nueva para pasársela a la persona (se ve una vez)"
                        onClick={() => void run(async () => setProvisional({ name: u.name, login: u.login, password: await sync().setProvisionalPassword(u.id) }))}>
                        <KeyRound className="size-3" />Contraseña provisional
                      </button>
                    )}
                    {u.id !== user?.id && (u.disabled
                      ? <button type="button" className={button} onClick={() => void run(() => sync().setDisabled(u.id, false), 'Cuenta reactivada')}><UserCheck className="size-3" />Reactivar</button>
                      : <button type="button" className={button} onClick={() => void run(() => sync().setDisabled(u.id, true), 'Cuenta desactivada')}><Ban className="size-3" />Desactivar</button>)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {provisional && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p>
            Contraseña provisional de <strong>{provisional.name}</strong> ({provisional.login}):{' '}
            <code className="rounded bg-white px-1.5 py-0.5 font-semibold dark:bg-zinc-900">{provisional.password}</code>
          </p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Solo se ve ahora. Pásasela por Teams; entra con ella y la cambia en Ajustes → Mi cuenta. Sus sesiones abiertas se han cerrado.
          </p>
          <div className="mt-2 flex gap-1.5">
            <button type="button" className={button} onClick={() => void navigator.clipboard.writeText(provisional.password).then(() => toast('Contraseña copiada'), () => undefined)}>Copiar</button>
            <button type="button" className={button} onClick={() => setProvisional(null)}>Hecho</button>
          </div>
        </div>
      )}

      {SPACES_ENABLED && <>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Todos los espacios · {spaces.length}</h3>
      <ul className="mb-4 space-y-1 text-sm">
        {spaces.map((s) => {
          const member = mySpaces.some((m) => m.id === s.id);
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} />
              <strong>{s.name}</strong>
              <span className="text-xs text-zinc-500">{s.members.map((m) => `${nameOf(m.id)}${m.role === 'admin' ? ' (admin)' : ''}`).join(', ')}</span>
              {!member && (
                <button type="button" className={button} title="Te unes como administradora para gestionarlo o ver su contenido"
                  onClick={() => void run(() => sync().adminJoinSpace(s.id), `Ahora estás en ${s.name}`)}>
                  <LogIn className="size-3" />Entrar
                </button>
              )}
            </li>
          );
        })}
        {!spaces.length && <li className="text-zinc-500">Aún no hay espacios. Crea uno en «Espacios de equipo».</li>}
      </ul>

      <h3 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Código de administración</h3>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{adminCode}</code>
        <button type="button" className={button} onClick={() => void run(() => sync().regenerateAdminCode(), 'Código cambiado: el anterior ya no vale')}>
          <RefreshCw className="size-3" />Cambiar
        </button>
        <span className="text-xs text-zinc-500">Crea cuentas de administrador. No lo compartas: a la gente invítala a un espacio.</span>
      </p>
      </>}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
