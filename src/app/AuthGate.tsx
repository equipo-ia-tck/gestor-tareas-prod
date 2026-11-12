import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { repo } from '../data/services';
import { sync, type SessionState } from '../data/sync';
import { SPACES_ENABLED } from '../domain/spaces';

type Phase = 'loading' | 'down' | 'login' | 'forgot' | 'profile' | 'disabled' | 'confirm' | 'recovery' | 'ask-upload' | 'ready';

/** Si se vuelve de un enlace de email caducado o ya usado, Supabase lo dice en la dirección (#error_description=…). */
function linkError(): boolean {
  const params = new URLSearchParams(location.hash.replace(/^#/, '') || location.search.replace(/^\?/, ''));
  if (!params.get('error_description') && !params.get('error_code')) return false;
  history.replaceState(null, '', location.pathname);
  return true;
}
const EXPIRED_LINK = typeof location !== 'undefined' && linkError();

/** Pide sesión antes de abrir la app y, la primera vez en este navegador, decide qué hacer con sus datos. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [counts, setCounts] = useState({ tasks: 0, notes: 0 });
  const [forgot, setForgot] = useState({ email: '', expired: false });

  const open = async () => {
    await sync().start();
    void repo.purgeDeleted(30);
    setPhase('ready');
  };
  const enter = async () => {
    const step = await sync().prepare();
    if (step === 'ask-upload') {
      setCounts({ tasks: await repo.db.tasks.count(), notes: await repo.db.notes.count() });
      return setPhase('ask-upload');
    }
    await open();
  };
  const after = async (state: SessionState | 'confirm') => {
    if (state === 'ok') return enter();
    setPhase(state === 'none' ? 'login' : state);
  };
  const check = async () => {
    setPhase('loading');
    try {
      await after(await sync().session());
    } catch {
      setPhase('down');
    }
  };
  useEffect(() => {
    // Al volver del email de "olvidé mi contraseña", Supabase avisa para pedir la nueva.
    const { data } = sync().supabase.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') setPhase('recovery'); });
    if (EXPIRED_LINK) {
      setForgot({ email: '', expired: true });
      setPhase('forgot');
    } else void check();
    return () => data.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'ready') return <>{children}</>;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white">✓</span>
          <span className="font-semibold">Tareas del equipo</span>
        </div>
        {phase === 'loading' && <p className="text-sm text-zinc-500">Conectando…</p>}
        {phase === 'down' && (
          <div className="space-y-3 text-sm">
            <p>No se puede conectar con la base de datos del equipo.</p>
            <p className="text-zinc-500">Comprueba tu conexión a internet y vuelve a intentarlo.</p>
            <button type="button" onClick={() => void check()} className={primary}>Reintentar</button>
          </div>
        )}
        {phase === 'login' && <LoginForm onDone={(s) => void after(s)} onForgot={(email) => { setForgot({ email, expired: false }); setPhase('forgot'); }} />}
        {phase === 'forgot' && <ForgotForm initial={forgot.email} expired={forgot.expired} onDone={(s) => void after(s)} onBack={() => setPhase('login')} />}
        {phase === 'profile' && <ProfileForm onDone={(s) => void after(s)} />}
        {phase === 'confirm' && (
          <div className="space-y-3 text-sm">
            <p>Te hemos enviado un email para confirmar la cuenta.</p>
            <p className="text-zinc-500">Ábrelo, pulsa el enlace y vuelve aquí para entrar. Te pediremos tu nombre y la invitación.</p>
            <button type="button" onClick={() => setPhase('login')} className={primary}>Ir a entrar</button>
          </div>
        )}
        {phase === 'disabled' && (
          <div className="space-y-3 text-sm">
            <p>Esta cuenta está desactivada.</p>
            <p className="text-zinc-500">Habla con quien administra la herramienta.</p>
            <button type="button" onClick={() => void sync().supabase.auth.signOut().then(() => setPhase('login'))} className={secondary}>Salir</button>
          </div>
        )}
        {phase === 'recovery' && <RecoveryForm onDone={() => void check()} />}
        {phase === 'ask-upload' && (
          <UploadQuestion counts={counts} onUpload={async () => { await sync().uploadAll(); await open(); }}
            onEmpty={async () => { await sync().startEmpty(); await open(); }} />
        )}
      </div>
    </div>
  );
}

const input = 'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950';
const primary = 'w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60';
const secondary = 'w-full rounded-md border border-zinc-300 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800';

interface FieldProps { id: string; value: string; onChange: (e: { target: { value: string } }) => void }

function useForm<K extends string>(initial: Record<K, string>) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: K): FieldProps => ({ id: `auth-${k}`, value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo hacer.');
    } finally {
      setBusy(false);
    }
  };
  return { form, field, error, info, setInfo, busy, run };
}

function LoginForm({ onDone, onForgot }: { onDone: (s: SessionState | 'confirm') => void; onForgot: (email: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const { form, field, error, busy, run } = useForm({ login: '', password: '', name: '', code: '' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onDone(mode === 'login' ? await sync().login(form.login, form.password) : await sync().register(form)));
  };
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <div className="grid grid-cols-2 rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
        {(['login', 'register'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            className={`rounded px-2 py-1.5 ${mode === m ? 'bg-white font-medium shadow-sm dark:bg-zinc-950' : 'text-zinc-500'}`}>
            {m === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>
        ))}
      </div>
      {mode === 'register' && <NameField field={field('name')} />}
      <label className="block space-y-1" htmlFor="auth-login">
        <span className="text-zinc-600 dark:text-zinc-400">Email</span>
        <input {...field('login')} required type="email" autoComplete="username" autoCapitalize="none" placeholder="tu email del trabajo" className={input} />
      </label>
      <label className="block space-y-1" htmlFor="auth-password">
        <span className="text-zinc-600 dark:text-zinc-400">Contraseña</span>
        <input {...field('password')} required type="password" minLength={mode === 'register' ? 8 : undefined}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className={input} />
      </label>
      {mode === 'register' && SPACES_ENABLED && <CodeField field={field('code')} />}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className={primary}>
        {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta y entrar'}
      </button>
      {mode === 'login' && (
        <button type="button" onClick={() => onForgot(form.login)} className="w-full text-center text-xs text-indigo-600 hover:underline dark:text-indigo-400">
          ¿Olvidaste la contraseña?
        </button>
      )}
    </form>
  );
}

function NameField({ field }: { field: FieldProps }) {
  return (
    <label className="block space-y-1" htmlFor={field.id}>
      <span className="text-zinc-600 dark:text-zinc-400">Tu nombre completo</span>
      <input {...field} required autoComplete="name" placeholder="Marta García" className={input} />
      <span className="block text-xs text-zinc-500">Si alguien te pone en «Personas» de una tarea (o te menciona en una nota) con este nombre o tu email, te la comparte.</span>
    </label>
  );
}

function CodeField({ field }: { field: FieldProps }) {
  return (
    <label className="block space-y-1" htmlFor={field.id}>
      <span className="text-zinc-600 dark:text-zinc-400">Invitación</span>
      <input {...field} autoCapitalize="characters" placeholder="ABCD-1234" className={input} />
      <span className="block text-xs text-zinc-500">El código de invitación de tu espacio: te lo pasa alguien que ya está dentro (Ajustes → Espacios). La primera cuenta del equipo no lo necesita.</span>
    </label>
  );
}

/** Cuenta creada (y email confirmado) pero sin alta en el equipo: nombre e invitación. */
function ProfileForm({ onDone }: { onDone: (s: SessionState) => void }) {
  const { form, field, error, busy, run } = useForm({ name: '', code: '' });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => onDone(await sync().completeProfile(form.name, form.code))); }} className="space-y-3 text-sm">
      <p>Completa tu alta en el equipo.</p>
      <NameField field={field('name')} />
      {SPACES_ENABLED && <CodeField field={field('code')} />}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className={primary}>{busy ? 'Un momento…' : 'Entrar'}</button>
      <button type="button" onClick={() => void sync().supabase.auth.signOut().then(() => location.reload())} className={secondary}>Usar otra cuenta</button>
    </form>
  );
}

const RESEND_SECONDS = 60;
const LAST_EMAIL = 'gestor-tareas:last-recovery-email';
const lastEmail = () => { try { return localStorage.getItem(LAST_EMAIL) ?? ''; } catch { return ''; } };

/**
 * Olvidé mi contraseña: se envía un email con un código y se escribe aquí con la contraseña nueva, sin salir de la
 * pantalla (el enlace del mismo email también funciona). Si el email no llega, un administrador puede dar una
 * contraseña provisional.
 */
function ForgotForm({ initial, expired, onDone, onBack }: { initial: string; expired: boolean; onDone: (s: SessionState) => void; onBack: () => void }) {
  const { form, field, error, info, setInfo, busy, run } = useForm({ login: initial || lastEmail(), code: '', password: '', repeat: '' });
  const [sent, setSent] = useState(false);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const send = () => void run(async () => {
    if (!form.login.trim()) throw new Error('Escribe tu email.');
    await sync().sendPasswordReset(form.login);
    try { localStorage.setItem(LAST_EMAIL, form.login.trim()); } catch { /* sin almacenamiento */ }
    setSent(true);
    setWait(RESEND_SECONDS);
    setInfo(`Te hemos enviado un email a ${form.login.trim()} con un código.`);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sent) return send();
    void run(async () => {
      if (form.password !== form.repeat) throw new Error('Las dos contraseñas no coinciden.');
      onDone(await sync().resetWithCode(form.login, form.code, form.password));
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <p className="font-medium">Recuperar la contraseña</p>
      {expired && !sent && <p className="text-amber-700 dark:text-amber-400">El enlace del email ya no vale: el correo de empresa a veces lo abre antes para revisarlo y lo gasta. Pide un código y escríbelo aquí.</p>}
      <label className="block space-y-1" htmlFor="auth-login">
        <span className="text-zinc-600 dark:text-zinc-400">Email</span>
        <input {...field('login')} required type="email" autoComplete="username" autoCapitalize="none" readOnly={sent} className={input} />
      </label>
      {sent && (
        <>
          {info && <p className="text-emerald-700 dark:text-emerald-400">{info}</p>}
          <label className="block space-y-1" htmlFor="auth-code">
            <span className="text-zinc-600 dark:text-zinc-400">Código del email</span>
            <input {...field('code')} required inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className={`${input} tracking-widest`} />
            <span className="block text-xs text-zinc-500">Usa el código del último email (al pedir otro, los anteriores dejan de valer). Si solo trae un enlace, ábrelo en este navegador nada más llegar; si dice que ya no vale, pide una contraseña provisional a un administrador.</span>
          </label>
          <label className="block space-y-1" htmlFor="auth-password">
            <span className="text-zinc-600 dark:text-zinc-400">Contraseña nueva</span>
            <input {...field('password')} required type="password" minLength={8} autoComplete="new-password" placeholder="Mínimo 8 caracteres" className={input} />
          </label>
          <label className="block space-y-1" htmlFor="auth-repeat">
            <span className="text-zinc-600 dark:text-zinc-400">Repítela</span>
            <input {...field('repeat')} required type="password" minLength={8} autoComplete="new-password" className={input} />
          </label>
        </>
      )}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className={primary}>
        {busy ? 'Un momento…' : sent ? 'Guardar y entrar' : 'Enviarme un código'}
      </button>
      {sent && (
        <button type="button" disabled={busy || wait > 0} onClick={send} className={secondary}>
          {wait > 0 ? `Reenviar el código (${wait} s)` : 'Reenviar el código'}
        </button>
      )}
      <p className="text-xs text-zinc-500">
        ¿No llega? Mira en correo no deseado (lo envía Supabase). Si sigue sin llegar, pide a un administrador una contraseña
        provisional (Ajustes → Administración).
      </p>
      <button type="button" onClick={onBack} className="w-full text-center text-xs text-indigo-600 hover:underline dark:text-indigo-400">Volver a entrar</button>
    </form>
  );
}

/** Al volver del enlace del email de "olvidé mi contraseña". */
function RecoveryForm({ onDone }: { onDone: () => void }) {
  const { field, error, busy, run, form } = useForm({ password: '', repeat: '' });
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        if (form.password !== form.repeat) throw new Error('Las dos contraseñas no coinciden.');
        await sync().setNewPassword(form.password);
        onDone();
      });
    }} className="space-y-3 text-sm">
      <p>Elige tu contraseña nueva.</p>
      <input {...field('password')} required type="password" minLength={8} autoComplete="new-password" placeholder="Mínimo 8 caracteres" aria-label="Contraseña nueva" className={input} />
      <input {...field('repeat')} required type="password" minLength={8} autoComplete="new-password" placeholder="Repítela" aria-label="Repite la contraseña" className={input} />
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className={primary}>{busy ? 'Un momento…' : 'Guardar y entrar'}</button>
    </form>
  );
}

function UploadQuestion({ counts, onUpload, onEmpty }: {
  counts: { tasks: number; notes: number }; onUpload: () => Promise<void>; onEmpty: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => { setBusy(true); void fn().finally(() => setBusy(false)); };
  return (
    <div className="space-y-3 text-sm">
      <p>
        En este navegador hay <strong>{counts.tasks} tareas</strong> y <strong>{counts.notes} notas</strong> que aún no están en tu cuenta.
      </p>
      <p className="text-zinc-500">Si las subes, se suman a lo que ya tenga tu cuenta y pasan a ser tuyas y privadas. Solo las verá alguien si las pones en un espacio o le mencionas.</p>
      <button type="button" disabled={busy} onClick={() => run(onUpload)} className={primary}>{busy ? 'Subiendo…' : 'Subirlas a mi cuenta'}</button>
      <button type="button" disabled={busy} onClick={() => run(onEmpty)} className={secondary}>Empezar vacía</button>
      <p className="text-xs text-zinc-500">Si empiezas vacía, antes se descarga una copia de lo que había en un archivo.</p>
    </div>
  );
}
