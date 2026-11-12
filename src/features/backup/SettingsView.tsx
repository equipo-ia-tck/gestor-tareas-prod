import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LOCAL_SERVER } from '../../data/serverApi';
import { useApp } from '../../app/AppContext';
import { inputClass } from '../../components/ui/styles';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { downloadBackup, parseBackup, type BackupSummary } from '../../data/backup';
import type { Backup } from '../../domain/schemas';
import { autosave, repo } from '../../data/services';
import { sync, useSync } from '../../data/sync';
import { SpacesCard } from './SpacesCard';
import { OutlookSettings } from '../calendar/Meetings';
import { AdminCard } from './AdminCard';
import type { AutosaveState } from '../../data/fsAutosave';
import { ViewHeader } from '../views/ViewHeader';
import { usePersistence } from './usePersistence';
import { useInstall } from '../../app/install';
import { LabelsCard } from './LabelsCard';
import { TypesCard } from './TypesCard';
import { ensureNotificationPermission, notificationPermission, showNotification } from '../reminders/notifications';

const WEEKDAY_LABELS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function useAutosaveState() {
  const [state, setState] = useState<AutosaveState>(autosave.getState());
  useEffect(() => autosave.subscribe(setState), []);
  return state;
}

export function SettingsView() {
  const { settings } = useApp();
  const { isAdmin } = useSync();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ backup: Backup; summary: BackupSummary; merge: boolean } | null>(null);
  const mergeMode = useRef(false);
  const [importError, setImportError] = useState<string | null>(null);
  const persisted = usePersistence();
  const fsState = useAutosaveState();

  async function onFile(file: File | undefined) {
    if (!file) return;
    setImportError(null);
    const result = parseBackup(await file.text());
    if (result.ok) setPending({ backup: result.backup, summary: result.summary, merge: mergeMode.current });
    else setImportError(result.error);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function confirmImport() {
    if (!pending) return;
    if (pending.merge) {
      const r = await repo.mergeBackup(pending.backup);
      setPending(null);
      toast(`Añadido: ${r.tasks} tareas, ${r.notes} notas, ${r.projects} proyectos y ${r.people} personas${r.skipped ? ` (${r.skipped} ya estaban)` : ''}`);
      return;
    }
    // Copia de seguridad previa en memoria: si algo sale mal, se puede deshacer.
    const before = await repo.exportSnapshot();
    const keys = await sync().keys();
    await repo.replaceAll(pending.backup);
    await sync().afterReplace(keys);
    setPending(null);
    toast('Copia importada', { label: 'Deshacer', run: async () => {
      const k = await sync().keys();
      await repo.replaceAll(before);
      await sync().afterReplace(k);
    } });
  }

  function toggleWorkday(d: number) {
    const set = new Set(settings.workdays);
    if (set.has(d)) set.delete(d); else set.add(d);
    void repo.updateSettings({ workdays: [...set].sort() });
  }

  return (
    <>
      <ViewHeader title="Copias y ajustes" />

      {isAdmin && <AdminCard />}

      <SpacesCard />

      {LOCAL_SERVER && (
        <Card title="Calendario de Outlook / Teams">
          <OutlookSettings />
        </Card>
      )}

      <Card title="Copia de seguridad">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Tus datos solo viven en este navegador. Última copia:{' '}
          <strong>{settings.last_backup_at ? new Date(settings.last_backup_at).toLocaleString('es-ES') : 'nunca'}</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button primary onClick={() => void downloadBackup(repo)}>Exportar copia (JSON)</Button>
          <Button onClick={() => { mergeMode.current = false; fileInput.current?.click(); }}>Importar copia…</Button>
          <Button onClick={() => { mergeMode.current = true; fileInput.current?.click(); }}>Añadir desde archivo…</Button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">«Importar» sustituye todo; «Añadir» suma lo del archivo a lo que ya tienes, sin borrar ni duplicar.</p>
        {importError && <p className="mt-2 text-sm text-red-600">{importError}</p>}
      </Card>

      <Card title="Copia automática en archivo">
        <AutosaveControls state={fsState} />
      </Card>

      <Card title="Almacenamiento persistente">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {persisted === null && 'Este navegador no permite pedir almacenamiento persistente.'}
          {persisted === true && '✓ Concedido: el navegador no borrará tus datos para liberar espacio.'}
          {persisted === false && 'No concedido todavía. Chrome suele concederlo cuando instalas la app o la usas a menudo. Exportar copias sigue siendo la protección principal.'}
        </p>
      </Card>

      <NotificationsCard />

      <InstallCard />

      {isAdmin ? (
        <>
          <TypesCard />
          <LabelsCard />
        </>
      ) : (
        <Card title="Tipos, estados y etiquetas">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Son comunes a todo el equipo: los configuran los administradores.</p>
        </Card>
      )}

      <Card title="Capacidad y días laborables">
        <label className="mb-3 flex items-center gap-3 text-sm">
          Capacidad diaria
          <input
            type="number" min={0} max={1440} step={30}
            className={`${inputClass} w-24`}
            value={settings.capacity_minutes}
            onChange={(e) => void repo.updateSettings({ capacity_minutes: Math.max(0, Number(e.target.value) || 0) })}
          />
          minutos ({(settings.capacity_minutes / 60).toFixed(1).replace('.0', '')} h)
        </label>
        <div className="flex gap-1">
          {WEEKDAY_ORDER.map((d) => (
            <button
              key={d}
              onClick={() => toggleWorkday(d)}
              className={`size-8 rounded-md text-sm font-medium ${settings.workdays.includes(d) ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'}`}
            >
              {WEEKDAY_LABELS[d]}
            </button>
          ))}
        </div>
      </Card>

      {pending && (
        <Modal title={pending.merge ? '¿Añadir este contenido?' : '¿Sobrescribir con esta copia?'} onClose={() => setPending(null)}>
          <ul className="mb-4 space-y-1 text-sm">
            <li>Fecha de la copia: <strong>{new Date(pending.summary.exportedAt).toLocaleString('es-ES')}</strong></li>
            <li>Proyectos: <strong>{pending.summary.projects}</strong></li>
            <li>Tareas: <strong>{pending.summary.totalTasks}</strong> ({pending.summary.activeTasks} pendientes, {pending.summary.doneTasks} completadas)</li>
            <li>Notas: <strong>{pending.backup.notes.length}</strong> · Personas: <strong>{pending.backup.people.length}</strong></li>
          </ul>
          <p className={`mb-4 text-sm ${pending.merge ? 'text-zinc-600 dark:text-zinc-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {pending.merge
              ? 'Se añade a lo que ya tienes; lo que ya exista (mismo proyecto, persona, ID de US o título de nota) no se duplica. Se deshace con Cmd/Ctrl+Z.'
              : 'Se reemplazarán todos los datos actuales. Podrás deshacerlo justo después.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setPending(null)}>Cancelar</Button>
            <Button primary onClick={() => void confirmImport()}>{pending.merge ? 'Añadir' : 'Importar y sobrescribir'}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AutosaveControls({ state }: { state: AutosaveState }) {
  const run = (fn: () => Promise<void>) => () => void fn().catch(() => { /* el usuario canceló el diálogo */ });
  switch (state.status) {
    case 'unsupported':
      return <p className="text-sm text-zinc-500">Disponible solo en Chrome y Edge. En este navegador usa "Exportar copia".</p>;
    case 'unlinked':
      return (
        <>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            Elige un archivo (por ejemplo, en una carpeta de Google Drive, iCloud o Dropbox) y la app guardará en él una copia tras cada cambio.
          </p>
          <Button primary onClick={run(() => autosave.link())}>Vincular archivo…</Button>
        </>
      );
    case 'needs-permission':
      return (
        <>
          <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
            El navegador necesita que vuelvas a dar permiso para escribir en <strong>{state.fileName}</strong>.
          </p>
          <div className="flex gap-2">
            <Button primary onClick={run(() => autosave.reactivate())}>Reactivar copia automática</Button>
            <Button onClick={run(() => autosave.unlink())}>Desvincular</Button>
          </div>
        </>
      );
    case 'active':
      return (
        <>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            ✓ Guardando en <strong>{state.fileName}</strong>
            {state.lastSavedAt && ` · última escritura ${state.lastSavedAt.toLocaleTimeString('es-ES')}`}
          </p>
          <Button onClick={run(() => autosave.unlink())}>Desvincular</Button>
        </>
      );
    case 'error':
      return (
        <>
          <p className="mb-3 text-sm text-red-600">No se pudo escribir en {state.fileName}: {state.message}</p>
          <div className="flex gap-2">
            <Button primary onClick={run(() => autosave.reactivate())}>Reintentar</Button>
            <Button onClick={run(() => autosave.link())}>Elegir otro archivo…</Button>
          </div>
        </>
      );
  }
}

function NotificationsCard() {
  const [perm, setPerm] = useState(notificationPermission());
  return (
    <Card title="Recordatorios y notificaciones">
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Los recordatorios avisan con una notificación del sistema mientras la app esté abierta (aunque esté minimizada o en
        segundo plano). Si estaba cerrada, verás los que se pasaron al abrirla. No hay servidor: nada sale del navegador.
      </p>
      {perm === 'unsupported' && <p className="text-sm text-zinc-500">Este navegador no admite notificaciones; los avisos se verán dentro de la app.</p>}
      {perm === 'granted' && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-emerald-600">✓ Notificaciones activadas</span>
          <Button onClick={() => showNotification('⏰ Prueba', 'Así se verán tus recordatorios', () => {})}>Probar</Button>
        </div>
      )}
      {perm === 'default' && <Button primary onClick={() => void ensureNotificationPermission().then(() => setPerm(notificationPermission()))}>Activar notificaciones</Button>}
      {perm === 'denied' && <p className="text-sm text-amber-700 dark:text-amber-400">Bloqueadas en este navegador. Actívalas en los permisos del sitio (icono junto a la dirección); mientras, los avisos se verán dentro de la app.</p>}
    </Card>
  );
}

function InstallCard() {
  const { canInstall, installed, install } = useInstall();
  return (
    <Card title="App instalable y sin conexión">
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        {installed
          ? '✓ Estás usando la app instalada. Funciona sin conexión.'
          : 'La app funciona sin conexión una vez cargada. Instalada se abre en su propia ventana y el navegador protege mejor sus datos.'}
      </p>
      {!installed && canInstall && <Button primary onClick={() => void install()}>Instalar app</Button>}
      {!installed && !canInstall && (
        <p className="text-xs text-zinc-400">Si tu navegador lo permite, verás el icono de instalar en la barra de direcciones (en Safari: Archivo → Añadir al Dock).</p>
      )}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Button({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={primary
        ? 'rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500'
        : 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800'}
    >
      {children}
    </button>
  );
}
