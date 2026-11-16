import type { Table, Transaction } from 'dexie';
import { useSyncExternalStore } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ITEM_TYPES } from '../domain/workflows';
import type { Space } from '../domain/spaces';
import type { TasksDB } from './db';
import type { Feedback, FeedbackImpact, FeedbackKind, FeedbackStatus } from '../domain/feedback';

/**
 * Sincronización con la base de datos del equipo en Supabase (supabase/migrations/001_equipo.sql).
 * La base de datos del navegador (Dexie) sigue siendo la que usa la app, así deshacer, el registro y las
 * vistas no cambian: cada cambio local se apunta con los "hooks" de Dexie y se sube con push_changes(), y
 * los cambios de los demás llegan en tiempo real (y, por si acaso, cada 30 s).
 * Las reglas de quién ve qué viven en la base de datos (RLS): la app solo recibe lo que puede ver.
 */

export const SYNC_TABLES = ['tasks', 'notes', 'projects', 'releases', 'settings', 'people', 'activity', 'item_types', 'labels'] as const;
type SyncTable = (typeof SYNC_TABLES)[number];
const OWNED: SyncTable[] = ['tasks', 'notes', 'projects', 'releases'];

export interface TeamUser { id: string; login: string; name: string }
export type SyncStatus = 'ok' | 'saving' | 'offline';

export interface SyncState {
  status: SyncStatus;
  user: TeamUser | null;
  /** Todas las cuentas activas (para mencionar a cualquiera). */
  team: TeamUser[];
  /** Espacios de los que soy miembro. */
  spaces: Space[];
  isAdmin: boolean;
  /** Código de administración (solo para quien administra). */
  adminCode: string | null;
  /** Dueño de cada registro compartido ("tasks:<id>" → id de cuenta). */
  owners: Record<string, string>;
}

/** Estado de la sesión al abrir la app. */
export type SessionState = 'none' | 'profile' | 'disabled' | 'ok';

export interface AdminUser { id: string; login: string; name: string; isAdmin: boolean; disabled: boolean; createdAt: string; spaces: string[] }
export interface AdminSpace { id: string; name: string; color: string; members: { id: string; role: 'admin' | 'member' }[] }

interface Me {
  user: TeamUser;
  disabled: boolean;
  isAdmin: boolean;
  accessVersion: number;
  team: TeamUser[];
  spaces: Space[];
  adminCode: string | null;
}
interface RecordRow { tbl: SyncTable; key: string; owner: string | null; data: Record<string, unknown> | null; version: number }
interface OverlayRow { key: string; data: { my_day?: string | null; remind_at?: string | null }; version: number }

const POLL_MS = 30_000;
const FULL_SYNC_MS = 10 * 60_000;
const PUSH_DELAY_MS = 400;
const CHUNK = 300;
const PAGE = 1000;
const PERSONAL_TASK_FIELDS = ['my_day', 'remind_at'] as const;

/** Mensajes de Supabase traducidos a algo que se entienda. */
function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Email o contraseña incorrectos.';
  if (/email not confirmed/i.test(message)) return 'Falta confirmar tu email: abre el correo que te ha llegado y vuelve a entrar.';
  if (/user already registered/i.test(message)) return 'Ya hay una cuenta con ese email y la contraseña no coincide. Entra con ella o usa «¿Olvidaste la contraseña?».';
  if (/password should be at least/i.test(message)) return 'La contraseña tiene que tener al menos 8 caracteres.';
  if (/email rate limit/i.test(message)) return 'Se han enviado demasiados emails (Supabase permite pocos por hora). Pide a un administrador una contraseña provisional.';
  if (/rate limit/i.test(message)) return 'Demasiados intentos seguidos. Espera unos minutos.';
  const wait = /only request this after (\d+) seconds/i.exec(message);
  if (wait) return `Espera ${wait[1]} segundos para pedir otro código.`;
  if (/token has expired|invalid.*token|otp/i.test(message)) return 'El código no es correcto o ha caducado. Pide otro.';
  if (/should be different from the old/i.test(message)) return 'La contraseña nueva tiene que ser distinta de la anterior.';
  if (/failed to fetch|network/i.test(message)) return 'No hay conexión con la base de datos del equipo.';
  if (/could not find the function public\.(send_feedback|admin_feedback|admin_update_feedback)\b/i.test(message))
    return 'Falta preparar el feedback en Supabase: un administrador tiene que ejecutar supabase/migrations/006_feedback.sql.';
  if (/could not find the function public\.send_feedback_form/i.test(message))
    return 'Falta actualizar el feedback en Supabase: un administrador tiene que ejecutar supabase/migrations/007_feedback_formulario.sql.';
  return message;
}

type SyncTx = Transaction & { __fromSync?: boolean };

export class SyncClient {
  private state: SyncState = { status: 'ok', user: null, team: [], spaces: [], isAdmin: false, adminCode: null, owners: {} };
  private listeners = new Set<() => void>();
  private dirty = new Map<string, { table: SyncTable; key: string }>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pushes = 0;
  private hooked = false;
  private running = false;
  private lastFull = 0;
  private accessVersion = 0;
  readonly supabase: SupabaseClient;
  private db: TasksDB;

  constructor(db: TasksDB) {
    this.db = db;
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) throw new Error('Falta la configuración de Supabase (.env: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY).');
    this.supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }

  // ---------- Estado para React ----------

  subscribe = (l: () => void) => { this.listeners.add(l); return () => void this.listeners.delete(l); };
  getState = () => this.state;
  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.supabase.rpc(fn, args);
    if (error) throw new Error(friendly(error.message));
    return data as T;
  }

  // ---------- Sesión ----------

  /** Carga la sesión y el perfil. Lanza un error si no hay conexión con Supabase. */
  async session(): Promise<SessionState> {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) throw new Error(friendly(error.message));
    if (!data.session) return 'none';
    const me = await this.rpc<Me | null>('me');
    if (!me) return 'profile';
    this.applyMe(me);
    return me.disabled ? 'disabled' : 'ok';
  }

  private applyMe(me: Me) {
    this.accessVersion = Number(me.accessVersion ?? 0);
    this.set({ user: me.user, team: me.team, spaces: me.spaces, isAdmin: me.isAdmin, adminCode: me.adminCode });
  }

  async login(email: string, password: string) {
    const { error } = await this.supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new Error(friendly(error.message));
    return this.session();
  }

  /** Crea la cuenta y, si hay sesión (sin confirmación de email), completa el alta con nombre e invitación. */
  async register(input: { login: string; name: string; password: string; code: string }): Promise<SessionState | 'confirm'> {
    const { data, error } = await this.supabase.auth.signUp({
      email: input.login.trim().toLowerCase(),
      password: input.password,
      options: { emailRedirectTo: location.origin },
    });
    if (error) {
      // La cuenta ya existe: puede ser un alta que se quedó a medias (sin nombre ni invitación). Si la contraseña es la
      // suya, se entra y se termina el alta; si ya tenía perfil, register_profile solo devuelve la cuenta.
      if (/user already registered/i.test(error.message)) {
        const login = await this.supabase.auth.signInWithPassword({ email: input.login.trim().toLowerCase(), password: input.password });
        if (!login.error) return this.completeProfile(input.name, input.code);
      }
      throw new Error(friendly(error.message));
    }
    if (!data.session) {
      // Supabase pide confirmar el email: el nombre y la invitación se piden al volver a entrar.
      return 'confirm';
    }
    return this.completeProfile(input.name, input.code);
  }

  /** Completa el alta de una cuenta que aún no tiene perfil (nombre e invitación o código de administración). */
  async completeProfile(name: string, code: string): Promise<SessionState> {
    const me = await this.rpc<Me>('register_profile', { p_name: name, p_code: code });
    this.applyMe(me);
    return me.disabled ? 'disabled' : 'ok';
  }

  /** Envía un email para elegir una contraseña nueva (sirve para quien la ha olvidado). */
  async sendPasswordReset(email: string) {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: location.origin });
    if (error) throw new Error(friendly(error.message));
  }

  /** Con el código del email de recuperación: entra y pone la contraseña nueva, sin depender de abrir el enlace. */
  async resetWithCode(email: string, code: string, password: string): Promise<SessionState> {
    const { error } = await this.supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.replace(/\s/g, ''), type: 'recovery' });
    if (error) throw new Error(friendly(error.message));
    await this.setNewPassword(password);
    return this.session();
  }

  /**
   * Darse de baja: la base de datos borra lo privado, deja lo de los espacios y elimina la cuenta
   * (`delete_my_account`). Después se vacía este navegador como al cerrar sesión.
   */
  async deleteAccount() {
    await this.flush().catch(() => undefined);
    await this.rpc('delete_my_account');
    this.stop();
    await this.supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    await this.clearLocal();
    await this.db.meta.bulkDelete(['sync-user', 'sync-backend', 'sync-cursor', 'sync-owners']);
    location.reload();
  }

  async setNewPassword(password: string) {
    const { error } = await this.supabase.auth.updateUser({ password });
    if (error) throw new Error(friendly(error.message));
  }

  /** Sube lo pendiente, cierra la sesión y vacía los datos de este navegador (ya están en la base de datos). */
  async logout() {
    await this.flush().catch(() => undefined);
    this.stop();
    await this.supabase.auth.signOut().catch(() => undefined);
    await this.clearLocal();
    await this.db.meta.bulkDelete(['sync-user', 'sync-backend', 'sync-cursor', 'sync-owners']);
    location.reload();
  }

  // ---------- Espacios ----------

  /** Acciones sobre espacios; si cambia lo que veo, la siguiente sincronización lo trae todo de nuevo. */
  private async spaceAction(fn: string, args: Record<string, unknown>) {
    const spaces = await this.rpc<Space[]>(fn, args);
    this.set({ spaces });
    await this.flush();
    await this.pull();
    return spaces;
  }
  createSpace = (name: string, color: string) => this.spaceAction('create_space', { p_name: name, p_color: color });
  joinSpace = (code: string) => this.spaceAction('join_space', { p_code: code });
  updateSpace = (id: string, patch: { name?: string; color?: string; newCode?: boolean }) =>
    this.spaceAction('update_space', { p_space: id, p_name: patch.name ?? null, p_color: patch.color ?? null, p_new_code: !!patch.newCode });
  leaveSpace = (id: string) => this.spaceAction('remove_member', { p_space: id, p_user: null });
  removeMember = (id: string, userId: string) => this.spaceAction('remove_member', { p_space: id, p_user: userId });
  setRole = (id: string, userId: string, role: 'admin' | 'member') => this.spaceAction('set_space_role', { p_space: id, p_user: userId, p_role: role });

  // ---------- Administración (solo administradores) ----------

  adminData = () => this.rpc<{ users: AdminUser[]; spaces: AdminSpace[]; adminCode: string }>('admin_overview');
  setAdmin = async (userId: string, isAdmin: boolean) => {
    const users = await this.rpc<AdminUser[]>('set_admin', { p_user: userId, p_value: isAdmin });
    await this.session(); // por si me he quitado a mí misma
    return users;
  };
  setDisabled = (userId: string, disabled: boolean) => this.rpc<AdminUser[]>('set_disabled', { p_user: userId, p_value: disabled });
  /** Contraseña provisional (se ve una vez): no depende del email. Cierra las sesiones abiertas de esa cuenta. */
  setProvisionalPassword = (userId: string) => this.rpc<string>('admin_set_password', { p_user: userId });
  regenerateAdminCode = async () => {
    const code = await this.rpc<string>('regenerate_admin_code');
    this.set({ adminCode: code });
    return code;
  };
  adminJoinSpace = (id: string) => this.spaceAction('admin_join_space', { p_space: id });

  // ---------- Feedback (migración 006): enviarlo, cualquiera; leerlo y gestionarlo, solo administradores ----------

  sendFeedback = (f: { kind: FeedbackKind; area: string; title: string; body: string; impact: FeedbackImpact | null; page: string }) =>
    this.rpc<void>('send_feedback_form', {
      p_kind: f.kind, p_area: f.area, p_title: f.title, p_body: f.body, p_impact: f.impact ?? '', p_page: f.page,
      p_screen: `${window.innerWidth}×${window.innerHeight}`, p_user_agent: navigator.userAgent,
    });
  adminFeedback = () => this.rpc<Feedback[]>('admin_feedback');
  updateFeedback = (id: string, patch: { status?: FeedbackStatus; taskId?: string }) =>
    this.rpc<Feedback>('admin_update_feedback', { p_id: id, p_status: patch.status ?? null, p_task_id: patch.taskId ?? null });
  /** Comprueba la contraseña actual (volviendo a entrar) antes de cambiarla. */
  changePassword = async (current: string, password: string) => {
    const email = this.state.user?.login;
    if (!email) throw new Error('Inicia sesión.');
    const { error } = await this.supabase.auth.signInWithPassword({ email, password: current });
    if (error) throw new Error('La contraseña actual no es correcta.');
    await this.setNewPassword(password);
  };

  // ---------- Primer acceso en este navegador ----------

  /**
   * Qué hacer con los datos que ya hay en el navegador al entrar:
   * - "ready": son de esta cuenta (o no hay), se sigue sincronizando.
   * - "ask-upload": hay datos sin cuenta de Supabase (de antes, o del servidor local anterior) y la cuenta
   *   está vacía: se pregunta si subirlos.
   */
  async prepare(): Promise<'ready' | 'ask-upload'> {
    const user = this.state.user!;
    const backend = (await this.db.meta.get('sync-backend'))?.value;
    // Los datos del servidor local anterior cuentan como "de antes de tener cuenta" (nunca se borran sin preguntar).
    const previous = backend === 'supabase' ? (await this.db.meta.get('sync-user'))?.value : undefined;
    if (previous === user.id) return 'ready';
    const local = (await this.db.tasks.count()) + (await this.db.notes.count()) + (await this.db.projects.count());
    // Datos de antes de tener cuenta (o del servidor local): siempre se pregunta, aunque la cuenta ya tenga cosas
    // (subirlos los suma a lo que ya hay). Los de otra cuenta de Supabase ya están en la base de datos: se vacía.
    if (!previous && local > 0) return 'ask-upload';
    await this.clearLocal();
    await this.markUser(user.id);
    return 'ready';
  }

  private async markUser(id: string) {
    await this.db.meta.bulkPut([{ key: 'sync-user', value: id }, { key: 'sync-backend', value: 'supabase' }]);
  }

  /** Sube todo lo que hay en el navegador a la cuenta (primera vez). */
  async uploadAll() {
    const changes: { tbl: SyncTable; key: string; data: Record<string, unknown> }[] = [];
    for (const tbl of SYNC_TABLES) {
      // La configuración común (tipos y etiquetas) solo la suben los administradores.
      if ((tbl === 'item_types' || tbl === 'labels') && !this.state.isAdmin) continue;
      const t = this.table(tbl);
      const keyPath = t.schema.primKey.keyPath as string;
      for (const row of await t.toArray()) changes.push({ tbl, key: String(row[keyPath]), data: row });
    }
    for (let i = 0; i < changes.length; i += CHUNK) await this.rpc('push_changes', { p_changes: changes.slice(i, i + CHUNK) });
    await this.markUser(this.state.user!.id);
    await this.db.meta.delete('sync-cursor');
  }

  /** Empieza con la cuenta vacía: descarga una copia de lo que había y vacía el navegador. */
  async startEmpty() {
    await this.downloadCopy();
    await this.clearLocal();
    await this.markUser(this.state.user!.id);
  }

  /** Copia de seguridad en un archivo antes de vaciar el navegador (por si acaso). */
  private async downloadCopy() {
    const data: Record<string, unknown[]> = {};
    for (const table of SYNC_TABLES) data[table] = await this.table(table).toArray();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `tareas-antes-de-vaciar-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async clearLocal() {
    await this.db.transaction('rw', SYNC_TABLES.map((t) => this.table(t)), async (tx) => {
      (tx as SyncTx).__fromSync = true;
      for (const t of SYNC_TABLES) await this.table(t).clear();
    });
    await this.db.meta.bulkDelete(['sync-cursor', 'sync-owners']);
  }

  // ---------- Sincronización ----------

  async start() {
    if (this.running) return;
    this.running = true;
    this.set({ owners: ((await this.db.meta.get('sync-owners'))?.value as Record<string, string>) ?? {} });
    this.attachHooks();
    await this.pull();
    // Si el equipo aún no tiene tipos (Tarea, US, TS…), los crea quien administra.
    if (!(await this.db.item_types.count()) && this.state.isAdmin) await this.db.item_types.bulkPut(DEFAULT_ITEM_TYPES);
    // Los cambios de los demás llegan al momento; el sondeo es solo por si se corta el tiempo real.
    this.supabase.channel('cambios')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, () => this.schedulePull())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'overlays' }, () => this.schedulePull())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => this.schedulePull())
      .subscribe();
    this.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void this.pull(); }, POLL_MS);
    addEventListener('focus', this.onFocus);
    addEventListener('online', this.onFocus);
    this.supabase.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') location.reload(); });
  }

  private stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    void this.supabase.removeAllChannels();
    removeEventListener('focus', this.onFocus);
    removeEventListener('online', this.onFocus);
  }

  private onFocus = () => { void this.flush(); void this.pull(); };

  private schedulePull() {
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.pullTimer = setTimeout(() => void this.pull(), 300);
  }

  private table(t: SyncTable) {
    return this.db.table(t) as Table<Record<string, unknown>, string>;
  }

  /** Apunta cada cambio local (menos los que vienen de la base de datos) para subirlo. */
  private attachHooks() {
    if (this.hooked) return;
    this.hooked = true;
    for (const name of SYNC_TABLES) {
      const t = this.table(name);
      const keyPath = t.schema.primKey.keyPath as string;
      const mark = (key: unknown, tx: Transaction) => {
        if ((tx as SyncTx).__fromSync || key === undefined || key === null) return;
        this.dirty.set(`${name}:${String(key)}`, { table: name, key: String(key) });
        this.schedulePush();
      };
      t.hook('creating', (primKey, obj, tx) => mark(primKey ?? obj[keyPath], tx));
      t.hook('updating', (_mods, primKey, _obj, tx) => mark(primKey, tx));
      t.hook('deleting', (primKey, _obj, tx) => mark(primKey, tx));
    }
  }

  private schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.flush(), PUSH_DELAY_MS);
  }

  /** Claves actuales de todo (para saber qué ha desaparecido tras sustituir los datos al importar). */
  async keys(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const table of SYNC_TABLES) for (const k of await this.table(table).toCollection().primaryKeys()) out.add(`${table}:${String(k)}`);
    return out;
  }

  /** Tras importar una copia que sustituye todo: sube lo nuevo y borra en la base de datos lo que ya no está. */
  async afterReplace(before: Set<string>) {
    const now = await this.keys();
    for (const id of new Set([...before, ...now])) {
      const i = id.indexOf(':');
      this.dirty.set(id, { table: id.slice(0, i) as SyncTable, key: id.slice(i + 1) });
    }
    await this.flush();
  }

  /** Sube lo pendiente; si falla, se queda apuntado y se reintenta. */
  async flush() {
    if (!this.dirty.size || !this.running) return;
    const batch = [...this.dirty.values()];
    this.dirty.clear();
    this.set({ status: 'saving' });
    try {
      const changes = [];
      for (const { table, key } of batch) changes.push({ tbl: table, key, data: (await this.table(table).get(key)) ?? null });
      for (let i = 0; i < changes.length; i += CHUNK) {
        const r = await this.rpc<{ rejected: string[] }>('push_changes', { p_changes: changes.slice(i, i + CHUNK) });
        if (r.rejected.length) console.warn('La base de datos no ha aceptado estos cambios (sin permiso):', r.rejected);
      }
      this.pushes++;
      this.set({ status: 'ok' });
    } catch (e) {
      for (const c of batch) if (!this.dirty.has(`${c.table}:${c.key}`)) this.dirty.set(`${c.table}:${c.key}`, c);
      console.warn(e);
      this.set({ status: 'offline' });
      setTimeout(() => void this.flush(), 5000);
    }
  }

  /** Lee todas las filas de una consulta, de mil en mil (Supabase limita cada respuesta). */
  private async fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      if (error) throw new Error(friendly(error.message));
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) return out;
    }
  }

  /**
   * Trae los cambios de los demás desde la última vez. Si ha cambiado lo que puedo ver (espacios) o hace
   * rato de la última vez, lo trae todo y quita del navegador lo que ya no me corresponde.
   */
  async pull() {
    if (!this.running) return;
    const pushesBefore = this.pushes;
    try {
      const me = await this.rpc<Me | null>('me');
      if (!me || me.disabled) return location.reload();
      this.applyMe(me);
      let since = Number((await this.db.meta.get('sync-cursor'))?.value ?? 0);
      const full = since === 0 || this.accessVersion > since || Date.now() - this.lastFull > FULL_SYNC_MS;
      if (full) since = 0;
      // Un poco hacia atrás: dos cambios casi a la vez pueden confirmarse en otro orden.
      const from = Math.max(0, since - 20);
      const rows = await this.fetchAll<RecordRow>((a, b) => this.supabase.from('records')
        .select('tbl,key,owner,data,version').gt('version', from).order('version').range(a, b));
      const overlays = await this.fetchAll<OverlayRow>((a, b) => this.supabase.from('overlays')
        .select('key,data,version').gt('version', from).order('version').range(a, b));
      // Si mientras tanto se ha subido algo, esta respuesta puede traer una versión anterior: se repite luego.
      if (this.pushes !== pushesBefore) return this.schedulePull();

      const owners = full ? {} : { ...this.state.owners };
      const personal = new Map(overlays.map((o) => [o.key, o.data]));
      let cursor = since;
      await this.db.transaction('rw', [...SYNC_TABLES.map((t) => this.table(t)), this.db.meta], async (tx) => {
        (tx as SyncTx).__fromSync = true;
        if (full) {
          // Todo lo visible ha llegado: sobra lo que ya no me corresponde (salvo lo pendiente de subir).
          const received = new Set(rows.filter((r) => r.data).map((r) => `${r.tbl}:${r.key}`));
          for (const t of OWNED) {
            for (const k of await this.table(t).toCollection().primaryKeys()) {
              const id = `${t}:${String(k)}`;
              if (!received.has(id) && !this.dirty.has(id)) await this.table(t).delete(String(k));
            }
          }
        }
        for (const r of rows) {
          cursor = Math.max(cursor, Number(r.version));
          const id = `${r.tbl}:${r.key}`;
          if (this.dirty.has(id)) continue; // lo local pendiente de subir manda
          if (!r.data) { await this.table(r.tbl).delete(r.key); delete owners[id]; continue; }
          let data = r.data;
          if (r.tbl === 'tasks') {
            // "Mi día" y recordatorio no viajan en la tarea: se conservan los míos.
            const mine = personal.get(r.key) ?? (await this.table('tasks').get(r.key)) ?? {};
            data = { ...data, ...Object.fromEntries(PERSONAL_TASK_FIELDS.map((f) => [f, (mine as Record<string, unknown>)[f] ?? null])) };
          }
          await this.table(r.tbl).put(data);
          if (r.owner && OWNED.includes(r.tbl)) owners[id] = r.owner;
        }
        for (const o of overlays) {
          cursor = Math.max(cursor, Number(o.version));
          if (this.dirty.has(`tasks:${o.key}`)) continue;
          const t = await this.table('tasks').get(o.key);
          if (t) await this.table('tasks').put({ ...t, my_day: o.data.my_day ?? null, remind_at: o.data.remind_at ?? null });
        }
        await this.db.meta.put({ key: 'sync-cursor', value: Math.max(cursor, this.accessVersion) });
        await this.db.meta.put({ key: 'sync-owners', value: owners });
      });
      if (full) this.lastFull = Date.now();
      this.set({ owners, status: this.dirty.size ? this.state.status : 'ok' });
    } catch (e) {
      console.warn(e);
      this.set({ status: 'offline' });
    }
  }
}

let client: SyncClient | null = null;
export const initSync = (db: TasksDB) => (client ??= new SyncClient(db));
export const sync = () => client!;

export function useSync(): SyncState {
  const c = sync();
  return useSyncExternalStore(c.subscribe, c.getState);
}
