# CLAUDE.md

Gestor de tareas personal, solo frontend. La especificación completa está en `SPEC.md`; aquí van las decisiones de arquitectura tomadas al implementarla.

## Principio rector

Capturar una tarea debe costar menos de 5 segundos y la app no debe exigir mantenimiento manual. Si algo añade fricción o trabajo manual, se descarta.

## Stack

Vite 8, React 19, TypeScript 7, Tailwind 4 (plugin `@tailwindcss/vite`, modo oscuro por `prefers-color-scheme`), Dexie 4 + `dexie-react-hooks`, zod 4 y Vitest 5 con `fake-indexeddb`. Los tests corren con `TZ=Europe/Madrid` (definido en `tests/setup.ts`).

## Estructura

```
src/
  domain/     tipos, esquemas zod, fechas, selectores, recurrencia (nextOccurrence) y texto (fold, búsqueda difusa),
              maintenance.ts (repartir, obsoletas, resumen del día, siguiente ocurrencia), search.ts.
              Funciones puras y testeadas, sin React ni Dexie.
  parser/     parseCapture(texto, ctx) => ParsedTask[]: patterns.ts (expresiones regulares en español + respaldo chrono),
              fields.ts (campos editables)
  data/       db.ts (Dexie y migraciones), repository.ts (interfaz Repository + DexieRepository),
              backup.ts (validar, exportar, recordatorio), fsAutosave.ts (File System Access), services.ts (instancias únicas)
  hooks/      useData (useLiveQuery sobre el repositorio), useTaskActions (acciones con aviso "Deshacer")
  components/ UI reutilizable: TaskRow, TaskList/Section, TaskDetailPanel, FieldEditor, QuickAdd, Modal, Toast;
              ui/ (Badges, Popover, DatePicker, ProjectOptions, ViewSwitcher)
  features/   views/ (Hoy, 7 días, Bandeja, Proyectos, Personas), backup/ (Copias y ajustes, recordatorio),
              capture/ (CaptureInput: resaltado, autocompletado, chips; submitCapture), command/ (modal Cmd+K,
              paleta, comandos, atajos globales, chuleta), selection/ (selección, teclado, barra en bloque),
              history/ (avisos de deshacer y Ctrl/Cmd+Z), maintenance/ (atrasadas, repartir, obsoletas),
              summary/ (resumen del día), dictation/ (Web Speech API)
  app/        App, Sidebar, router por hash, AppContext (datos compartidos y editor)
tests/        Vitest: dominio, copias y repositorio
```

## Decisiones

- **Bandeja derivada.** `status` solo admite `todo | done | archived`. Una tarea está en la bandeja si está activa y no tiene ni fecha ni proyecto (`isInbox`). Así nunca hay que sincronizar ese estado a mano.
- **`due_date` como `YYYY-MM-DD` local** (`ISODate`), sin hora ni zona horaria. Todas las operaciones de fecha están en `domain/dates.ts`.
- **IDs UUID** (`crypto.randomUUID`), para poder importar copias y sincronizar en el futuro sin choques.
- **Borrado suave** con `deleted_at`: hace posible deshacer. `purgeDeleted(30)` se ejecuta al arrancar. `listTasks()` nunca devuelve tareas borradas.
- **Campos añadidos a la especificación:** `series_id` (ocurrencias de una recurrente), `sort_order` (orden manual) y `deleted_at`. `recurrence_rule` es un objeto estructurado (`RecurrenceRule`), no un texto.
- **Capa de repositorio.** Los componentes nunca importan Dexie: usan `repo` (interfaz `Repository`). Cada mutación llama a `emit()`, que dispara la copia automática. `markBackup()` no emite, para evitar un bucle.
- **Lectura en memoria.** Las vistas cargan todas las tareas no borradas con `useLiveQuery(repo.listTasks)` y filtran con selectores puros. Con volúmenes personales (miles de tareas) es instantáneo y deja la lógica testeable. Los índices de Dexie (`*people`, `*tags`, `due_date`…) quedan disponibles por si hiciera falta.
- **Tablas `settings` y `meta`.** `settings` guarda un único registro (`key: 'settings'`) validado con zod al leerlo y entra en las copias. `meta` guarda estado local del dispositivo (el handle del archivo vinculado) y no entra en las copias.
- **Migraciones.** Hay que añadir `this.version(n)` en `db.ts` y subir `SCHEMA_VERSION`. `parseBackup` rechaza copias con un esquema más nuevo que el de la app.
- **Importar.** Primero se valida con zod (incluida la integridad entre tareas y proyectos), después se muestra un resumen y solo entonces se sobrescribe. Antes de sobrescribir se guarda una instantánea en memoria para poder deshacer.
- **Copia automática en archivo.** El `FileSystemFileHandle` se guarda en `meta`. Tras recargar, Chrome exige un gesto del usuario para reconceder el permiso, y el aviso "Reactivar copia automática" aparece en `BackupReminder`. Escribe con un debounce de 2 s y actualiza `last_backup_at`.
- **Router por hash** (`#/today`, `#/project/:id`…). No necesita configuración de servidor y funciona en GitHub Pages y sin conexión.
- **Alta rápida.** `QuickAdd` (en cada vista) y el modal Cmd+K usan el mismo `CaptureInput`.
- **Deshacer global (fase 3).** El repositorio guarda en el historial el estado anterior y posterior de cada registro que cambia
  (tareas y proyectos). `repo.batch(label, fn)` agrupa varias mutaciones en una sola entrada; los lotes anidados se suman
  al exterior. `undo`/`redo` reaplican los estados en una transacción. `HistoryBridge` muestra el aviso "Deshacer" de cada
  entrada nueva y gestiona Ctrl/Cmd+Z y Ctrl/Cmd+Shift+Z (fuera de campos de texto, donde manda el deshacer nativo).
  No entran en el historial los ajustes, `markBackup` ni la purga. Importar vacía el historial. Límite: 100 entradas, solo
  en memoria (se pierde al recargar).
- **Etiquetas de acción.** Las acciones de UI van por `useTaskActions` (o `repo.batch`) con una etiqueta legible:
  es lo que se ve en el aviso. No hace falta mostrar avisos a mano.

## Parser de captura (fase 2)

- **Interfaz estable** `ParseCapture` en `parser/types.ts`: se podrá sustituir por IA sin tocar la UI.
- **Orden de extracción**: tokens con símbolo (`#` `@` `!` `~` `+`) → recurrencia → fecha. Cada token reserva su rango,
  así "cada lunes" no se lee también como "el lunes" y "#mañana" no es una fecha.
- **Fechas propias antes que chrono**: chrono-es falla en "pasado mañana", "el lunes" dicho en lunes y "a las 5".
  chrono solo se usa de respaldo y únicamente si el resultado tiene día y mes seguros y contiene un número.
- **Reglas de fechas**: "el X" dicho en día X → la semana siguiente ("este X" → hoy). Fecha sin año ya pasada → año
  siguiente. "fin de mes" → último día del mes. "la semana que viene" → próximo lunes. "por la mañana" no es fecha.
  "los lunes" (sin "cada"/"todos") no es fecha ni recurrencia.
- **Recurrencia sin fecha** → `due_date` = primera ocurrencia desde hoy (incluido). Con fecha, "cada mes/semana" se ancla
  en ella.
- **Títulos**: se eliminan los tokens salvo `@persona`, que se queda como nombre ("a @Diana" → "a Diana").
- **Descartar chips**: la UI pasa `ctx.ignore` con claves `tipo:texto` (ver `tokenKey`); el fragmento se trata como
  texto y se reserva para que ningún otro extractor lo use. Clave por texto, no por posición, para sobrevivir a ediciones.
- **Nombres**: `nameKey` ignora mayúsculas, tildes y separadores; `#fundacion-cadete` = "Fundación Cadete". El
  autocompletado inserta nombres con espacios convertidos en guiones.
- **Captura**: lo detectado manda sobre los valores por defecto de la vista (fecha de Hoy, proyecto actual…). Los proyectos
  nuevos se crean al enviar, una vez por lote. Las tareas sin título no se crean.

## Interacción (fase 3)

- **Selección** en `SelectionProvider`: `selected` (conjunto), `focused` (cursor) y `editing` (tarea y campo en edición).
  Clic = seleccionar solo esa, Cmd/Ctrl+clic = añadir o quitar, Shift+clic = rango desde el ancla. El orden para rangos
  y para J/K sale del DOM (`[data-task-id]` dentro de `main`), así funciona igual en todas las vistas y secciones.
- **`targetsFor(id)`**: si la tarea forma parte de la selección, la acción se aplica a toda la selección; si no, solo a ella.
  Lo usan el teclado, la barra en bloque, el editor de campos y el arrastre.
- **Edición en línea**: doble clic sobre un campo (`data-field`) o tecla (Enter = título, D = fecha, M = proyecto).
  `FieldEditor` interpreta texto libre con `parser/fields.ts` ("vie", "15 oct", "1h30") y muestra una vista previa.
- **Arrastrar y soltar**: HTML5 nativo con el tipo MIME propio `application/x-gestor-task-ids` (lista de ids). Destinos:
  secciones de día (7 días, Para hoy), "Sin fecha" de un proyecto y, en la barra lateral, Hoy, Bandeja y cada proyecto.
- **Búsqueda**: ruta `#/search/<consulta>` y buscador en la barra lateral (`/`). `domain/search.ts`: palabras sin tildes
  en título, notas, proyecto, personas y etiquetas. Filtros `#`, `@` y `+` por prefijo; `todas:` incluye completadas.
- **Orden de los listeners de teclado**: `SelectionProvider` envuelve a `CommandCenterProvider`. Los efectos hijos se
  registran antes, así que el centro de comandos (N, G+letra, ?, /) procesa la tecla primero y marca `preventDefault`;
  la selección ignora los eventos ya gestionados.

## Reglas automáticas (fase 4)

Todo en `domain/maintenance.ts`, con funciones puras y tests (`tests/maintenance.test.ts`).

- **Recurrentes**: `repo.setCompleted` crea la siguiente ocurrencia dentro del mismo lote, así un solo "Deshacer" lo
  revierte todo. Fecha = `nextDueAfterCompletion`: parte de la fecha de la tarea y salta las ocurrencias pasadas sin ir
  más allá de hoy (completar tarde una diaria no deja cola de atrasadas, pero la de hoy sigue pendiente). No se crea
  ocurrencia si la serie (`series_id`) ya tiene una pendiente: desmarcar y volver a completar no duplica.
- **Atrasadas** (`OverdueBlock`): hoy, mañana, la semana que viene (próximo lunes), sin fecha o eliminar, y para todas,
  "Todas a hoy" y "Repartir…".
- **Repartir** (`distributeOverdue`): orden por prioridad, después fecha más antigua y antigüedad. Reparte en los
  próximos días laborables (desde hoy si lo es, hasta 30) restando lo ya previsto cada día. Sin estimación = 30 min
  (`DEFAULT_ESTIMATE_MINUTES`). Si una tarea no cabe en ningún día, va al que tiene más hueco. Antes de aplicar se ve una
  vista previa (`DistributePreview`, modo `distribute` del centro de comandos).
- **Obsoletas** (`staleTasks`): activas con `last_touched_at` de hace más de 30 días, excluidas las atrasadas (ya tienen
  su bloque). Nunca se archivan solas: "Archivar" pone `status: 'archived'` y "Mantener" solo renueva `last_touched_at`.
- **Resumen del día** (`dailySummary`): las 3 más importantes entre las de hoy y las atrasadas (prioridad, vencimiento,
  antigüedad); si faltan, se completa con las de prioridad 1-2 de los próximos 7 días o sin fecha. Muestra atrasadas,
  carga frente a capacidad y aviso de sobrecarga. Al cerrarlo se guarda `settings.ui.summary_dismissed_on`, así que no
  vuelve ese día. El comando "Ver resumen del día" lo reabre.

## PWA (fase 5)

- **Dictado**: se quitó en la fase 14 (enviaba el audio fuera y no se usaba).
- **PWA** con `vite-plugin-pwa` (`generateSW`, `registerType: 'autoUpdate'`): precachea todo el bundle e iconos, con
  `navigateFallback: index.html` (las rutas van por hash). Los iconos PNG (192, 512 y maskable) salen de `public/icon.svg`.
  En desarrollo no se registra el service worker: para probar sin conexión, `npm run build && npm run preview`.
- **Instalación**: `app/install.ts` guarda `beforeinstallprompt` al arrancar y la tarjeta de ajustes ofrece "Instalar app".
- **Ojo**: IndexedDB va por origen. Desarrollo (5173), preview (4173) y producción tienen datos separados.
  **La app de la usuaria es la de 4173** (`npm start` = build + preview en el puerto 4173 fijo). El 5173 es solo para
  desarrollar y probar cambios; no hay que pedirle que lo abra.

## Atajos (fase 2)

Atajos globales en `CommandCenterProvider`: Cmd/Ctrl+K captura, Cmd/Ctrl+Shift+P paleta, `>` al principio de la captura
pasa a la paleta, `N`/`Q` captura, `G`+letra navega, `?` chuleta. Los atajos de una tecla se ignoran si el foco está
en un campo editable o hay un diálogo abierto.

## v2 · espacio de trabajo (fase 6: lo visual)

Petición de la usuaria (7 oct 2026): más visual (Asana, To Do, Trello, Notion), registro de lo hecho y lo que no, notas de
reunión, estado de US (User Stories) y TS (Test Scenarios), releases, quién dijo qué y recordatorios.

- **Esquema v2** (`db.ts`, migración automática desde v1): tablas `labels` (color por nombre de etiqueta) e `item_types`
  (tipos con flujo de estados). En las tareas, `type_id`, `state_id` y `checklist`. `SCHEMA_VERSION = 2`; las copias v1 se
  siguen importando (zod completa los campos y `state_id` sale de `status`).
- **Tipos y estados** (`domain/workflows.ts`): Tarea, User Story y Test Scenario, cada uno con estados de color y una
  categoría (`todo | doing | blocked | done`). `status` sigue siendo la fuente de verdad de pendiente/completada/archivada,
  así que las reglas de las fases 1-5 no cambian. Se mantiene sincronizado con el estado: `setCompleted` pone el primer estado
  "done" (o el inicial al reabrir) y `setState` a un estado "done" completa la tarea (pasando por `setCompleted`, para que las
  recurrentes generen la siguiente). `setType` busca un estado equivalente por categoría.
- **Etiquetas**: siguen siendo `tags: string[]`. La tabla `labels` solo guarda colores personalizados; sin fila, el color
  sale de `colorFor(nombre)` (estable). Renombrar y eliminar se aplican a todas las tareas en un lote deshacible. El
  historial cubre ahora también las tablas `labels` e `item_types`.
- **Panel de detalle** (`TaskDetailPanel`, sustituye al modal `TaskEditor`): tipo, estado, título, propiedades, pasos con
  progreso y reordenación por arrastre, y notas. Cada cambio es una entrada del historial. En pantallas de 1280 px o más es
  una tercera columna; por debajo se superpone. Esc dentro de un campo sale del campo y un segundo Esc cierra el panel.
- **Lista de proyecto** al estilo Asana: secciones por categoría de estado (En curso, Bloqueadas, Por hacer, Completadas);
  soltar en una sección pasa cada tarea al primer estado de esa categoría dentro de su propio flujo.
- **Tablero** (`features/board`): columnas = estados de un tipo (pestañas Tarea/US/TS). Arrastrar llama a `setState`. Las
  completadas de hace más de 14 días no se muestran. Alta en cada columna con la sintaxis de captura. Hay un tablero global
  (`#/board`, `G T`) con filtro por proyecto y el modo Lista/Tablero de cada proyecto, ambos recordados en localStorage
  (`usePersistentState`).
- **Ancho**: las vistas de tablero piden todo el ancho con `useWideLayout(true)`.
- Iconos con `lucide-react`. Componentes visuales en `components/ui/` (`Badges`, `Popover`, `ViewSwitcher`).

## Fase 7: US/TS, releases y calendario

- **Esquema v3**: en las tareas, `external_id`, `url` y `release_id` (con índices `release_id` y `external_id`); tabla
  `releases` (`name`, `date`, `project_id`, `status: planned | released | cancelled`, `notes`). En los tipos,
  `url_template` opcional. Las copias v1 y v2 se siguen importando (zod pone `null` en los campos que faltan).
- **Enlaces** (`domain/releases.ts`, `externalUrl`): el `url` explícito manda; si no hay, se usa la plantilla del tipo
  sustituyendo `{id}` por el ID externo.
- **Sintaxis de captura**: las claves en mayúsculas tipo Jira (`US-1234`, `QA2-17`) son `external_id` y salen del título;
  si el prefijo coincide con la abreviatura de un tipo, la tarea se crea de ese tipo. Las minúsculas (`covid-19`) no cuentan.
  `^nombre` asigna la release, que se crea si no existe (una vez por lote, con el proyecto de la tarea). El autocompletado
  cubre `^`.
- **Personas en el título**: el nombre se queda solo detrás de una preposición o conjunción ("a @Diana", "con @Luis");
  suelto ("revisar login @Diana") se quita.
- **Releases**: la pantalla `#/releases` (y `G R`, «Nueva release») se quitó a petición de la usuaria (nov 2026); `#/releases`
  lleva a Hoy. Las releases siguen como dato: campo del panel, `^release` en la captura, filtro del tablero y calendario.
  Quedan en `domain/releases.ts` `releaseProgress` y `groupReleases`, con sus tests.
- **Calendario** (`#/calendar`, `G C`): mes de lunes a domingo (`monthGrid`) con vencimientos y releases; soltar una
  tarea en un día cambia su fecha. El mes visible y "mostrar completadas" se recuerdan en localStorage.
- **Configurar tipos** (Ajustes → Tipos y estados): nombre, abreviatura, color, plantilla y estados (añadir, renombrar,
  recolorear, categoría, reordenar, eliminar). `saveItemType` pasa las tareas de estados eliminados al equivalente por
  categoría; `deleteItemType` pasa las tareas a Tarea (Tarea no se puede eliminar). Todo entra en el historial.
- **Tablero global**: filtro por release; las tarjetas nuevas heredan la release filtrada.

## Fase 8: notas, actas y personas

- **Esquema v4**: tabla `notes` (`title`, `body` en Markdown, `kind: meeting | note`, `date`, `project_id`, `people`
  derivado de las @menciones, `pinned`, borrado suave con `deleted_at`) y tabla `people` (fichas por nombre: `role` y
  `notes`). Tipo nuevo **Tema** (`TOPIC_TYPE_ID`, estados Pendiente/Hablado) para los temas pendientes con alguien: son
  tareas normales (completar, deshacer, buscar…), pero no entran en la Bandeja.
- **Markdown propio** (`domain/markdown.ts`, sin dependencias ni innerHTML): bloques por línea (encabezados, listas,
  acciones `- [ ]`, citas, separadores) e inlines (negrita, cursiva, código, enlaces, @persona, #proyecto, claves
  `US-123`). Las acciones enlazadas llevan `[[t:<id>]]` al final de la línea.
- **Editor** (`features/notes/NoteEditor.tsx`): al escribir, un textarea con una capa coloreada detrás (mismas métricas:
  solo cambia el color, no el tamaño ni el peso); al salir (Esc o "Ver"), Markdown formateado. Autoguardado con debounce de
  700 ms mediante `updateNote(…, { silent: true })`: entra en el historial pero no muestra aviso (`HistoryEntry.silent`).
  Enter continúa listas y acciones, Cmd/Ctrl+B pone negrita y hay autocompletado de @persona.
- **Acciones → tareas** (`noteActions.ts`): cada `- [ ] …` pasa por `parseCapture` (admite @persona, fechas, !1…), hereda el
  proyecto de la nota, guarda "De: <acta> (fecha)" en las notas de la tarea y la línea recibe su `[[t:id]]`. Todo en un lote
  deshacible. La casilla de una acción enlazada refleja el estado de la tarea; marcarla completa o reabre la tarea.
- **Quién dijo qué** (`domain/notes.ts`, `mentionsOf`): líneas que mencionan a la persona (excepto la de asistentes), con
  su sección del acta y su fecha. La ficha de persona reúne rol y notas, temas pendientes (con alta rápida), tareas, "lo que
  dijo o se habló" y sus reuniones. En un acta, el panel lateral muestra los temas pendientes con los asistentes.
- **Contexto en la tarea**: el panel de detalle muestra "Sale de" con las notas que la enlazan. Los proyectos muestran sus
  notas y la búsqueda global también encuentra notas (por palabras).

## Fase 9: recordatorios y registro

- **Esquema v5**: `remind_at` en las tareas (ISO; se pone a `null` al atenderlo) y tabla `activity`
  (`kind: created | completed | reopened | postponed | deleted | archived | state`, `from`/`to`, día local).
- **Registro automático**: `patchTask` y `createTask` llaman a `logActivity`, que usa la función pura
  `activityFor(before, after)`. Los apuntes se guardan en la **misma entrada del historial** que el cambio
  (`recordMany`), así que deshacer quita también el apunte. "Pospuesta" = tenía fecha y se retrasa o se le quita (estando
  pendiente). Completar no apunta además un cambio de estado.
- **Registro** (`#/log`, `G L`): semana a semana, con totales y cada día con Hecho, Pospuesto (con "N×"), Dejado de hacer
  (eliminadas, que se pueden restaurar mientras no se purguen, y archivadas), Cambios de estado y Notas del día.
  `dailyLog` descuenta lo completado y reabierto el mismo día y agrupa por tarea las pospuestas del mismo día.
  `PostponedChip` marca en filas y tarjetas lo pospuesto 2 o más veces; el panel muestra el historial de la tarea.
- **Recordatorios**: sin servidor, así que solo avisan con la app abierta. `ReminderCenter` revisa cada 15 s y programa
  un temporizador exacto para el siguiente. Al vencer: notificación del sistema (si hay permiso; solo para los que vencen
  en ese momento, no para los que se pasaron con la app cerrada), aviso en la app con Hecha/Posponer/Descartar y contador
  en el título de la pestaña. El permiso se pide al poner el primer recordatorio (con un clic) o desde Ajustes.
- **Sintaxis**: "recuérdame / avísame (a las) HH[:MM]" pone el aviso el día de la tarea o hoy (mañana si ya pasó y no hay
  fecha). Va antes que la fecha en el orden de extracción. "a las 5" sin "recuérdame" sigue sin significar nada.

## Fase 10: subproyectos, vista "Todo" y calendario de fechas

- **Esquema v6**: `projects.parent_id`; en las notas, `task_id` y `meeting_url`; en las personas, `email`; en los ajustes,
  `saved_views`. La migración rellena los valores por defecto y las copias antiguas siguen importándose.
- **Subproyectos** (`domain/projects.ts`): árbol de hasta `MAX_PROJECT_DEPTH = 3` niveles. `canMoveUnder` impide ciclos y
  pasar del máximo; `withDescendants` y `ancestry` dan descendientes y ruta. Un proyecto con un antepasado archivado cuenta
  como archivado (`isEffectivelyArchived`, aplicado en `AppContext.projects`). Un subproyecto nuevo hereda el color del padre.
  Barra lateral en árbol plegable (estado en localStorage); el recuento incluye a los descendientes. El proyecto muestra migas
  de pan, tarjetas de subproyectos (con alta), "Mover…" (dentro de otro o al nivel superior) y, con "Ver también sus tareas
  aquí", las tareas de los descendientes (`contextProjectId` oculta el chip del propio proyecto en las filas).
- **Captura**: `#padre/hijo` (el token de proyecto admite `/`). `resolveProjectToken` acepta la ruta completa o su final;
  sin ruta, gana el de menos profundidad. `#padre/nuevo` crea el subproyecto dentro del padre. El autocompletado muestra la
  ruta e inserta `caixa/Sprint-14`. Los selectores usan `useProjectOptions` (árbol con sangría y ruta al buscar).
- **Vista Todo** (fusionada en el Tablero en la fase 12; `domain/filters.ts`): `applyFilter` combina tipo (interruptores por
  tipo), categoría de estado, proyecto (con subproyectos), persona, etiqueta, release, fecha (atrasadas, hoy, 7 días, con o
  sin fecha), texto y "completadas"; `groupTasks` agrupa por tipo, estado, proyecto, persona o fecha. El filtro actual se
  recuerda en localStorage. Las **vistas guardadas** van en `settings.saved_views`, así que entran en las copias.
- **Selector de fecha** (`components/ui/DatePicker.tsx`): mes con número de semana ISO (`isoWeek`), hoy resaltado, días no
  laborables atenuados, un punto en los días con tareas, opciones rápidas y texto libre (`parseDateText`, Enter aplica).
  `DateButton` lo abre en un desplegable (panel, releases, notas); con la tecla D se abre dentro de la fila (`InlineDatePicker`).

## Fase 11: notas de elementos y Teams

- **Notas de un elemento** (US, TS, tarea…): son notas normales (`notes`) con `task_id`, así que también aparecen en Notas
  y en la búsqueda. Se crean desde el panel de detalle (`TaskNotes`, Markdown, Cmd/Ctrl+Enter) con el título
  "US-1234 · Título". El antiguo campo `task.notes` se muestra como "Descripción". El proyecto tiene la sección "Notas por
  elemento" (`ItemNotes`, `notesByTask`): agrupadas por elemento con su estado, cada grupo ordenado por fecha y los grupos
  por la nota más reciente. Las actas del propio proyecto excluyen las notas de elementos. En la vista Notas, el filtro "De
  elementos" y el proyecto se toman del elemento (aunque se mueva).
- **Teams sin servidor ni permisos de Microsoft** (`domain/teams.ts`): `meeting_url` en las actas con botón "Unirse";
  "Compartir" copia el resumen (`meetingSummary`: asistentes, decisiones y acciones con el estado de su tarea) o el acta en
  Markdown, y abre un chat de Teams con los asistentes (`teamsChatUrl`, enlace `teams.microsoft.com/l/chat/0/0?users=…`
  con tema y mensaje), usando el `email` de las fichas. La ficha de persona tiene campo de email y "Chat en Teams".
- **Importar reuniones (.ics)** (`domain/ics.ts`, `IcsImport`): despliega líneas plegadas, lee SUMMARY, DTSTART (UTC → hora
  local; con TZID se toma como hora local; VALUE=DATE de día completo), ORGANIZER/ATTENDEE (CN y email), enlace de Teams
  (`X-MICROSOFT-SKYPETEAMSMEETINGURL` o el que venga en la descripción) y expande RRULE sencillas (DAILY, WEEKLY con BYDAY,
  MONTHLY; INTERVAL, COUNT, UNTIL, EXDATE) en una ventana de −14 a +30 días. Las canceladas se ignoran. Se marcan por
  defecto las de los próximos 7 días y, de cada serie, solo la siguiente. Se evitan duplicados (mismo título y día). Al
  importar se guardan los emails de los asistentes en sus fichas. La conexión directa con el calendario de Microsoft
  (Graph) queda fuera: necesitaría registrar una app en Entra ID con permiso de la empresa.

## Fase 12: tablero único, semana y cuaderno tipo OneNote

- **Clic = abrir**: un clic normal en una fila (o tarjeta) la selecciona y abre el panel de detalle. Cmd/Ctrl/Shift + clic
  solo seleccionan (selección múltiple), sin abrir el panel.
- **Semana** (`#/week`): de lunes a domingo (`mondayOf`), con flechas entre semanas y número de semana ISO. Los días
  pasados se atenúan y muestran también lo completado ese día.
- **Tablero = todo**: la vista "Todo" de la fase 10 desaparece como apartado y su contenido pasa al Tablero (`#/all` redirige
  a él). El tablero tiene interruptores por tipo, filtros, vistas guardadas y modo Tablero/Lista (`board-mode`). Con un solo
  tipo elegido, las columnas son sus estados (`Board`); con varios o ninguno, son las categorías comunes (`CategoryBoard`:
  Por hacer, En curso, Bloqueado y Hecho). Al soltar, cada tarjeta pasa al primer estado de esa categoría en su propio
  flujo, y las tarjetas creadas en una columna se colocan igual. Si el filtro tiene un solo proyecto o una sola release,
  las tarjetas nuevas los heredan.
- **Notas tipo OneNote**: tres columnas. Secciones = proyectos y subproyectos con su color, más "Todas las notas" y "Sin
  sección". Páginas = notas de la sección, en orden manual (`sort_order`, sin índice ni cambio de esquema;
  `sortPages`/`reorderPages`, arrastrando). Las notas de US/TS van debajo, en su propio grupo. Contenido = la página. Abajo,
  "Agregar sección" (dentro de la seleccionada si se marca) y "Agregar página"/"Acta". El lateral de acciones y temas solo
  aparece en actas o en notas con acciones.
- **Teams en tiempo real**: no disponible sin un registro de app en el Entra ID de la empresa (Microsoft Graph). Además,
  el enlace ICS publicado de Outlook no se puede leer desde el navegador por CORS sin un servidor intermedio.

## Fase 13: pantalla de proyecto, personas y desplegables

- **Desplegables** (`components/ui/Popover.tsx`): se dibujan en un portal con `position: fixed` por encima de todo, así no
  los recorta ningún panel con scroll (el calendario del panel lateral salía cortado). Se recolocan para caber en pantalla
  (desplazamiento horizontal y apertura hacia arriba) al abrir, al hacer scroll o al cambiar de tamaño (ResizeObserver).
  Llevan `data-popover`, que `Main` excluye al quitar la selección con un clic fuera.
- **Proyecto** (`features/project/ProjectPage.tsx`): tres modos (`project-view:<id>`). **Resumen** (por defecto): cifras del
  proyecto entero (pendientes, en curso, bloqueadas, atrasadas, hechas en 7 días, notas) y una tarjeta por subproyecto
  directo, más "General" con lo que cuelga del propio proyecto. Cada tarjeta suma sus descendientes y muestra avance,
  estados, sub-subproyectos, tareas abiertas (atrasadas primero, completar, abrir, arrastrar a otra tarjeta), alta rápida
  con la sintaxis de captura y las últimas notas. **Lista**: agrupada por subproyecto con su ruta.
  **Personas en el tablero** (`ProjectPeople`, `boardPeople`): debajo de las cifras, las personas de las tareas pendientes y
  el Owner de Rally de las enlazadas, con cuántas tiene cada una; pulsar una deja Lista o Tablero solo con sus tareas (desde
  Resumen pasa al Tablero) y «ficha» abre su ficha. **Tablero**: el mismo del
  Tablero general (`BoardControls` + `BoardContent` de `BoardView.tsx`: tipos, filtros, «Como en Rally» con Need Review o por
  grupo) sobre las tareas del proyecto; filtro en `project-board-filter:<id>`, sin vistas guardadas. Debajo, notas por elemento y actas del proyecto (con subproyectos).
- **Personas** (`domain/people.ts`, `peopleDirectory`): une las personas de las tareas, las mencionadas con @ en notas y las
  que tienen ficha (por `nameKey`). Se usa en la barra lateral (todas; a partir de 10, "Ver las N") y en la vista Personas.
  En la ficha, cada línea de "Lo que dijo o se habló" tiene "→ Tarea" y "→ Tema" (con la persona y el proyecto de la nota;
  se quita el "@Persona:" inicial). No se crean tareas automáticamente a partir de las menciones, para no generar ruido.

## Fase 14: auditoría (menos pantallas, más hábitos)

- **Barra lateral**: Hoy · Bandeja · Tablero · Calendario · Notas; proyectos (con "+" para crear y archivados plegados),
  personas y "Más" plegado (Revisión semanal, Registro). Se eliminó la pantalla Proyectos (`#/projects` → Hoy).
- **Calendario** con modo Semana/Mes (`calendar-mode` en localStorage); `#/week` abre el calendario en modo semana.
- **Resumen del día** dentro de Hoy, no encima de todas las vistas.
- **Mi día** (`Task.my_day: ISODate | null`, sin índice ni migración: zod pone `null`): lista elegida a mano para hoy, que
  no cambia la fecha. Caduca sola porque solo cuenta si `my_day === today`. Tecla A, sol en la fila y en el panel, y destino
  de arrastre. "Para hoy" y Atrasadas no repiten lo que ya está en Mi día.
- **Para hablar**: el tipo Tema se renombra (migración v7, solo si conserva el nombre original). `SCHEMA_VERSION = 7`.
- **Marcadores `[[t:id]]`**: se reconocen en cualquier punto de la línea y en el editor se pintan transparentes, así
  escribir detrás no rompe el enlace.
- **Renombrar o unir personas** (`repo.renamePerson`): un lote que cambia tareas, menciones en notas (`renameMentions`) y
  fichas (gana la de destino; las notas se concatenan).
- **Búsqueda única** (`SearchView`): tareas, notas, personas y proyectos. Los cuadros de Tablero y Notas son "Filtrar…".
  "/" al principio de la captura va a la búsqueda.
- **Outlook** (`domain/icsExport.ts`): "Añadir a Outlook" descarga un `.ics` con alarma (a la hora del recordatorio, o a las
  9:00 del día). Es el modo de tener avisos con la app cerrada sin servidor.
- **Pistas de sintaxis**: con la captura vacía y enfocada salen chips que insertan cada token.
- **Revisión semanal** (`features/review/ReviewView.tsx`, `#/review`, `G V`): pasos Bandeja → Atrasadas → Cómo fue la semana
  → Para hablar por persona → La semana que viene → Sin tocar. "Revisión hecha" guarda `settings.ui.last_review_on`;
  `reviewDue` muestra un aviso en Hoy de viernes a lunes si no se ha hecho desde el viernes.
- **Añadir desde archivo** (`repo.mergeBackup`, Ajustes): suma una copia sin borrar, en un solo "Deshacer". Reutiliza
  proyectos (nombre bajo el mismo padre), personas (completa la ficha), tareas (ID externo, o título + proyecto + tipo) y
  notas (título + proyecto + elemento), así que importar dos veces no duplica. Se usó para pasar el cuaderno de OneNote
  (`importar/`, fuera de git: son datos de trabajo).
- **Plantillas de mensajes** (`plantillas/*.md`, `domain/templates.ts`, `features/templates/MessageComposer.tsx`): archivos
  del repositorio con cabecera `nombre:`/`tipos:` y campos `{id}`, `{titulo}`, `{hecho}`, `{pendiente}`… Se cargan al
  compilar con `import.meta.glob`, así se editan y versionan en Git. Los huecos `{?Etiqueta}` (o `{?Etiqueta|campo}`, con valor por defecto) se preguntan en el preparador, con sugerencias de enlaces o de personas por rol, y el campo `grupo:` agrupa el desplegable. «Mensaje» en el panel rellena la plantilla, se puede
  retocar y se copia o se abre en un chat de Teams (enlace profundo, sin permisos) con las personas de la tarea que tienen
  email en su ficha. Una línea cuyo campo queda vacío desaparece. Plan de integraciones en `docs/integraciones.md`.
- **Pendiente (a propósito)**: copia automática en OneDrive; la usuaria la configurará cuando tenga la herramienta definitiva.

## Fase 15: versión para el equipo (servidor y cuentas)

Decisión de la usuaria (21 oct 2026): para todo el equipo; todo privado salvo lo que menciona a un compañero; solo con
conexión; inicio de sesión provisional hasta que WPP permita "Entrar con Microsoft".

- **Servidor** (`servidor/`, TypeScript ejecutado por Node 24 sin compilar: nada de parameter properties ni enums, imports
  con `.ts`): `index.ts` sirve `dist/` y la API en `localhost:4173` (sustituye a `vite preview`; `npm start` lo arranca y, si ya había uno nuestro en marcha, lo para y lo vuelve a arrancar);
  `api.ts` (cuentas, sesiones, push/pull, sin HTTP para poder probarla); `visibility.ts` (quién ve qué, funciones puras).
  Base de datos `node:sqlite` en `servidor/datos/equipo.sqlite` (fuera de Git; `GESTOR_DATOS` cambia la carpeta). Sin
  dependencias nuevas.
- **Cuentas provisionales**: usuario + contraseña (scrypt) y sesión en cookie `gestor_sesion` (30 días). Para crear cuenta
  hace falta el **código del equipo**, que se genera al primer arranque, sale en la terminal y en Ajustes → Equipo.
- **Quién ve qué**: tablas con dueño (`tasks`, `notes`, `projects`, `releases`) son del creador; una tarea con el
  compañero en `people` o una nota que le menciona se le comparte, junto con su proyecto (y padres) y su release. El
  compañero se reconoce por nombre completo, de pila o usuario (`isUser`; en la app, `domain/sharing.ts`). Tablas
  personales por dueño: `settings`, `people` (fichas), `activity`. Globales del equipo: `item_types`, `labels`. En tareas,
  `my_day` y `remind_at` son de cada persona (tabla `overlays`). Quien recibe algo compartido puede editarlo; lo ajeno que
  no ve se rechaza. Si deja de verlo, le llega como borrado.
- **Sincronización** (`src/data/sync.ts`): Dexie sigue siendo la base de la app (deshacer, registro y vistas sin cambios).
  Los hooks de Dexie apuntan cada cambio local y se suben con un debounce de 400 ms; cada 5 s (y al volver a la ventana)
  se piden los cambios desde la última versión (`sync-cursor` en `meta`). Lo que viene del servidor se escribe en una
  transacción marcada (`__fromSync`) para no volver a subirlo, y no pisa claves pendientes de subir. Si se ha subido algo
  durante una petición de cambios, la respuesta se descarta. `replaceAll` (importar) no pasa por los hooks: después se
  llama a `sync().afterReplace(clavesDeAntes)`.
- **Entrada** (`app/AuthGate.tsx`): sin servidor → "No se puede conectar"; sin sesión → Entrar / Crear cuenta. La primera
  vez en un navegador con datos de antes de tener cuenta y la cuenta vacía, pregunta si subirlos; si no, se guarda una
  copia en `servidor/datos/copias/` antes de vaciar. Cambiar de cuenta vacía el navegador. Cerrar sesión sube lo
  pendiente y vacía el navegador.
- En la app: estado de guardado y usuario en la barra lateral, "De X · Compartida con Y" en el panel de la tarea,
  Ajustes → Equipo (miembros, código, cerrar sesión). `npm run dev` (5173) usa la API de 4173 por proxy.
- Pendiente: alojarlo en un sitio común (hasta entonces cada ordenador tiene su servidor) y "Entrar con Microsoft".

## Fase 16: espacios de equipo

Decisión de la usuaria (22 oct 2026): una sola instancia y una cuenta por persona; equipos como espacios.

- **Espacios** (tablas `spaces` y `space_members` en el servidor): nombre, color, código de invitación y miembros con rol
  `admin | member`. Cualquiera crea un espacio (queda de administradora) y se une con su invitación. La administradora
  cambia el código (el anterior deja de valer), nombra a otras administradoras y quita miembros; siempre queda una. Si sale
  el último miembro, el espacio se borra.
- **Proyecto en un espacio**: `Project.space_id` (opcional, sin migración; zod lo deja opcional). Los subproyectos heredan el
  del padre (`spaceOfProject`, igual en `servidor/visibility.ts` y `domain/spaces.ts`). Los miembros ven y editan el
  proyecto, sus subproyectos, tareas, notas y releases. Solo se puede llevar un proyecto a un espacio propio. Selector en la
  página del proyecto (`ProjectSpace`, junto a "Mover…").
- **Menciones**: comparten solo si coinciden exactamente con el nombre completo o el usuario (email) de una cuenta
  (`isUser` / `isMember`); el nombre de pila ya no basta. Las sugerencias de personas (`mentionables` en `AppContext`)
  incluyen todas las cuentas del servidor.
- **Cuentas**: el código del servidor pasa a ser de administración (crea cuentas administradoras; las que ya existían lo son
  por migración). Los compañeros se dan de alta con la invitación de un espacio y entran en él.
- **Cambios de acceso**: entrar o salir de un espacio, o mover un proyecto de espacio, sube `users.access_version` de los
  afectados; su siguiente `pull` lleva `reset` y todo lo visible, y la app borra lo que ya no llega (salvo lo pendiente).
- **Filtro por espacio** (`AppContext`, `space-filter:<usuario>` en localStorage): Todo · Personal · cada espacio, en la
  barra lateral (`SpaceSwitcher`). Filtra tareas, notas y proyectos de todas las vistas. Con un espacio elegido, los
  proyectos nuevos (desde cualquier sitio) van a ese espacio (`repo.defaultSpaceId`).
- El panel de la tarea muestra "Espacio X · De Y · Compartida con Z". Ajustes → Espacios (`SpacesCard`) sustituye a Equipo.
- Prueba local: configuración `equipo-prueba` de `.claude/launch.json` (puerto 4180, datos en `servidor/datos-prueba`).

## Fase 17: notas con formato y retoques de interfaz

Petición de la usuaria (22 oct 2026).

- **Editor de notas con formato** (`features/notes/NoteEditor.tsx`, TipTap 3: `@tiptap/react`, `starter-kit`,
  `extension-list` para las casillas, `extensions` para el placeholder): ya no se ve el Markdown. Las notas se **siguen
  guardando en Markdown** (`richText.ts`: `markdownToHtml` al cargar y `docToMarkdown` al escribir, con tests), así que
  acciones, menciones, "quién dijo qué", búsqueda y copias no cambian. `[[t:id]]` es un nodo `taskLink` (un "↗"); marcar
  la casilla de una acción enlazada completa o reabre la tarea; las casillas enlazadas se cargan con el estado real de la
  tarea. @personas, #proyectos e IDs se colorean con decoraciones; "@" abre sugerencias (`mentionables`). Atajos de
  TipTap: "## ", "- ", "1. ", "[] ", **negrita**… Se carga bajo demanda (`lazy`) para no engordar el arranque. Estilos en
  `index.css` (`.note-editor`).
- **Proyecto**: siempre a todo el ancho (la cabecera no se mueve al cambiar Resumen/Lista/Tablero); acciones como
  `ActionButton` (con borde e icono); las cifras se pulsan y muestran sus tareas (o notas) debajo; secciones de notas con
  `Section prominent`.
- **Bandeja**: `CaptureGuide` con la sintaxis y ejemplos que se escriben en la captura (`seed` de `CaptureInput`).
- **Captura**: también reconoce IDs de Rally sin guion (`US1764574`, `TS92615`, `DE…`, `TA…`, `TC…`, `F…`).
- **Notas**: "Agregar sección", "Agregar página" y "Acta" arriba de sus columnas. **Barra lateral**: el nombre del proyecto
  nuevo se escribe en su propia línea (no tapa la lista).

## Fase 18: administradores y usuarios

Petición de la usuaria (23 oct 2026): ella y Mark administran todo; el resto usa la herramienta sin administrar.

- **Dos roles de herramienta** (`users.is_admin`): **administrador** (entra con el código de administración, o lo nombra
  otro administrador) y **usuario** (entra con la invitación de un espacio). Siempre queda al menos un administrador activo.
- **Solo administradores** (comprobado en el servidor, no solo en la pantalla): panel `AdminCard` en Ajustes (todas las
  cuentas con rol y espacios; hacer o quitar admin; desactivar o reactivar, que cierra sus sesiones; contraseña provisional
  que se muestra una vez; todos los espacios y "Entrar" como administradora; ver y cambiar el código de administración),
  crear espacios, gestionar cualquier espacio, y escribir en las tablas comunes `item_types` y `labels` (el `push` de un
  usuario las rechaza; en la app se ocultan Tipos y estados, Etiquetas y el color de etiqueta del panel).
- **Para todos**: "Mi cuenta" en Ajustes → Espacios (cambiar la contraseña con la actual) y la gestión de su propio espacio
  si lo administran (invitación, miembros).
- Cuentas desactivadas (`users.disabled`): no pueden entrar y sus sesiones caducan; sus datos se conservan.

## Fase 19: conector de Rally

Petición de la usuaria (oct 2026): traer Rally al gestor sin tocar el resto (entrada «Rally» debajo de Notas).

- **Servidor** (`servidor/rally.ts`, WSAPI v2 con cabecera `ZSESSIONID`): la clave de API de cada usuario se guarda solo en
  la tabla `rally_accounts` y nunca vuelve al navegador. URL por defecto `https://eu1.rallydev.com`. Las consultas van
  anidadas de dos en dos (`joinQuery`). Escribe tres cosas: la columna (FlowState, o ScheduleState/State) al mover, comentarios
  (`conversationpost/create`) y adjuntos (`attachmentcontent` + `attachment`, máx. 25 MB). Los adjuntos también se eliminan desde la ficha
  (papelera con confirmación; `deleteAttachment`: DELETE del adjunto y de su contenido, `POST /api/rally/attachment-delete`). Crear devuelve `CreateResult` y
  actualizar `OperationResult`. Hace falta una clave Full Access para escribir.
- **Crear en Rally** (`rally.create`, `POST /api/rally/create`): User Story, Defect, Defect Suite (`DS`) y Test Set en un
  proyecto; tareas dentro de una US o un defecto (`WorkProduct`). «Nuevo en Rally» (`RallyCreateForm`) es un panel lateral
  con el mismo formulario que el «New Item» de Rally: Ready/Blocked, color, Owner, Assignee, proyecto, Schedule State y Flow
  State (elegir uno mueve el otro; se envía solo FlowState si hay columna), estimación, descripción, padre, etiquetas,
  release, iteración, milestones, Expedite, feature, adjuntos (se suben después de crear), notas, campos de defecto
  (Severity, Priority, State, Environment) y los **campos personalizados obligatorios** del tipo. Las opciones salen de
  `GET /api/rally/form` (`formOptions`: columnas, valores permitidos de la definición del tipo, releases e iteraciones del
  proyecto, miembros y permisos del proyecto, etiquetas y milestones; en caché 10 min). Las referencias se validan por
  tipo (`/release/123`…). Si el tipo no tiene `c_Assignee`, se reintenta sin él. La ficha de una US/DE sigue teniendo el
  alta rápida de tareas (`NewRallyTask`).
- **Crear con petición** (`domain/rallyRequest.ts` `parseRallyRequest`, `RallyRequestDialog`): intérprete propio, sin IA ni
  servicios externos. De una frase saca tipo, nombre (o entre comillas), owner, asignado a, proyecto, estado o columna
  (`rallyStateOf`: «en curso», «undefined» → Defined…), release, sprint, etiquetas, padre/feature por ID, puntos, Preliminary Estimate («preliminary estimate M», «talla S», «estimación L»
  sin número), fecha de inicio y fecha fin de una feature (con `parseDateText`), milestones, ready,
  bloqueada porque…, urgente, color, severidad, prioridad, entorno, descripción y notas; «yo» = `@me`. Lo que no entiende va
  a `unknown`. La ventana enseña al momento lo entendido; «Rellenar formulario» busca en Rally personas, etiquetas, padre y
  proyecto (`resolveRequest`) y abre «Nuevo elemento» con `prefill` (estado, release, iteración y campos de defecto se buscan
  al cargar las opciones) y un aviso con lo que hay que revisar. Nunca crea solo: se pulsa Create.
  Plantillas (`REQUEST_TEMPLATES`): una por tipo, en la ventana; sin Ready ni Blocked, sin valores de ejemplo que no existen en
  Rally (sprint, milestones, padre PI, feature, entorno); la feature va en «Discovering»; con «asignado a mí» (la persona de la clave); un test comprueba que cada una se lee
  entera, así que si se cambia el intérprete o una plantilla, el test avisa.
  «Modificar plantillas» (`TemplatesEditor`): cada persona tiene las suyas en `settings.rally_templates` (null = las de serie,
  `requestTemplates`; sin migración, zod pone null), así se sincronizan y entran en las copias. Nombre y frase, orden con
  flechas o arrastrando por el asa, añadir (también la petición escrita), eliminar y «Volver a las de serie»; debajo de cada
  frase se ve qué entiende el intérprete.
- **Pie del alta como en Rally**: Discard (cierra sin crear), Create + New (crea y deja el formulario abierto para el
  siguiente: vacía nombre, descripción, notas, adjuntos, estimaciones, color y Ready/Blocked, y conserva tipo, proyecto,
  personas, padre, etiquetas, release, iteración y estados) y Create (crea, cierra y abre su ficha).
- **Selectores como en Rally** (`RallyPickers.tsx`): Owner/Assignee con «Quick picks» (nadie, tú), miembros del equipo y
  búsqueda en todo Rally (`GET /api/rally/users`, desde 2 letras); «Elegir padre» (Parent, User Story del defecto, Work
  Product de la tarea y Feature) con tipo, proyecto, palabra o ID, release y páginas de 50 (`GET /api/rally/pick`, sobre
  `/artifact?types=…`); «Elegir etiquetas» con recientes (localStorage), casillas que no se mueven al marcar y páginas
  de 50 buscando en Rally (`GET /api/rally/tags`: hay decenas de miles); Milestones igual, con la lista ya cargada.
  Las búsquedas limpian comillas y paréntesis (`searchText`). Las ventanas van en portal y su Esc no cierra el panel.
- **Etiquetas de Rally** (`RallyItem.tags`, de `Tags._tagsNameArray`): los TS no tienen Assignee y se reparten por etiqueta.
  En «Qué ver de Rally», «Etiquetas» (`rally-tag-filter`) pide a Rally lo que tenga alguna (`Tags.Name = …`): en los
  proyectos elegidos o, sin proyectos, en todo Rally. «Agrupar por etiqueta» pone un elemento en cada una de las suyas.
  Al añadir al gestor, las etiquetas pasan a `task.tags` (no se vuelven a sincronizar después).
- **Proyectos de Rally**: `projects()` los trae todos por páginas de 200 (antes solo la primera página). En la pantalla,
  `ProjectChips`: fijados (`rally-pinned-projects`, alfiler), elegidos y hasta 10 en total; el resto con el buscador.
- **Features** (`FE`, `portfolioitem/feature`; su ID empieza por FE o F, `kindOfId`): se ven, se buscan y se añaden al
  gestor, pero no se mueven desde aquí (su State es un objeto de Rally), igual que los TC. Un Rally sin portfolio items
  no rompe la carga. **Tope**: hasta 5.000 por tipo (`MAX_PAGES = 25`, páginas de 5 en 5 en paralelo); `itemsReport`
  devuelve `truncated` y la pantalla avisa para acotar.
- **Crear features**: tipo «Feature» en «Nuevo elemento». Sin Blocked, Assignee, Schedule/Flow State, Iteration ni
  Expedite; con State de portfolio = columnas de su Portfolio Kanban (`featureStates`: `/state` por el ObjectID de la definición `PortfolioItem/Feature`, si no por `TypeDef.Name` y por `TypeDef.ElementName`; por defecto la primera; aviso si no se leen), Preliminary Estimate
  (`/preliminaryestimate`), Planned Start/End Date (se envían a mediodía UTC) y Parent = portfolio item de nivel superior
  (`/portfolioitem` por FormattedID; el buscador abre en «Todos los proyectos»). Se crea en `/portfolioitem/feature/create`.
- **Etiquetas por defecto al crear**: si la pantalla Rally tiene etiquetas en el filtro, «Nuevo elemento» (cualquier tipo)
  las trae ya puestas en Tags (`defaultTags`); se pueden quitar o añadir más.
- **Tipos de Rally en el gestor** (`RALLY_TYPE_IDS`): además de US y TS (Test Set de Rally, «Test Scenario»), Feature (FE),
  Defect (DE), Defect Suite (DS) y Task (TA), con estados por categoría y Accepted. Desde la sesión de una administradora
  `repo.ensureRallyTypes` añade los que falten (por id o abreviatura; si se eliminan, vuelven) y, en cualquier sesión, pasa a
  su tipo las tareas que siguen como Tarea con un ID de Rally (`typeForPrefix`: «F» = FE). Los TC siguen siendo Tarea.
- **Asignación**: se usa el campo personalizado `c_Assignee` (el Owner suele ser quien lo pidió). `mine` = Assignee u Owner soy yo.
- **Categorías** (`rallyCategory`): todo · blocked · doing · done · **accepted**. El gestor tiene ahora la categoría de estado
  `accepted` (cuenta como completada, `isDoneCategory`); la sesión de un administrador añade el estado «Accepted» a Tarea, US y TS
  (`repo.ensureAcceptedStates`), y la sincronización lo lleva al equipo. Tablero: Por hacer · Bloqueado · En curso · Hecho · Accepted.
- **Dos sentidos** (`RallySync`, `rallyStates.ts`): cada 5 min, al volver a la ventana y al abrir Rally, las tareas enlazadas
  (por `external_id`) pasan a la categoría que tienen en Rally (Rally manda). Al mover una tarea aquí (entrada del historial), se
  mueve en Rally; no se reenvía lo que viene de Rally (WeakSet) ni al deshacer un movimiento traído de Rally.
- **Comentario al mover** (`moveComment`, `MOVE_COMMENTS` en `servidor/rally.ts`): antes de mover, `pushToRally` pide `move`
  con `dryRun` (no escribe; devuelve el estado previsto y en `comment` el texto que toca). Si hay comentario, la app pregunta
  «¿Quieres marcar analista?» (`AnalystPrompt`, cola en memoria, una ventana por elemento). «Sí» busca en Rally
  (`searchUsers`, recuerda el último analista) y «Aceptar» mueve y publica; «No quiero marcar analista» mueve y publica solo
  con el PO. **Cerrar (cruz, Esc o clic fuera) cancela**: no se toca Rally y la tarea vuelve a su estado (`fromStateId` de
  `rallyPushes`, lote «Movimiento cancelado» que no se reenvía a Rally). El lápiz junto al comentario permite cambiar el texto
  (Enter termina, Esc solo sale de la edición: `Dialog.onEscape`); el servidor acepta cualquier texto no vacío. `POST /api/rally/move-comment` (`moveCommentPost`) menciona al Owner (el PO) y, en otra línea, «Analista:
  @X» (`mentionHtml`). **Las menciones tienen que ir como las guarda el editor de Rally**,
  `<span class="mention" data-mention="<_refObjectUUID>">@Nombre</span>`, o Rally no avisa por correo (un enlace a la ficha
  se ve igual pero no notifica). El UUID del Owner viene en su referencia; el del analista se pide por ObjectID (`userUuid`). Textos: «Guía definida correctamente» (New → Defined), «Se comienza a trabajar en la guía solicitada» (a En
  curso), «Guía bloqueada» o, a Completed, la plantilla «Owner · Entrega de la guía» (`plantillas/guia-5-entrega.md`, la del Mensaje al marcar Ready) sin sus huecos (`templateComment`, `doneComment.ts`; el servidor sigue proponiendo «Se finaliza la guía a la espera de validación»). Publicado ese comentario, se abre «Reunión nueva» (`MeetingPrompt`, la `NewMeeting` del Calendario) con el PO y el analista mencionados como asistentes (email de Rally: `moveCommentPost` devuelve `people`) y se puede añadir más gente. Al pasar a Bloqueado se marca
  siempre el botón Blocked y el texto final del comentario (sin menciones, en una línea, máx. 256) va a BlockedReason en el
  mismo movimiento (`blockedReason` de `move`, `blockedReasonText`). A Accepted, «Tras la revisión y OK del PO, PO IT y analista, se entrega la guía y se da por Accepted la US. Gracias!»
  (`MOVE_COMMENTS.accepted`); volver atrás no comenta. Con el lápiz (y en Need Review) se puede pulsar la mención del Owner y
  buscar en Rally a otra persona en su lugar (`OwnerMention` en `UserSearch.tsx`; `owner` en `move-comment` y `need-review`); si el comentario falla, el movimiento se mantiene y el aviso lo dice. New → Defined: pasar en el gestor a un
  estado de Por hacer que no sea el primero (Refinada, Diseñado) manda `todo` y el servidor lo lleva a Defined si está en New.
- **Ready y Blocked** (`RallyFlags`, `POST /api/rally/flag`): botones en la ficha de Rally (pantalla Rally y panel de la tarea)
  que solo cambian esas marcas, nunca la columna. Blocked abre la misma ventana que mover a Bloqueado (comentario con el PO,
  lápiz y analista; cerrar no cambia nada) y su texto va a BlockedReason; desbloquear borra el motivo. Para que la marca no
  cambie de bloque, `rallyCategory` solo tiene en cuenta Blocked cuando el elemento no tiene FlowState (tareas de Rally).
- **Mensaje al marcar Ready** (`RallyMessage`, `POST /api/rally/message`, `messageHtml`): las plantillas de «Preparar mensaje»
  con las personas buscadas en Rally; cada «@Nombre» elegido se publica como mención de Rally (avisa). «Etiquetar a» añade más. **Al quitar Ready** (`UnreadyPrompt`) se propone publicar «@Analista Tengo la lista validada por si la quieres revisar antes de la reunión con PO y PO IT» (texto editable, analista buscado en Rally, de entrada el último; va por `message`); «No comentar» o cerrar no publica.
- **Enlaces**: `commentHtml` convierte http(s):// y www. en `<a>` (Rally no enlaza el texto plano). Vale para comentarios,
  mensajes, descripción y notas al crear.
- **Tablero «Como en Rally»** (`RallyBoard`, por defecto en el Tablero mixto; «Por grupo» vuelve a las categorías,
  `board-columns`): columnas `RALLY_COLUMNS` en el orden de Rally (New, Defined, Blocked, In-Progress, Need Review, Completed,
  Accepted; To Do y Desarrollo no, a petición de la usuaria: van a la columna de su grupo). La tarjeta enlazada va a su columna de Rally (`rallyColumnOf`, `useRallyLookup`); sin
  dato, a la columna «home» de su grupo. Soltarla llama a `moveToRallyColumn`: `move` con `flow` (columna exacta si el
  proyecto la tiene), misma ventana de comentario y analista, y después la tarea del gestor cambia de grupo sin reenviarse.
- **TS a Need Review** (`NeedReviewPrompt`, `moveToNeedReview`, `POST /api/rally/need-review`): en el Tablero «Como en Rally»
  solo los TS entran en Need Review (el resto se rechaza con aviso). Se abre una ventana con buscador de defectos de Rally
  (`pick` con `types: ['DE']`, que ahora devuelve también `url`) que pone el enlace en «@PO se abre defect <enlace> por errores
  encontrado en la validación…» + «Analista: @X», y después pide el motivo del bloqueo (viene relleno con el ID del
  defecto elegido, `DE12345`, y se puede cambiar). Todo es obligatorio y se hace a la vez
  en el servidor (`needReview`: FlowState Need Review + Blocked + BlockedReason en un solo cambio y después el comentario); el
  motivo no va a la discusión. Cerrar en cualquier paso cancela todo.
- **Pantalla Rally** (`features/rally/`): proyectos elegibles (banner), agrupación por estado del tablero (por defecto: las 7
  columnas del Tablero con `boardColumnOf`, y la columna «Estado» enseña ese mismo nombre; el de Rally en el título), categoría, estado exacto, iteración o persona,
  «solo lo mío», ficha lateral con todos los campos, discusión (con caja para comentar) y adjuntos (con subida). La misma ficha
  sale en el panel de una tarea enlazada (`RallyTaskSection`).
- **Owner**: `rallyStore.ts` recuerda en memoria el último estado de cada elemento y los Owners en localStorage. El Tablero muestra
  «Owned By» y Personas incluye a los Owners de las tareas enlazadas (`rallyOwners`, campo `rally` de `peopleDirectory`). El Owner
  **no** se escribe en `task.people`: eso compartiría la tarea con la cuenta que se llame igual.

## Fase 20: calendario estilo Teams (Outlook)

- **Fuentes** (`servidor/calendar.ts`): enlace ICS publicado (en WPP solo da la disponibilidad: «Busy»/«Tentative») y, para los
  títulos, un **flujo de Power Automate** («Obtener vista de calendario de eventos (V3)», −14/+45 días, cada 5 min) que escribe
  `OneDrive/Gestor/calendario.json`. OneDrive lo sincroniza al Mac y el servidor lo lee de la carpeta local (`findGestorFile`),
  vinculado a una sola cuenta y releído solo si cambia el mtime. Sin permisos de Microsoft. `outlookEvents.ts` acepta V3 o
  Graph (horas UTC sin zona → locales, `showAs`, Teams del cuerpo, canceladas fuera). Los archivos que importa el servidor no
  pueden tener imports de valores sin extensión `.ts`.
- **Pantalla** (`CalendarView`, `useWideLayout('full')`: ocupa la ventana y solo hace scroll la agenda): minicalendario, «Mis
  calendarios» (reuniones, tareas, completadas, releases), Hoy, flechas, rango y vista (Día, Semana laboral, Semana, Mes, Lista
  de la semana). `WeekAgenda` coloca las reuniones por horas (80 px/h, de 9 a 20, `layoutDay` reparte las que se solapan) con las
  tareas del día arriba; provisionales rayadas como en Teams.
- **Reunión nueva**: doble clic en una hora vacía → `NewMeeting` abre en Teams la reunión rellenada (`teamsMeetingUrl`, enlace
  `l/meeting/new`); se envía allí. Se ve como pendiente (localStorage) hasta que llega del calendario; al llegar se borra para
  siempre, así una reunión eliminada en Teams no reaparece. «Crear acta» desde cualquier reunión (`createMeetingNote`).
  La ficha de una persona tiene «Nueva reunión» con la misma ventana (`NewMeeting` con `title` e `invite`): «Reunión con X»,
  hoy a la próxima media hora y la persona como asistente (con el email de su ficha o, si no, el de sus reuniones).
- **Teams en la app**: los enlaces de teams.microsoft.com se abren como `msteams:` (`useTeamsApp`, Ajustes, activado por defecto),
  sin dejar una pestaña en Chrome.

## Fase 21: chats de Teams (solo lectura)

- Mismo patrón que el calendario: un flujo con «Enviar una solicitud HTTP de Microsoft Graph» (solo admite rutas `me`, `users`
  o `teams`: `/me/chats?$expand=lastMessagePreview&$top=20` y `/me/chats/{id}/messages?$top=20` para los 10 más recientes) escribe
  `OneDrive/Gestor/chats.json`; `servidor/chats.ts` lo lee. `teamsChats.ts` acepta `{ value }`, `[chat]` o `[{ chat, messages }]`.
- Pantalla `#/chats`: lista con último mensaje y no leídos (`viewpoint.lastMessageReadDateTime`), conversación, «Responder en
  Teams» y «→ Tarea». «Actualizado hace X» por el mtime. Los mensajes no se escriben en el registro del servidor.
- Chat fluido o escribir desde el gestor necesitaría Microsoft Graph con una app registrada en Entra ID (IT).

## Fase 22: conector de Confluence (Data Center)

- **Servidor** (`servidor/confluence.ts`): Personal Access Token de cada usuario (`Authorization: Bearer`), guardado solo en
  `confluence_accounts`. `connect` comprueba `/rest/api/user/current` (un token malo deja «anónimo» con 200). `tasks` trae
  las tareas (casillas de las páginas) asignadas con `/rest/api/inlinetasks/search` (`assignee` = userKey, de 100 en 100) y
  añade título, espacio y enlace de su página con CQL `id in (…)`. Solo lectura por ahora.
- **Pantalla** `#/confluence` (debajo de Rally): filtro por texto y espacio, completadas opcionales, «Añadir al gestor»
  (`taskFromConfluence`: primera línea como título, fecha, enlace a la página, `external_id = CF-<id>`).
- **Ojo**: el Confluence de CaixaBank (`confluence.cloud.lacaixa.es/confluence`) solo es accesible desde su red (escritorio
  virtual). Desde el Mac el nombre no se resuelve y la pantalla lo explica; funcionará solo donde el servidor llegue a esa
  dirección. No se debe saltar ese aislamiento (túneles, sacar datos del escritorio virtual).

## Fase 23: Microsoft List por Power Automate (sin permisos de Microsoft)

IT de WPP no registra apps en Entra ID para herramientas propias (nov 2026), así que va como el calendario.

- **Leer** (`servidor/msList.ts`, `domain/msListParse.ts` sin imports de valores): un flujo («Obtener elementos» de SharePoint,
  cada 5 min) guarda `OneDrive/Gestor/lista.json` (`GESTOR_LISTA` lo cambia). Se vincula a una cuenta y se relee al cambiar el
  mtime, como el calendario. `parseMsList` convierte opciones, personas, listas y fechas y quita las columnas internas;
  `columnLabel` descodifica `_x0020_`, `_x00ed_`…
- **Escribir**: el servidor apunta cada cambio en `OneDrive/Gestor/cambios/lista-cambios.json` (`{ cambios: [{ id, campo, valor,
  titulo, at }] }`, carpeta aparte para no disparar el segundo flujo con cada exportación; escrito con temporal + renombrar).
  Un segundo flujo («Cuando se modifica un archivo» → «Actualizar elemento») lo aplica. `pendingChanges` borra los que la lista
  ya refleja y `withPending` devuelve los elementos con el valor nuevo, así la siguiente exportación no deshace un cambio.
- **En el gestor** (`domain/msList.ts`, `features/mslist/`): pantalla `#/lista` (debajo de Rally) con columna de estado
  (se adivina, `guessStatusColumn`) y correspondencia valor → categoría (`guessCategory`, editable en «Estados»; en
  localStorage `gestor-tareas:lista-config`). Tareas enlazadas por `external_id = LS-<id>`. `ListaSync` (cada 2 min): la lista
  manda (`listMoves`); al mover una tarea aquí, `listPushes` + `valueForCategory` (primer valor de esa categoría) apuntan el
  cambio. Tarda unos minutos en cada sentido.

## Fase 24: grupos de personas

Petición de la usuaria (nov 2026): en vez de una lista de personas, grupos creados por ella con cada persona dentro.

- **Datos**: `settings.groups` (`PersonGroup`: id, nombre, color; el orden de la lista es el de pantalla) y `Person.group_id`
  en la ficha (opcional, sin migración). Así entran en la sincronización (tablas personales) y en las copias sin tocar el
  servidor. Una persona está en un solo grupo; un `group_id` que ya no existe cuenta como "Sin grupo" (`groupOf`).
- `repo.setPersonGroup` crea la ficha si hace falta y entra en el historial; `savePerson` ahora conserva los campos que no
  recibe (editar el rol no saca a nadie de su grupo). Crear, renombrar, recolorear, reordenar y eliminar grupos cambia los
  ajustes (sin deshacer); al eliminar un grupo sus personas pasan a "Sin grupo" en un lote deshacible.
- **Pantalla Grupos** (`#/people`, `PeopleView`): alta de grupos, un bloque por grupo (color, nombre editable, subir/bajar,
  eliminar) y "Sin grupo" al final. Las tarjetas se arrastran entre bloques (`PERSON_MIME`, `features/views/groups.tsx`)
  o se cambian con `GroupPicker`, que también está en la ficha de la persona y permite crear un grupo al vuelo.
- **Barra lateral**: sección Grupos con "+", cada grupo plegable con sus personas y destino de arrastre. Sin grupos se ve
  la lista de antes.

## Fase 25: Supabase como base de datos del equipo

Sustituye la base de datos y las cuentas del servidor propio (fases 15, 16 y 18). Lo que esas fases cuentan de quién ve qué,
espacios y roles sigue valiendo, pero ahora lo aplica Postgres.

- **Esquema** en `supabase/migrations/001_equipo.sql` (se aplica en el editor SQL del proyecto): `profiles`, `spaces`,
  `space_members`, `app_settings`, `records` (cada registro de Dexie como jsonb, con dueño, versión y borrado) y `overlays`
  (`my_day` y `remind_at` de cada persona). Leer va por reglas RLS; escribir, solo por funciones `SECURITY DEFINER`
  (`push_changes`, `me`, `register_profile`, espacios y administración). Probado con PGlite en `tests/supabase.test.ts`.
- **Cuentas**: Supabase Auth (email y contraseña; confirmación de email opcional; recuperar contraseña por email). La primera
  cuenta es administradora; las demás entran con la invitación de un espacio. Nunca se usa la clave `service_role` en la
  app ni en el repositorio: solo la `anon` del `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- **Sincronización** (`src/data/sync.ts`): los hooks de Dexie marcan lo cambiado y `push_changes` lo sube; se piden los
  registros con `version` mayor que el cursor, con tiempo real para enterarse al momento y una sincronización completa al
  cambiar el acceso o cada 10 min. Claves en `meta`: `sync-user`, `sync-backend`, `sync-cursor`, `sync-owners`.
- **Paso desde el servidor local**: `AuthGate` detecta datos del servidor antiguo, pregunta si subirlos a la cuenta y, antes de
  vaciar nada, descarga una copia en JSON.
- **El servidor de Node se queda solo para los conectores** (Rally, Confluence, calendario, chats y Microsoft List), porque
  guarda claves secretas y lee archivos locales de OneDrive. Ya no tiene cuentas ni sesiones: la app manda su sesión de
  Supabase (`Authorization: Bearer`, `src/data/serverApi.ts`) y `servidor/auth.ts` la comprueba con `rpc/me` (un minuto en
  caché; sin conexión con Supabase responde 503). Las claves de los conectores siguen en `servidor/datos/equipo.sqlite`,
  pero ahora van por el id de Supabase: **cada persona tiene que volver a conectar sus conectores**.
- **Baja y contraseñas** (`supabase/migrations/002_baja_y_contrasenas.sql`, hay que aplicarla después de la 001):
  `delete_my_account` (Ajustes → Mi cuenta → "Darme de baja", confirmando con el email y descargando antes una copia) borra
  lo privado (lo compartido por mención se marca borrado para que se entere quien lo veía), deja lo de los espacios, pasa la
  administración de un espacio a otro miembro y borra el usuario de Auth; no deja si es la única administradora y hay más
  cuentas. `admin_set_password` genera una contraseña provisional (pgcrypto en `extensions`, cierra sus sesiones) que el
  administrador ve una vez: el email gratuito de Supabase solo llega a la organización de Supabase y permite pocos envíos.
  "¿Olvidaste la contraseña?" pide un **código** del email (`verifyOtp` tipo `recovery`, plantilla con `{{ .Token }}`) y la
  contraseña nueva en la misma pantalla; el enlace sigue valiendo, y si llega caducado (`#error_description=…`) la app lo
  explica y pide otro código. **Ojo**: en proyectos gratuitos de Supabase creados desde junio de 2026 la plantilla no se
  puede editar sin un SMTP propio, así que hasta configurarlo el email solo trae el enlace (que el correo de empresa puede
  gastar al revisarlo) y lo fiable es la contraseña provisional.
- **Crear con un espacio elegido** en el filtro de la barra lateral: los proyectos nuevos van a ese espacio y las tareas
  sin proyecto, al proyecto con el nombre del espacio (`repo.defaultSpace`, `spaceProject`; se crea la primera vez con su
  color, en el mismo "Deshacer"). Así no se quedan privadas ni desaparecen de la vista filtrada. No se aplica a la
  siguiente ocurrencia de una recurrente ni a "Añadir desde archivo".
- Prueba local: `equipo-prueba` (servidor en 4180) y `dev-prueba` (Vite en 5174 con `GESTOR_API=http://localhost:4180`).

## Fase 26: versión de producción (nov 2026)

Rama `cambios-prod` de `equipo-ia-tck/gestor-tareas-prod`, publicada en Vercel (`gestor-tareas-prod.vercel.app`).

- **Sin buscador en la barra lateral**: el cuadro está en la pantalla Buscar (`SearchBox`, `#global-search`); `/` y el comando
  «Buscar tareas» abren esa pantalla con el cursor en el cuadro (`openSearch` en `router.ts`).
- **Espacios apagados** (`SPACES_ENABLED = false` en `domain/spaces.ts`): fuera el selector de la barra lateral, la tarjeta de
  espacios de Ajustes (queda «Mi cuenta»), el selector del proyecto, el campo de invitación al crear cuenta y, en
  Administración, la columna de espacios, la lista de espacios y el código de administración. El filtro por espacio queda en
  «Todo». Lo ya compartido en espacios se sigue viendo. **Alta sin invitación**: `supabase/migrations/003_alta_sin_invitacion.sql`
  (sin código = usuario normal; la primera cuenta y el código de administración siguen dando administrador).
- **Tablero siempre con las 7 columnas de Rally** (`RallyBoard`), elija los tipos que elija; se quitan el tablero por estados
  de un tipo y el de grupos («Por grupo»). Las tareas que no están en Rally se pueden soltar en cualquier columna: pasan al
  estado de ese grupo en su tipo (`stateForCategory`: si el tipo no lo tiene, Para hablar → Pendiente o Hablado) y guardan la
  columna en `task.board_column` (sin migración; zod pone `null`), que vale mientras la tarea siga en ese estado
  (`rallyColumnOf(…, chosen)`). Las enlazadas siguen yendo a su columna de Rally; Need Review en Rally sigue siendo solo de TS.

- **Rally en Vercel** (sin el servidor del Mac): función `api/rally.ts` (formato `export default { fetch }`) con las mismas
  rutas que el servidor local (`servidor/rallyRoutes.ts`, compartido). `vercel.json` lleva `/api/rally/<ruta>` a la función
  con `?route=`. Las claves van por `RallyAccounts` (`servidor/rallyAccounts.ts`): SQLite en local y, en Vercel,
  `SupabaseRallyAccounts` (`servidor/supabaseAccounts.ts`): cifradas con AES-256-GCM con `RALLY_SECRET` (variable secreta de
  Vercel, nunca en el repo, que es público) en la tabla `connector_accounts` (migración 004; nadie la lee directamente y cada
  persona solo lee la suya con su sesión). Si se cambia `RALLY_SECRET`, hay que volver a conectar Rally. Variables de Vercel:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (públicas) y `RALLY_SECRET`. Límite de Vercel: 4,5 MB por petición (adjuntos
  grandes, solo en local).
- **Solo en local** (`LOCAL_SERVER` en `data/serverApi.ts`: la app servida desde localhost): chats, lista
  y Confluence. En Vercel se ocultan (barra lateral) y sus rutas muestran `LocalOnly`. El calendario de Outlook llega a
  Vercel con la subida desde el Mac (fase 27).
- `tsconfig.json` incluye ahora `servidor` y `api` (el typecheck cubre el servidor).
- **Fuera** (nov 2026, a petición de la usuaria): Lista (Microsoft List), Confluence y Chats, también del servidor; el botón
  Releases del calendario; la vista **Resumen** del proyecto (queda Lista/Tablero; un `project-view` guardado como `summary`
  abre el Tablero; «+ Subproyecto» pasa a la cabecera); y **archivar proyectos**: los archivados vuelven a la lista y el botón
  es **Eliminar** (`repo.deleteProject`: el proyecto y sus subproyectos fuera, sus tareas eliminadas, restaurables desde el
  Registro, y sus notas sin sección; un solo «Deshacer»).
- **Personas**: «Eliminar» en la ficha (`repo.deletePerson`: sale de las tareas, sus menciones pasan a texto con
  `dropMentions` y se borra la ficha). Unir (`renamePerson`) usa el nombre que ya existe aunque se escriba con otras mayúsculas
  o sin tildes, y devuelve el nombre final.
- **Para hablar en Mi día**: `inMyDay` incluye siempre los temas pendientes (`TOPIC_TYPE_ID`), sin `my_day`, hasta que se
  marcan como hablados; en su panel y en las filas sale «En Mi día» fijo. Su panel no tiene Outlook, Mensaje ni ID externo.
- **Release fuera de la vista** en todos los tipos: sin campo en el panel, sin filtro en el tablero y sin `^release` en la guía
  ni en las pistas de captura (el dato y la sintaxis `^` siguen funcionando).
- **Ajustes**: fuera Copia automática en archivo, Almacenamiento persistente y Capacidad y días laborables (los valores siguen
  en `settings` con sus valores por defecto).
- **Adjuntos**: `MAX_UPLOAD` es 25 MB en local y 3 MB en Vercel (4,5 MB por petición en base64); `tooBigMessage` dice qué
  archivo es, cuánto pesa y dónde subirlo.

## Fase 27: calendario en la app publicada (subida desde el Mac)

En Vercel no hay servidor que lea la carpeta de OneDrive del Mac, así que el Mac sube las reuniones a Supabase.

- **Supabase** (`supabase/migrations/005_calendario_subido.sql`, después de 001 a 004): `connector_uploads` (dueño, `kind`
  = `calendario`, `data` jsonb con la lista ya recortada, `file_at`, `uploaded_at`; cada uno lee lo suyo por RLS) y
  `upload_tokens` (solo la huella sha256). `create_upload_token` (la clave `gsub_…` se ve una vez y reemplaza a la anterior),
  `revoke_upload_token` (borra clave y subidas), `upload_token_info` y `upload_connector_file`, que llama el Mac **sin
  sesión** (rol anon) solo con la clave. Máx. 5 MB. Tests en `tests/supabase.test.ts`.
- **Mac** (`scripts/subir-onedrive.ts`, `npm run subir`): `npm run subir -- gsub_…` guarda la clave en
  `servidor/datos/subida.json` y vigila `calendario.json` (cada minuto mira el mtime; sube solo si cambia, pasado por
  `trimOutlookEvents`). `--una-vez`; `--instalar`/`--desinstalar` dejan un LaunchAgent (`com.gestor-tareas.subir`, registro
  en `servidor/datos/subida.log`). Con la clave no válida o sin migración se para.
- **App** (`features/calendar/outlook.ts`): pide a la vez el servidor local (solo si `LOCAL_SERVER`) y lo subido. Manda el archivo vinculado en el
  servidor local; si no hay, lo subido; si no, el ICS. `status.cloud` cuenta para `hasCalendar`. Ajustes → Calendario de
  Outlook: «Subida desde el Mac» (generar clave con la orden para copiar, quitar, última subida) y, sin servidor local, se
  ocultan el archivo vinculado y el enlace ICS.
- **Programa suelto** (para quien no tiene el repositorio, que solo tienen las administradoras): `npm run build` acaba con
  `scripts/build-subida.mjs`, que empaqueta el script con Vite (SSR, `node18`) en `dist/subir-calendario.mjs` (~12 KB, solo
  módulos de Node) y le pone delante `globalThis.GESTOR_EMBEDDED` con la URL y la clave anon. En Ajustes, tras generar la
  clave, salen los pasos: Node LTS, «Descarga el programa» y `node ~/Downloads/subir-calendario.mjs <clave> --instalar`.
  Suelto, guarda la clave en `~/Library/Application Support/Gestor/` y, al instalar, se copia allí (el LaunchAgent apunta a
  esa copia). `--instalar` con clave prueba antes una subida y no instala si falla. En `npm run dev` no existe el archivo.
- Chats y Microsoft List siguen necesitando el servidor local (la Lista escribe en OneDrive).

### Más adelante

- **Electron**: la app es web estática con rutas por hash y datos en IndexedDB, así que se puede empaquetar sin cambios
  (cargando `dist/`). Ojo: Electron tendrá su propio IndexedDB, y los datos se pasan con exportar e importar.

### Hoja de ruta v2

- [x] Fase 6: lista tipo Asana, tablero tipo Trello, panel de detalle, pasos y etiquetas de color
- [x] Fase 7: US/TS (ID externo y enlace), releases y calendario de "cuándo sale todo"; configurar tipos y estados
- [x] Fase 8: notas y actas de reunión en Markdown con formato en vivo, acciones convertibles en tareas, ficha de persona
      (temas pendientes y quién dijo qué)
- [x] Fase 9: recordatorios (solo con la app abierta, sin servidor) y registro diario de lo hecho, pospuesto y abandonado
- [x] Fase 10: subproyectos, vista "Todo" con filtros y vistas guardadas, selector de fecha con calendario
- [x] Fase 11: notas fechadas por elemento (en panel, proyecto y Notas) y Teams (enlace, compartir, chat e importar .ics)
- [x] Fase 12: clic abre el panel, semana de lunes a domingo, todo en el Tablero, notas con diseño OneNote
- [x] Fase 13: pantalla de proyecto con resumen por subproyecto, personas de las notas en la barra lateral, desplegables sin recortes
- [x] Fase 14: auditoría: barra lateral simplificada, Mi día, revisión semanal, búsqueda única, Outlook, unir personas, sin dictado
- [x] Fase 15: versión para el equipo: servidor propio, cuentas provisionales, privado salvo mención y sincronización
- [x] Fase 16: espacios de equipo (miembros, invitaciones, proyectos compartidos, filtro por espacio, menciones exactas)
- [x] Fase 17: notas con formato (sin Markdown a la vista), proyecto más claro, guía de captura, IDs de Rally
- [x] Fase 18: roles de administrador y usuario, panel de administración y cambio de contraseña
- [x] Fase 19: conector de Rally (dos sentidos, Accepted, Owner, comentarios y adjuntos)
- [x] Fase 20: calendario estilo Teams con reuniones de Outlook (Power Automate), agenda por horas y reuniones nuevas
- [x] Fase 21: chats de Teams en solo lectura (Power Automate) con «→ Tarea»
- [x] Fase 25: Supabase como base de datos y cuentas; el servidor queda para los conectores

## Fases

- [x] Fase 1: base, IndexedDB, modelo, CRUD, vistas básicas y copias de seguridad
- [x] Fase 2: captura con sintaxis rápida, paleta de comandos y atajos
- [x] Fase 3: edición en línea, arrastrar y soltar, selección múltiple y deshacer global
- [x] Fase 4: recurrentes, mantenimiento automático y resumen del día
- [x] Fase 5: dictado (retirado en la fase 14) y PWA offline

## Comprobaciones antes de cada commit

`npm run typecheck && npm test && npm run build`
