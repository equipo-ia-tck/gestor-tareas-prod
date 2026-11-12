import { useState, type FormEvent } from 'react';
import { Copy, LogOut, RefreshCw, Shield, UserMinus, UserX } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { Popover } from '../../components/ui/Popover';
import { downloadBackup } from '../../data/backup';
import { repo } from '../../data/services';
import { sync, useSync } from '../../data/sync';
import { PROJECT_COLORS } from '../../domain/types';
import { SPACES_ENABLED, type Space } from '../../domain/spaces';

const button = 'inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';
const field = 'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';

/** Espacios de equipo: miembros, invitación, crear, unirse y salir. Y la cuenta (cerrar sesión). */
export function SpacesCard() {
  const { user, spaces, isAdmin } = useSync();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo hacer.');
    }
  };

  return (
    <section className="mb-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      {SPACES_ENABLED && <>
      <h2 className="mb-2 text-sm font-semibold">Espacios de equipo</h2>
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Lo tuyo es privado. Un proyecto que pones en un espacio (desde la página del proyecto) lo ven y editan todos sus
        miembros, con sus subproyectos. Además, al poner a una cuenta en «Personas» de una tarea (o mencionarla con @ en una
        nota) se le comparte eso suelto. «Mi día», recordatorios, fichas y ajustes son siempre solo tuyos.
      </p>

      <div className="space-y-3">
        {spaces.map((s) => <SpaceItem key={s.id} space={s} run={run} />)}
        {!spaces.length && <p className="text-sm text-zinc-500">Aún no estás en ningún espacio.</p>}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {isAdmin ? <CreateSpace run={run} /> : <p className="text-xs text-zinc-500">Los espacios nuevos los crean los administradores.</p>}
        <JoinSpace run={run} />
      </div>
      </>}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className={SPACES_ENABLED ? 'mt-4 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-700' : 'text-sm'}>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Mi cuenta</h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-zinc-500">
            <strong className="text-zinc-800 dark:text-zinc-200">{user?.name}</strong> ({user?.login}) · {isAdmin ? 'Administrador' : 'Usuario'}
          </span>
          <button type="button" onClick={() => void sync().logout()} className={button}><LogOut className="size-3.5" />Cerrar sesión</button>
        </div>
        <ChangePassword run={run} />
        <DeleteAccount login={user?.login ?? ''} />
      </div>
    </section>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

function SpaceItem({ space, run }: { space: Space; run: Run }) {
  const { user, team } = useSync();
  const toast = useToast();
  const admin = space.role === 'admin';
  const nameOf = (id: string) => team.find((u) => u.id === id)?.name ?? 'Cuenta borrada';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(space.inviteCode);
      toast('Código copiado');
    } catch {
      toast(`Código: ${space.inviteCode}`);
    }
  };
  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2">
        {admin
          ? <ColorPicker color={space.color} onPick={(c) => void run(() => sync().updateSpace(space.id, { color: c }), 'Color cambiado')} size="size-3.5" />
          : <span className="size-3 rounded-full" style={{ background: space.color }} />}
        <strong className="text-sm">{space.name}</strong>
        <span className="text-xs text-zinc-500">{admin ? 'Administras' : 'Miembro'} · {space.members.length} {space.members.length === 1 ? 'persona' : 'personas'}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button type="button" onClick={() => void copy()} className={button} title="Pásalo a quien quieras invitar">
            <Copy className="size-3.5" />Invitación <code className="text-xs">{space.inviteCode}</code>
          </button>
          {admin && (
            <button type="button" title="El código anterior deja de valer" className={button}
              onClick={() => void run(() => sync().updateSpace(space.id, { newCode: true }), 'Código nuevo creado')}>
              <RefreshCw className="size-3.5" />Cambiar código
            </button>
          )}
          <button type="button" className={button} onClick={() => void run(() => sync().leaveSpace(space.id), `Has salido de ${space.name}`)}>
            Salir
          </button>
        </span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
        {space.members.map((m) => (
          <li key={m.id} className="flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 dark:bg-zinc-800">
            {nameOf(m.id)}{m.id === user?.id && ' (tú)'}
            {m.role === 'admin' && <Shield className="size-3 text-indigo-500" aria-label="Administra" />}
            {admin && m.id !== user?.id && (
              <>
                <button type="button" title={m.role === 'admin' ? 'Quitar como administradora' : 'Hacer administradora'} className="rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  onClick={() => void run(() => sync().setRole(space.id, m.id, m.role === 'admin' ? 'member' : 'admin'))}>
                  <Shield className="size-3" />
                </button>
                <button type="button" title="Quitar del espacio" className="rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  onClick={() => void run(() => sync().removeMember(space.id, m.id), `${nameOf(m.id)} ya no está en ${space.name}`)}>
                  <UserMinus className="size-3" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateSpace({ run }: { run: Run }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => { await sync().createSpace(name.trim(), color); setName(''); }, 'Espacio creado');
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor="space-name" className="block text-xs text-zinc-500">Crear un espacio (p. ej. Excelencia, Pagos)</label>
      <div className="flex gap-1.5">
        <input id="space-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del espacio" className={`${field} min-w-0 flex-1`} />
        <ColorPicker color={color} onPick={setColor} size="size-8 border border-zinc-200 dark:border-zinc-700" />
        <button type="submit" className={button}>Crear</button>
      </div>
    </form>
  );
}

function JoinSpace({ run }: { run: Run }) {
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void run(async () => { await sync().joinSpace(code.trim()); setCode(''); }, 'Te has unido al espacio');
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor="space-code" className="block text-xs text-zinc-500">Unirme a un espacio con su invitación</label>
      <div className="flex gap-1.5">
        <input id="space-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-1234" className={`${field} min-w-0 flex-1 uppercase`} />
        <button type="submit" className={button}>Unirme</button>
      </div>
    </form>
  );
}

function ChangePassword({ run }: { run: Run }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await sync().changePassword(current, next); setCurrent(''); setNext(''); }, 'Contraseña cambiada');
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <label className="space-y-1" htmlFor="pw-current">
        <span className="block text-xs text-zinc-500">Contraseña actual</span>
        <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required className={field} />
      </label>
      <label className="space-y-1" htmlFor="pw-new">
        <span className="block text-xs text-zinc-500">Nueva (mín. 8 caracteres)</span>
        <input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required className={field} />
      </label>
      <button type="submit" className={button}>Cambiar contraseña</button>
    </form>
  );
}

/** Darse de baja: lo privado se borra, lo de los espacios se queda para el equipo. Antes se descarga una copia. */
function DeleteAccount({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed.trim().toLowerCase() === login.toLowerCase();
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadBackup(repo);
      await sync().deleteAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo dar de baja.');
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-4 flex items-center gap-1.5 text-xs text-red-600 hover:underline dark:text-red-400">
        <UserX className="size-3.5" />Darme de baja
      </button>
    );
  }
  return (
    <div className="mt-4 space-y-2 rounded-md border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/30">
      <p className="font-medium text-red-700 dark:text-red-300">Darme de baja</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
        <li>Se borran tu cuenta y todo lo privado: tareas, notas y proyectos que no están en un espacio, fichas y ajustes.</li>
        <li>Lo que está en un espacio se queda para el equipo.</li>
        <li>Si eres la única persona que administra un espacio, pasa a administrarlo otra del espacio.</li>
        <li>Antes se descarga una copia de tus datos en un archivo. No se puede deshacer.</li>
      </ul>
      <label className="block space-y-1" htmlFor="delete-confirm">
        <span className="block text-xs text-zinc-500">Escribe tu email ({login}) para confirmar</span>
        <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className={`${field} w-full max-w-sm`} />
      </label>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-1.5">
        <button type="button" disabled={!ok || busy} onClick={() => void confirm()}
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
          {busy ? 'Dando de baja…' : 'Borrar mi cuenta'}
        </button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setError(null); }} className={button}>Cancelar</button>
      </div>
    </div>
  );
}

/** Punto de color que abre la paleta (un <select> no pinta los colores de las opciones en Mac). */
function ColorPicker({ color, onPick, size }: { color: string; onPick: (c: string) => void; size: string }) {
  return (
    <Popover width="w-auto" trigger={(toggle) => (
      <button type="button" onClick={toggle} title="Color" aria-label="Color" className={`${size} shrink-0 rounded-full`} style={{ background: color }} />
    )}>
      {(close) => (
        <div className="grid grid-cols-5 gap-1.5 p-2">
          {PROJECT_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => { onPick(c); close(); }}
              className={`size-5 rounded-full ${c === color ? 'ring-2 ring-zinc-900 ring-offset-1 dark:ring-white' : ''}`} style={{ background: c }} />
          ))}
        </div>
      )}
    </Popover>
  );
}
