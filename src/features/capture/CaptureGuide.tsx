import { ChevronDown, ChevronRight, Lightbulb } from 'lucide-react';
import { usePersistentState } from '../../hooks/usePersistentState';

const ROWS: { what: string; how: string; example: string }[] = [
  { what: 'Fecha', how: 'hoy, mañana, pasado mañana, el viernes, 15 oct, en 3 días, la semana que viene, fin de mes', example: 'mandar guía de Bizum el viernes' },
  { what: 'Proyecto', how: '#Proyecto, o #Proyecto/Subproyecto (si no existe, se crea)', example: 'crear guía paso 1 #Onboarding/PASO-1' },
  { what: 'Persona', how: '@Nombre-Apellido. Si es una cuenta del equipo (nombre completo o email), se le comparte', example: 'preparar guías con @Diana' },
  { what: 'Prioridad', how: '!1 urgente · !2 alta · !3 media · !4 normal', example: 'reentregar Alta Bizum !1' },
  { what: 'Etiqueta', how: '+etiqueta', example: 'validar etiquetado +bizum' },
  { what: 'ID de Rally o Jira', how: 'US1764574, TS92615, DE125701 o US-1234: guarda el ID y pone el tipo (US, TS…)', example: 'US1764574 Alta Bizum web' },
  { what: 'Repetir', how: 'cada lunes, todos los días, cada mes, cada 2 semanas', example: 'revisar validaciones cada lunes' },
  { what: 'Recordatorio', how: 'recuérdame a las 17:00', example: 'llamar a Rosa mañana recuérdame a las 10' },
  { what: 'Varias tareas', how: 'una por línea (Shift+Enter para saltar de línea)', example: '' },
];

/** Guía de la sintaxis de captura: qué se puede escribir y un ejemplo de cada cosa que se prueba con un clic. */
export function CaptureGuide({ onExample }: { onExample: (text: string) => void }) {
  const [open, setOpen] = usePersistentState('capture-guide-open', true);
  return (
    <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-amber-900 dark:text-amber-200">
        <Lightbulb className="size-4" />Cómo escribir una tarea
        <span className="font-normal text-amber-700/80 dark:text-amber-300/70">· todo en una línea, en el orden que quieras</span>
        {open ? <ChevronDown className="ml-auto size-4" /> : <ChevronRight className="ml-auto size-4" />}
      </button>
      {open && (
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1 pr-3 font-medium">Para</th>
                <th className="py-1 pr-3 font-medium">Escribe</th>
                <th className="py-1 font-medium">Ejemplo (pulsa para probarlo)</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.what} className="border-t border-amber-200/70 align-top dark:border-amber-900/40">
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{r.what}</td>
                  <td className="py-1.5 pr-3 text-zinc-600 dark:text-zinc-400">{r.how}</td>
                  <td className="py-1.5">
                    {r.example && (
                      <button type="button" onClick={() => onExample(r.example)}
                        className="rounded bg-white px-1.5 py-0.5 text-left font-mono text-xs text-indigo-700 hover:bg-indigo-50 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950">
                        {r.example}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-500">
            Todo junto: <code className="font-mono">US1764574 reentregar Alta Bizum #Pagos @Mike el viernes !1</code>. Mientras escribes,
            debajo ves cómo lo ha entendido; quita lo que no quieras con la ×. También funciona en Cmd/Ctrl+K desde cualquier sitio.
          </p>
        </div>
      )}
    </section>
  );
}
