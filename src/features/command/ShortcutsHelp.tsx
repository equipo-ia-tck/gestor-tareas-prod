const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'General',
    items: [
      [`${MOD} K`, 'Capturar tarea (desde cualquier vista)'],
      [`${MOD} ⇧ P`, 'Paleta de comandos (o escribe > en la captura)'],
      ['N', 'Capturar tarea'],
      ['/', 'Buscar'],
      [`${MOD} Z`, 'Deshacer'],
      [`${MOD} ⇧ Z`, 'Rehacer'],
      ['?', 'Esta chuleta'],
      ['Esc', 'Cerrar / quitar selección'],
    ],
  },
  {
    title: 'Tareas',
    items: [
      ['J / K  ·  ↓ / ↑', 'Moverse entre tareas'],
      ['⇧ J / K  ·  ⇧ ↓ / ↑', 'Ampliar selección'],
      ['X  ·  Espacio', 'Marcar o desmarcar'],
      [`${MOD} A`, 'Seleccionar todas'],
      ['Enter', 'Editar título'],
      ['E', 'Abrir el panel de detalle'],
      ['C', 'Completar'],
      ['D', 'Cambiar fecha'],
      ['T  ·  ⇧ T', 'Mover a hoy · a mañana'],
      ['A', 'Añadir o quitar de Mi día'],
      ['M', 'Mover de proyecto'],
      ['1 … 4', 'Prioridad'],
      ['Supr', 'Eliminar'],
    ],
  },
  {
    title: 'Ratón',
    items: [
      ['Clic', 'Abrir el panel de la tarea'],
      [`${MOD} clic  ·  ⇧ clic`, 'Añadir · rango'],
      ['Doble clic', 'Editar el campo'],
      ['Arrastrar', 'A un día, proyecto o Hoy'],
    ],
  },
  {
    title: 'Ir a',
    items: [
      ['G  H', 'Hoy'],
      ['G  S', 'Calendario: semana'],
      ['G  T', 'Tablero (todo, con filtros)'],
      ['G  N', 'Notas'],
      ['G  C', 'Calendario'],
      ['G  V', 'Revisión semanal'],
      ['G  L', 'Registro'],
      ['G  E', 'Personas'],
      ['G  A', 'Copias y ajustes'],
    ],
  },
  {
    title: 'Sintaxis de captura',
    items: [
      ['mañana, el viernes, 15 oct', 'Fecha'],
      ['#proyecto', 'Proyecto (se crea si no existe)'],
      ['#proyecto/sub', 'Subproyecto'],
      ['@persona', 'Persona'],
      ['!1 … !4', 'Prioridad'],
      ['~30m, ~2h, ~1h30', 'Estimación'],
      ['+etiqueta', 'Etiqueta'],
      ['US-1234, TS-55', 'ID externo (y tipo)'],
      ['^R2.3', 'Release'],
      ['recuérdame a las 17:00', 'Recordatorio'],
      ['cada lunes, cada mes', 'Recurrencia'],
      ['; o salto de línea', 'Varias tareas a la vez'],
      ['Tab / ↑ ↓', 'Elegir sugerencia de # o @'],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Atajos de teclado</h2>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Cerrar">×</button>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} className={g.title === 'Sintaxis de captura' ? 'sm:col-span-2' : ''}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g.title}</h3>
            <dl className={`grid gap-x-4 gap-y-1 text-sm ${g.title === 'Sintaxis de captura' ? 'sm:grid-cols-2' : ''}`}>
              {g.items.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0"><kbd className="whitespace-nowrap rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-800">{k}</kbd></dt>
                  <dd className="text-right text-zinc-600 dark:text-zinc-400">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
