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
  (`conversationpost/create`) y adjuntos (`attachmentcontent` + `attachment`, máx. 25 MB). Los comentarios propios de la discusión se editan y eliminan (lápiz y papelera; `editComment` conserva las
  menciones que tenía con `mentionsIn`, `deleteComment`; `comment-edit` y `comment-delete`). Los adjuntos también se eliminan desde la ficha
  (papelera con confirmación; `deleteAttachment`: DELETE del adjunto y de su contenido, `POST /api/rally/attachment-delete`). Cada adjunto enseña debajo del nombre cuándo se subió y quién (`CreationDate` y `User` de Rally, `toAttachment`; «hoy, 12:40», «ayer…» o la fecha, `uploadedAt`). Crear devuelve `CreateResult` y
  actualizar `OperationResult`. Hace falta una clave Full Access para escribir.
- **Crear en Rally** (`rally.create`, `POST /api/rally/create`): User Story, Defect, Defect Suite (`DS`) y Test Set en un
  proyecto; tareas dentro de una US o un defecto (`WorkProduct`). «Nuevo en Rally» (`RallyCreateForm`) es un panel lateral
  con el mismo formulario que el «New Item» de Rally: Ready/Blocked, color, Owner, Assignee, proyecto, Schedule State y Flow
  State (elegir uno mueve el otro; se envía solo FlowState si hay columna), estimación, descripción, padre, etiquetas,
  release, iteración, milestones, Expedite, feature, adjuntos (se suben después de crear), notas, campos de defecto
  (Severity, Priority, State, Environment) y los **campos personalizados obligatorios** del tipo. Las **reglas de trabajo** del proyecto («Work Rule Error: X is required», p. ej. APPGAR,
  Tipo, Canal, Propagado a producción, Source Team) no salen en la definición del tipo: al fallar el alta, `workRuleFields` lee
  sus nombres del error, se recuerdan por tipo y proyecto (localStorage `gestor-tareas:rally-rule-fields:<tipo>:<proyecto>`) y
  `formOptions(…, ruleFields)` (`?rule=`) los añade a los obligatorios con sus valores, marcados «regla del proyecto». Las opciones salen de
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
- **Comentarios distintos para US y TS** (rama `mensajes-us-ts`, nov 2026; textos en `domain/rallyComments.ts`, compartido
  por la app y el servidor): las US hablan de la guía y los TS de la validación (`TS_MOVE_COMMENTS`: «TS definida correctamente»,
  «Se comienza a trabajar en la validación solicitada», «TS bloqueada», y en Accepted «…se entrega la validación y se da por
  Accepted la TS. Gracias!»). `commentShape(tipo, paso)` dice cómo es la ventana: a quién va la primera mención (`owner`, con
  lápiz; `analyst` en TS a Completed y al quitar Ready, con el mismo comentario opcional «Tengo la validación hecha por si la
  quieres revisar antes de la entrega» y sin reunión; `po-it` en TS a Need Review, elegido a mano, no el Owner), si es opcional
  («Mover sin comentar» / «Sin comentario»), si se espera analista y si se propone en el CC a todos los ya mencionados (TS a
  Accepted: `move` con `dryRun` devuelve `mentioned`, leído de su discusión, y `commentStep`). Quitar Ready en una US: «Tengo la
  guía validada…». **CC en todas las ventanas** (`CommentPeople.tsx`: `AddresseeRow`, `CcRow`): la última línea es «CC: @X @Y»
  (sustituye a «Analista:»), con el analista (marcar o no; el último elegido a un clic) y «+ Mencionar a alguien más». Las
  personas que faltan se avisan en ámbar, pero nunca impiden publicar (en Need Review siguen siendo obligatorios defecto,
  comentario y motivo). `move-comment` y `need-review` aceptan `cc` (`{ ref }` o `{ uuid }`), `owner` y `noOwner`; `analyst`
  de la versión anterior se suma al CC.
- **Editar desde la ficha** (rama `editar-rally`, nov 2026; `RallyEditForm.tsx`): en la ficha de la pantalla Rally y en la del
  panel de una tarea enlazada, «Detalles» es el formulario de «Nuevo elemento» con los valores actuales (`RallyDetail.edit`,
  `editValues` en el servidor; todos los tipos menos los TC). Los campos tocados se marcan en ámbar y se guardan juntos con
  «Guardar cambios» (`POST /api/rally/update`, `Rally.update`: solo lo cambiado, vacío quita el valor; «Descartar» vuelve a lo
  de Rally). Los **estados no se guardan así**: Schedule State, Flow State y el State de una tarea se mueven al momento con
  `moveRallyItem` (la misma ventana de comentario que al arrastrar en el Tablero; cerrarla = no cambia; Need Review solo TS,
  con su ventana). Si hay tarea del gestor enlazada, al guardar recibe el nombre y las etiquetas (`syncedTags`: quita las de
  Rally de antes y deja las demás). La descripción y las notas se editan como texto: si en Rally tienen formato (negritas,
  listas, imágenes…, `richDescription`) se avisa de que al cambiarlas se pierde. Los demás campos se ven en «Todos los campos
  de Rally» (solo lectura); Ready, Blocked, discusión y adjuntos siguen igual.
- **Panel de una tarea enlazada a Rally** (`isRallyId(external_id)`): sin Outlook, ID externo ni Etiquetas, que ya salen (y se
  editan) en la ficha de Rally de debajo.
- **Nuevo defecto desde una US** (`NewDefect.tsx`, misma rama): en la ficha de una US (Tablero y pantalla Rally), «Nuevo
  defecto» abre «Nuevo elemento» rellenado con la guía del equipo (`defectPrefill`): «Error found in TS», proyecto y User
  Story de la US, State Open, New, Owner quien lo crea y Assignee vacío (`noAssignee`), el APPGAR de la US, PRE, Minor
  Problem, Normal, ANA_etiquetado y «Afectación a usuario» No. Descripción, Canal y el documento de validación, a mano. Los
  campos personalizados de `RallyPrefill.custom` van por su nombre visible y se piden a `formOptions` aunque no sean
  obligatorios. Al crearlo se relee la ficha de la US y, si se marca, se añade al gestor en el proyecto de la tarea de la US.
- **Ready y Blocked** (`RallyFlags`, `POST /api/rally/flag`): botones en la ficha de Rally (pantalla Rally y panel de la tarea)
  que solo cambian esas marcas, nunca la columna. Blocked abre la misma ventana que mover a Bloqueado (comentario con el PO,
  lápiz y analista; cerrar no cambia nada) y su texto va a BlockedReason; desbloquear borra el motivo. Para que la marca no
  cambie de bloque, `rallyCategory` solo tiene en cuenta Blocked cuando el elemento no tiene FlowState (tareas de Rally).
- **Mensaje al marcar Ready** (`RallyMessage`, `POST /api/rally/message`, `messageHtml`): las plantillas de «Preparar mensaje»
  con las personas buscadas en Rally; cada «@Nombre» elegido se publica como mención de Rally (avisa). «Etiquetar a» añade más (opcional). Todos los huecos `{?…}` de la plantilla son obligatorios para «Publicar en Rally» (marcados con *; tampoco deja publicar si quedan «<…>» en el texto); «Copiar» no lo exige. Ready se marca en Rally al publicar (justo antes del mensaje) o con «Sin mensaje»; cerrar con la cruz, Esc o clic fuera no lo marca. **Al quitar Ready** (en una US, Ready solo se quita si se envía el comentario: la ventana va antes, cerrarla deja Ready marcado y, si el comentario falla, Ready se vuelve a marcar) se abre la misma ventana que al mover (`askAnalyst`: lápiz, mención del PO cambiable y analista) con «Tengo la lista validada por si la quieres revisar antes de la reunión con PO y PO IT» y se publica con `move-comment`; cerrar no publica (Ready ya está quitado).
- **¿El último en comentar fui yo?** (feedback, nov 2026; `LastCommentIcon`): `itemsReport` y `lookup` piden
  `LatestDiscussionAgeInMinutes` y, solo de los elementos con discusión, el último `conversationpost` (`addLastComments`: de 20
  en 20, 4 a la vez, más nuevos primero; si falla, sin el dato). `RallyItem.lastComment` = { mine, author, date }. Icono en la
  lista de la pantalla Rally (junto al ID) y en las tarjetas del Tablero enlazadas: verde con ✓ si es tuyo, ámbar con ! si es
  de otra persona (puede tocar contestar); el título dice quién y cuándo.
- **Enlaces en la discusión** (feedback, nov 2026): `toPost` pasa el HTML por `keepLinks`, así un `<a>` con otro texto queda
  «aquí (URL)» y no se pierde la dirección; la ficha los pinta pulsables (`LinkedText`, `linkParts`). Los de SharePoint
  tienen además «Ver en Marea» (con la extensión y la pantalla SharePoint activada): `openSharePointLink` + `sharePointTarget`
  abren la carpeta en la pantalla SharePoint o, si es un archivo, su carpeta con él marcado (`focus`) y la vista previa si es
  PDF o imagen. Los que no se saben leer (compartir un archivo, `Doc.aspx`) se abren en SharePoint.
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
- **Pantalla Rally** (`features/rally/`): siempre a todo el ancho; el nombre entero (varias líneas) con lo secundario debajo
  (asignado, proyecto, iteración, etiquetas) y «Columnas» para elegir qué se ve (`rally-columns`). Proyectos elegibles (banner), agrupación por estado del tablero (por defecto: las 7
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
- **Windows** (nov 2026): `oneDriveDirs` busca también `%OneDriveCommercial%`, `%OneDrive%` y las carpetas `OneDrive - …` del
  perfil. El programa se guarda en `%APPDATA%\Gestor` y `--instalar` deja un `.vbs` oculto en la carpeta Inicio (en UTF-16,
  por las tildes del perfil) y lo arranca al momento; `subida.pid` sirve para pararlo al reinstalar o con `--desinstalar`.
  En PowerShell `~` no vale en los argumentos de node: Ajustes enseña `node "$HOME\Downloads\subir-calendario.mjs" …`.
- **Tope del flujo** (nov 2026): «Obtener vista de calendario de eventos (V3)» devuelve como mucho 256 reuniones si no se
  cambia «Recuento superior» («Recompte superior»), en Parámetros avanzados, a 1000. Con 240 a 256 reuniones (`looksCapped`,
  lo subido va sin canceladas) el Calendario abre al entrar una ventana «Habla con un administrador para cambiar tu flujo a
  1000 reuniones», y Ajustes lo avisa junto a «N reuniones subidas».
- Chats y Microsoft List siguen necesitando el servidor local (la Lista escribe en OneDrive).

## Fase 28: notas con #proyecto y @persona → tareas (rama `notas-proyectos`)

- `noteLines(notes, projects)` (`domain/notes.ts`): líneas con @personas o #proyectos (resueltos con `resolveProjectToken`;
  un # que no es proyecto no cuenta), sin la de asistentes ni las que solo tienen la mención, con su `[[t:id]]` si ya son
  tarea. `projectLines(scope, …)`: las que mencionan el proyecto o un subproyecto con #, más las de @persona de las notas
  del proyecto.
- **Proyecto**: sección «En las notas» encima de «Notas y actas», que ahora incluye también las notas de otras secciones que
  mencionan el proyecto (`#menciona`). **Nota**: panel lateral «Menciones» con las líneas que no son acciones. **Persona**:
  «Lo que dijo o se habló» usa lo mismo.
- «→ Tarea» / «→ Para hablar» (`LineToTask`, `createTaskFromLine` en `noteActions.ts`): la línea pasa por `parseCapture`
  (persona, #proyecto, fecha, !1…; "@Diana: …" pierde los dos puntos), la tarea va al proyecto de la línea o al de la nota y
  la línea recibe `[[t:id]]`, así enseña «✓ Tarea» con su estado y no se duplica. Un solo «Deshacer».

## Fase 29: feedback de los usuarios (rama `feedback`)

- **Supabase** (`supabase/migrations/006_feedback.sql`, después de 001 a 005): tabla `feedback` (autor, nombre y usuario en el
  momento, `kind: improvement | bug | other`, texto, pantalla, navegador, `status: new | doing | done | dismissed`, `task_id`).
  Nadie la lee directamente: `send_feedback` (cualquier cuenta activa, máx. 30 por hora), `admin_feedback` y
  `admin_update_feedback` (solo administradores). Al darse de baja, el feedback se queda sin autor enlazado. Test en
  `tests/supabase.test.ts`.
- **Botón flotante** «Feedback» abajo a la derecha en todas las pantallas (`features/feedback/FeedbackButton.tsx`; se aparta
  cuando el panel de detalle es columna): tipo (Mejora · Algo roto · Otro) y texto; la pantalla (`location.hash`) y el
  navegador van solos. Lo enviado se sigue en «Mis solicitudes» (ver migración 016, más abajo).
  Con una ficha de Rally abierta (`RallyDetailPanel` pone `data-side-panel` en el body) el botón se aparta a la izquierda de la
  ficha (y en pantallas estrechas, donde la ficha ocupa todo, se esconde), para no tapar «Guardar cambios».
- **Más → Feedback** (`#/feedback`, solo administradores en la barra lateral y en la pantalla): filtros por estado (Abiertos =
  Nuevo + En curso) y tipo, cambiar el estado y «→ Tarea» (tarea con etiqueta `feedback`, el texto y los datos en la
  descripción; el feedback guarda `task_id` y pasa a En curso si era Nuevo). Si falta la migración, el error lo dice.

- **Formulario** (migración `007_feedback_formulario.sql`, después de 006; rama `feedback-formulario`): pestañas Algo no
  funciona · Mejora · Idea nueva · Duda (`bug | improvement | idea | question`; `other` queda para lo antiguo), parte de la
  web obligatoria (`FEEDBACK_AREAS`, propuesta sola con `areaForHash`, o «Ficha de una tarea» si el panel está abierto; solo las
  pantallas que esa persona ve, `feedbackAreas` con `hiddenScreens` de Ajustes → Pantallas, y Analítica solo para administradores),
  frase obligatoria (`title`), detalle opcional, «¿Cuánto te afecta?» solo en Algo no funciona (`impact`, que da la
  prioridad de la tarea: !1 · !2 · !3) y tamaño de pantalla. Función nueva `send_feedback_form` (la vieja `send_feedback`
  sigue para las pestañas abiertas con la versión anterior). Sin capturas, a propósito. En Más → Feedback: frase en
  negrita, parte de la web e impacto, y filtro por parte de la web.

## Fase 30: primera tanda del feedback (rama `feedback-tanda-1`)

- **Menciones en Rally**: la caja de la discusión y el «Mensaje» usan `MentionTextarea` («@» + 2 letras busca en Rally; Enter,
  Tab o clic la elige). `comment` acepta `mentions` (como `messagePost`, con `mentionsFor`) y, sin menciones, publica igual
  que antes. `unlinkedMentions` avisa y bloquea si queda una «@Nombre» sin enlazar (no avisaría). En el «Mensaje», cada
  persona de la plantilla tiene que elegirse en Rally.
- **Preparar mensaje** del panel: en tareas enlazadas a Rally abre `RallyMessage` sin `onConfirm` (Copiar y Publicar en
  Rally, sin tocar Ready); en el resto, el preparador de siempre (Copiar y Teams).
- **Tablero** (`BoardColumns`, `board-display` en localStorage; «Compactas» y «Campos» van en la fila de filtros, `BoardDisplayButtons`, y `usePersistentState` mantiene igual los componentes con la misma clave): alto máximo de la pantalla con scroll por columna (la barra
  horizontal siempre a la vista), columnas plegables (botón siempre visible en la cabecera), tarjetas «Compactas» y «Campos» (etiquetas, proyecto, ID, fecha e
  iconos, personas, Owner). Los títulos largos se cortan dentro de la tarjeta.
- **Completar una tarea enlazada a Rally** (circulito, tecla C, barra en bloque, panel) pide confirmación
  (`confirmRallyToggle`), porque también la mueve en Rally.
- **Revisión semanal**: los pasos muestran cuántas tareas tienen (no un número de orden).
- **Pantalla Rally**: ID, Owner y Estado se ensanchan arrastrando el borde de la cabecera (`rally-widths`).
- Modo oscuro: los botones claros con `hover:bg-X-100` llevan su `dark:hover`.
- **Notas**: las secciones (proyectos) se renombran con doble clic en la lista o con el lápiz junto al nombre, encima de las
  páginas (`repo.updateProject`, con «Deshacer»).
- **Buscador en la pantalla Rally** (`RallySearch`): filtra la lista cargada (ID, nombre, personas, proyecto, iteración,
  etiquetas) y busca en todo Rally por ID o palabra (`pick` admite ahora TS, TA y DS); un resultado abre su ficha (`lookup`).
- **Grupos de personas**: la tarjeta es un `div` que abre la ficha (no un enlace: dentro va el botón del grupo) y la
  información va en dos filas para no montarse.
- **Tareas fijas del equipo** (`domain/routines.ts`, `TEAM_ROUTINES`): lunes «Rellenar los objetivos de la semana…» y viernes
  «Rellenar la gestión de la demanda», recurrentes semanales (serie `rutina:<id>`, etiqueta `rutina`, prioridad 2, `url`
  opcional). `AppContext` las crea una vez por cuenta tras la primera sincronización (`SyncState.pulled`) y las apunta en
  `settings.routines_added` (sin migración): si alguien las borra, no vuelven. Para añadir otra, se añade a la lista.
  **No se ven hasta su día** (rama `arreglos-noviembre`): la siguiente ocurrencia de una rutina (`isHiddenRoutine`: serie
  `rutina:`, pendiente y con fecha futura) se quita de `AppContext.tasks`, así al completar la del lunes no vuelve a salir hasta
  el lunes siguiente; lleva aviso a las 9:00 de ese día (`nextOccurrenceTask`, `ROUTINE_REMIND_HOUR`). Las atrasadas sí se ven.
- **Panel del feedback** (`FeedbackDashboard`, `feedbackStats`), hoy vista «Panel»: recibidos, abiertos, sin mirar, % resuelto, días hasta Hecho,
  barra de estados, recibidos y cerrados por semana, por parte de la web, por tipo (con fallos abiertos por impacto) y quién
  envía. Pulsar una cifra lleva a la Lista con ese filtro.
- **Más → Feedback con tres vistas** (`feedback-view`): **Lista** (como antes, con filtro por estado), **Tablero** (columnas
  Nuevo · En curso · Bloqueado · Hecho · Descartado; arrastrar cambia el estado, al momento en pantalla y vuelve atrás si
  Supabase falla; columnas plegables como en el Tablero, `feedback-board-collapsed`; clic en la tarjeta despliega el detalle, el estado y «→ Tarea») y **Panel**. Las tres vistas ocupan todo
  el ancho y comparten cabecera y filtros (estado, tipo, parte de la web, impacto, persona y texto); en el Tablero, el
  estado deja solo sus columnas y el Panel cuenta lo filtrado. El estado `blocked` necesita la migración
  `008_feedback_bloqueado.sql` (después de 007); sin ella, el error lo dice.

- **Mis solicitudes** (migración `016_mis_solicitudes.sql`, después de 006 a 008; nov 2026, cambia la decisión de que el
  usuario no viera lo enviado): `my_feedback()` devuelve a cada cuenta solo lo suyo (sin navegador, tarea ni usuario) con su
  estado. Columnas `reply` y `reply_at`: el administrador escribe una respuesta opcional en cada feedback (`ReplyBox`, se
  guarda al salir del campo, `admin_reply_feedback`; vacío la quita). Para quien no es administrador, `#/feedback` es «Mis
  solicitudes» (`MyFeedback`: Todas/Abiertas, estado, respuesta y último cambio) y sale en Más con ese nombre; el
  formulario del botón enlaza allí.

- **Editar lo propio mientras está en Nuevo** (migración `019_editar_mis_solicitudes.sql`, después de 001 a 018; feedback, nov
  2026): en «Mis solicitudes», clic en una solicitud en Nuevo (o «Editar») abre el mismo formulario (`FeedbackDialog` con
  `editing`) relleno: tipo, parte de la web, frase, detalle e impacto. `edit_my_feedback` solo deja a su autor y solo con estado
  `new` (lo comprueba Postgres); en cuanto un administrador la mueve, ya no se edita. Cambia `updated_at`.

- **Orden de prioridad** (migración `017_feedback_orden.sql`, después de 016): columna `rank` (1 = lo primero; null = sin
  ordenar) y `admin_order_feedback(ids)`, que pone a cada id su posición y no cambia `updated_at`. En Lista y Tablero el
  feedback sale en ese orden (`sortFeedback`: lo sin ordenar arriba, el más nuevo primero; después por `rank`). En la Lista
  se ordena con el asa (solo el asa arrastra, para poder escribir la respuesta) o con las flechas; en el Tablero, soltando
  encima de otra tarjeta (mitad de arriba = antes; si viene de otra columna, además cambia de estado). `moveFeedback`
  recoloca sobre la lista entera, así ordenar con filtros no desordena lo que no se ve. El número `#n` es la posición en lo
  que se ve (lista filtrada o columna). Quien envió el feedback no ve el orden.

## Fase 31: pantalla Rally como la lista de Rally (rama `rally-como-rally`)

Petición de la usuaria (nov 2026): parecerse a la «React Custom List» del dashboard de Owners de etiquetado, que el equipo
ya usa.

- **Cabecera**: buscador (`RallySearch`, desplegable con los resultados de todo Rally) · Nuevo en Rally · Crear con
  petición · Actualizar · Desconectar (discreto). `RallyItems` pone la cabecera; `RallyView` solo la del formulario de conexión.
- **Proyecto en un desplegable** (`ProjectPicker`): recientes (`rally-recent-projects`), buscador, todos los proyectos con
  casillas (varios a la vez) y «Ver también» ↑ padres y ↓ hijos (`rally-scope`, los dos marcados por defecto). La primera
  vez se elige Team.Digital Data (`rally-projects-v2`, null = nunca elegido); después, lo último. Sin proyectos = lo
  asignado a mí. `projects()` trae `parentId` y `itemsReport(…, scope)` suma hijos (todos los niveles) y padres
  (`projectScope`, máx. 300, lista de proyectos en caché 10 min).
- **Sin periodo**: siempre todo lo de los proyectos elegidos (`days = 0`).
- **Un solo recuadro de filtros**: en una línea Proyecto · Asignado a mí · Vista · Etiquetas; debajo los tipos (en el orden
  US TS DE FE TC TA DS), «Ocultar terminadas». Sin «Solo lo mío», Persona ni «Agrupar por» (siempre por columnas del tablero). «Columnas» va en la cabecera de la
  lista. «Pasar a mis tareas del gestor, en [proyecto] · Crear N tareas» (antes «Añadir al gestor en») en una sola fila.
- **Orden por Rank** (`DragAndDropRank`, `RallyItem.rank`, `byRank`: como texto; sin Rank, al final).
- **Vistas guardadas** (`domain/rallyViews.ts`, `RALLY_VIEWS`, `rally-view`): las 15 de Rally con sus nombres. Condiciones
  sobre etiquetas, Flow State, nombre y Ready; mismo campo = o, campos distintos = y (`inRallyView`); con `all: true` (la 05,
  Onboarding y ANA_etiquetado) el mismo campo también es y. Se aplican sobre lo
  cargado, antes del filtro por tipo y el buscador. Para cambiar una, se edita ese archivo.

## Arreglos de noviembre (rama `arreglos-noviembre`)

- **Pantalla Proyectos** (`#/projects`, `features/views/ProjectsView.tsx`): el título «Proyectos» de la barra lateral la abre,
  igual que «Grupos» abre la suya. Alta de proyectos y un bloque por proyecto con pendientes, atrasadas y notas (con sus
  subproyectos) y una tarjeta por subproyecto.
- **Personas analizadas** (Más → Analítica, botón «Personas»): `settings.analytics_people` (ids de cuenta; null = todas, sin
  migración) se guarda en los ajustes de quien mira, no en el código (el repositorio es público). `restrictReport` deja solo
  esas cuentas en las pestañas de uso. **«Rally: herramienta o Rally»** tiene su propio botón «Personas de Rally»
  (`settings.analytics_rally_people`, nombres de Rally; null = todas): lista quien ha hecho cambios en el periodo y cuenta solo
  los suyos (`changesBy`), tengan o no cuenta. Los nombres se comparan con `personKey` (sin tildes, guiones ni espacios), también
  en «Tiene cuenta».

## Marca Marea (rama `rebranding-marea`, nov 2026)

Marca en `~/Downloads/marea-brand` (manual, `marea.css`, `tokens.json`, logos). Objetivo: que nada deje de funcionar.

- `src/styles/marea.css` (copia de la marca, sin el `@import` de fuentes, que va con un `<link>` en `index.html`) se importa
  antes de Tailwind en `index.css`. Fuentes: Space Grotesk 700 (titulares `h1`/`h2` y el nombre) e Inter 400/600 (el resto).
- **Sin tocar los componentes**: en `@theme` las escalas `indigo` (el color principal) y `zinc` (grises) usan los colores de
  la marca (`marc` #1B2B4B y sus tintes; neutros surface, line, ink-muted… y los fondos del tema oscuro). En tema oscuro, unas
  reglas en `index.css` pasan el botón principal (`bg-indigo-600`) a blanco con texto `on-marc`, los textos azules a un tinte
  claro y `text-zinc-500/600` a `ink-muted`, para que nada desaparezca sobre el fondo marino.
- Coral (`--marta`) solo en el check de tarea hecha (filas, pasos, acciones de notas); hecha = check + tachado en `ink-muted`.
- Logo: `components/ui/MareaLogo.tsx` dibuja el lockup en la página con `var(--marc)`/`var(--marta)` (en oscuro queda como
  `marea-lockup-dark.svg`) y el nombre en Space Grotesk (en un `<img>` no cargaría la fuente). Barra lateral y entrada.
- `index.html`: título «Marea», `theme-color` #1B2B4B, favicon de la marca. PWA: nombre «Marea», iconos PNG sacados de
  `marea-app-icon.svg` (192, 512, `pwa-maskable-512.png` a sangre y `apple-touch-icon.png` de 180). Logos en `public/logos/`.
- Foco de teclado: anillo de 2 px `--focus` separado 2 px en botones, enlaces, selects, casillas y similares.
- **Barra lateral** (`.mr-sidebar` en `index.css`): siempre en el azul marino de la marca (`navy-900`), en claro y en
  oscuro, para reconocer la herramienta de un vistazo. Dentro valen los colores del tema oscuro de Marea (logo blanco y coral)
  y, en claro, se redefinen ahí las escalas `zinc`/`indigo`/`white` para que sus clases se lean sobre el azul marino. Cada
  sección (vistas, Proyectos, Grupos, Más) va en su bloque (`.mr-side-section`) con su título en estilo `label`; lo abierto,
  con fondo claro y una barra coral a la izquierda (`.mr-nav-active`). La zona de trabajo en claro lleva un 3,5 % del azul
  de la marca en vez de blanco puro (tarjetas, paneles y campos siguen en blanco).
- **Paleta de Marea** (`domain/colors.ts`, `BRAND_COLORS`): proyectos, grupos, etiquetas y avatares solo con colores de la
  marca y dos mezclas suyas, en un orden comprobado con el validador de paletas. Avatares con texto blanco o azul marino
  según el fondo (`textOn`). Los colores ya guardados de las paletas de antes se pasan una vez por cuenta al entrar
  (`repo.applyBrandColors`, en el historial sin aviso, `settings.brand_colors_done`; las etiquetas, solo en sesión de admin;
  los colores elegidos a mano fuera de esas paletas no se tocan). Reuniones del calendario y «Hoy» en el azul de la marca.
  Se mantienen a propósito: columnas del Tablero, colores de los tipos (US, TS…), prioridades, estados y la analítica.

## Fase 32: analítica de uso (rama `dev`, nov 2026)

- **Supabase** (`009_analitica.sql` y `010_analitica_kpis.sql`, después de 001 a 008): tabla `usage_events` (persona, tipo,
  pantalla, `name`, `detail`, `value` y día de Madrid), sin lectura directa. Tipos: `session` (entrada), `screen` (visita),
  `visit` (segundos a la vista), `quality` (visita de calidad: 15 s a la vista o una acción), `action` (algo hecho; `value` =
  cuántas cosas) y `state` (preferencia; cuenta la última). `log_usage` solo admite claves `[a-z0-9-]` y detalles
  `[a-z0-9_.,:-]` (nunca textos ni ids), tope de 5.000 por persona y día, borra lo de hace más de 400 días.
  `admin_usage(desde, hasta)` (solo administradores) da cuentas con `snapshot` (`usage_snapshot`: recuentos de sus tareas,
  notas, secciones, tareas salidas de notas, grupos, fichas y Rally conectado, calculados de `records`), filas agrupadas y
  la última preferencia de cada uno.
- **App**: `features/usage/track.ts` (`startVisit`, `track`, `trackAuto`, `trackState`) y `UsageTracker` (en `Shell`): entrada
  por carga y al volver tras 30 min, visitas con tiempo a la vista y calidad, y del historial (`historyActions`) tareas,
  notas y proyectos creados y cambios de estado (lo que trae Rally cuenta como `rally-in`, `cameFromRally`). `logUsage` va
  por `fetch` con `keepalive` y no avisa si falla. Acciones con `track` en Rally (`rallyApi`: mover, comentarios, ediciones,
  adjuntos; analista; altas por formulario/petición/tarea; botones y columnas de la pantalla; «Pasar a mis tareas» una o
  todas, con o sin proyecto), Calendario (`calendar-tasks`, Unirse, reuniones por doble clic/persona/Rally, «Nuevo»), Notas
  (tareas desde acciones o líneas, secciones), Proyecto (botones de la cabecera), Grupos, Personas (chat, renombrar,
  eliminar), Revisión (empieza/acaba) y Feedback (abrir, enviar, cancelar).
- **Más → Analítica** (`#/analytics`, `UsageView`, solo administradores): vista Equipo o una persona, 7/30/90 días; KPIs por
  pantalla (`domain/usageKpis.ts`, `screenKpis`: visitas, de calidad, tiempo medio, personas y los KPIs de `kpi.docx`), tabla
  por persona (en Equipo) y por día. Aviso en Ajustes → Mi cuenta y aviso si falta la migración 010.
- **Diseño en panel** (rama `analitica-dashboard`): pestañas (`analytics-tab`) **Resumen** (cifras con icono y barra,
  actividad diaria en barras, adopción con quién no ha entrado, pantallas más usadas con la parte de calidad, lo más
  destacado; pulsar lleva a su tarjeta), **Por pantalla** (las mismas tarjetas de KPIs, con barras para porcentajes,
  personas y desgloses), **Personas** (solo Equipo: estado, barras y últimos 14 días) y **Día a día** (mapa de calor).
  Cálculos en `domain/usageDashboard.ts` (`screenRanking`, `activitySeries`, `adoption`, `percentOf`, `heatLevel`).
  Un color por pantalla (`.scr-<pantalla>` con `--scr` en `index.css`, paleta categórica de ocho; el resto en gris).
- **Periodo libre** (`domain/usageRange.ts`, `analytics-range`): atajos (7/30/90 días, esta semana, semana pasada, este mes,
  mes pasado, 3/6/12 meses), una semana o un mes concretos, o de un día a otro (máx. 400 días atrás). Las flechas mueven el
  periodo con su duración (meses enteros, mes a mes). Se pide también el periodo anterior de la misma duración y las cifras
  del Resumen muestran la variación. La evolución se agrupa por día, semana o mes (`bucketSeries`, `analytics-granularity`;
  por defecto según la duración).
- **Rally: herramienta o Rally** (pestaña de Analítica, solo Equipo; migración `011_rally_herramienta.sql`): de los cambios
  hechos en Rally en el periodo y los proyectos elegidos (`analytics-rally-projects`, con hijos por defecto), cuántos salen de
  la herramienta. Rally no guarda el origen, así que `rallyApi` apunta cada escritura (`log_rally_tool`: tipo
  `comment | attachment | change | create`, huella SHA-256 de 16 caracteres del ID y hora; nunca el ID ni el texto) y
  `GET /api/rally/activity` (`Rally.activity`) lee discusiones y adjuntos (WSAPI, `Artifact.Project.ObjectID`) y el
  historial (Lookback API: instantáneas con `_PreviousValues` de FlowState, Ready o Blocked, y `_SnapshotNumber` 0 = altas)
  con la clave de quien mira. `matchTool` (`domain/rallyActivity.ts`) cruza mismo tipo, misma huella y menos de 5 minutos;
  lo anterior al primer apunte (con 5 min de margen) cuenta, salvo con «Contar solo desde que se mide»; lista de cambios leídos para comprobar. Por tipo, por semana y por persona de Rally («Tiene cuenta»
  compara el nombre con las cuentas).
  **Detalle de una persona** (feedback, nov 2026): en «Por persona», clic en la fila despliega `PersonDetail`
  (`personActivity`): qué ha hecho por tipo (herramienta / Rally), a qué columnas ha movido elementos, los elementos que más
  ha tocado y la lista de sus cambios (lo de antes de medir, atenuado). «Cambios» enseña el total (el reparto, en el título).
  Pulsar un ID (en la lista o en «Elementos que más ha tocado») abre a la derecha la ficha de Rally de ese elemento
  (`ItemPanel`: `lookup` + `RallyDetailPanel` con `floating`: a toda la altura, también en pantallas anchas) y deja en la lista solo sus cambios («Solo US…»);
  cerrar la ficha no quita el filtro; se desmarca volviendo a pulsar el mismo ID, con la × del aviso o con «Ver todos».

## Fase 33: otro calendario por enlace ICS (rama `dev`, nov 2026)

Petición de la usuaria: ver en el gestor el calendario de La Caixa (su enlace ICS publicado sí trae los títulos) junto al
de Outlook de WPP, también en la app publicada.

- **Servidor** (`servidor/icsExtra.ts`): `IcsExtra` descarga el .ics (`downloadIcs`, compartida con `calendar.ts`), lo
  recorta con `trimIcs` (−45/+120 días; las recurrentes y sus excepciones siempre, y las zonas horarias) para no pasar el
  límite de respuesta de Vercel, y lo devuelve con su nombre. Rutas `icsExtraRoute` (`/api/calendario-extra`, `connect`
  con `url` y `name`, `disconnect`, `ics`), iguales en el Mac (`SqliteIcsAccounts`, tabla `ics_extra_accounts`) y en
  Vercel (`api/calendario-extra.ts` + rewrite en `vercel.json`; `SupabaseIcsAccounts`: enlace cifrado con `RALLY_SECRET`
  en `connector_accounts`, conector `calendario-ics`). El enlace nunca vuelve al navegador.
- **Supabase**: `012_calendario_ics.sql` (después de 001 a 011) solo amplía el check de `connector_accounts.connector`.
- **App** (`features/calendar/outlook.ts`): `loadOutlook` carga también el otro calendario (`loadExtra`, en el `finally`:
  un fallo no afecta a Outlook). `useMeetings` mezcla sus reuniones con `calendar: <nombre>` y uid `extra:…`. Salen en
  verde (`EXTRA_COLOR`) en la agenda, la lista y el mes, con su interruptor en «Mis calendarios» (`calendar-extra`) y
  «Calendario X» en la ficha; su «Unirse en el navegador» abre siempre Teams web con `teamsWebUrl` (launcher con `msLaunch=false`, para enlaces `/l/meetup-join/` y los cortos `/meet/`, que traen casi todas; para que la página de Teams no lance la app, que va con la cuenta de WPP). Ajustes → Calendario de Outlook → «Otro calendario» (`ExtraSettings`): nombre y enlace.
  Un solo calendario extra por persona.
- **Zonas horarias** (`domain/timezones.ts`, nov 2026): una hora con `TZID` ya no se toma como hora de aquí; se pasa de
  esa zona a la de quien mira (una reunión puesta desde Argentina a las 10:00 sale a las 14:00 en Madrid, 15:00 en verano).
  Por orden: el `VTIMEZONE` del propio .ics (reglas STANDARD/DAYLIGHT con `BYMONTH` y `BYDAY`), el nombre IANA con `Intl` y
  los nombres de Windows más habituales (`WINDOWS_ZONES`); una zona desconocida se deja como viene. Las repeticiones se
  cuentan en los días de la zona de la reunión y cada una se convierte (cambia de hora aquí con el cambio de horario), y la
  hora de fin sale de la duración. Tests en `tests/timezones.test.ts`.
- **Reunión nueva con entorno** (`NewMeeting`, `meeting-env` en localStorage): WPP abre Teams como siempre
  (`teamsMeetingUrl`, app o navegador según Ajustes); La Caixa (el nombre del otro calendario) abre la reunión rellenada en
  **Outlook web** (`outlookWebMeetingUrl`, `outlook.office.com/calendar/deeplink/compose` con `online=true`) en una pestaña,
  para crearla con esa cuenta. Teams web no admite crear reuniones por enlace (sale «Teams clásico ya no está disponible»).
  La pendiente lleva `calendar` y se quita al llegar del otro calendario (`realMeetings` lo incluye).
- **Directorio de La Caixa en «Reunión nueva»** (nov 2026; su .ics no trae asistentes y un flujo en su entorno sacaría su
  calendario fuera): en «Asistentes», desde 3 letras, la extensión (1.7.0, operación `people` de `spDocs`) busca lo escrito
  con la sesión de SharePoint de la persona, como «Compartir» en SharePoint (`clientPeoplePickerSearchUser`; si no deja, el
  buscador de personas de SharePoint), en un sitio por dominio de las carpetas guardadas (`directorySites`). Bloque
  «Directorio de La Caixa» con nombre, cargo y email (`useDirectory`, `features/calendar/directory.ts`). Solo se busca lo
  escrito y se queda en memoria; Marea no guarda ningún listado.
- **Personas de La Caixa** (`isCaixaEmail`: `@caixabank.com`, `@proveedorexterno.com` y sus subdominios, `CAIXA_DOMAINS`):
  en su ficha, «Chat en el navegador» abre Teams web sin la app (`teamsWebUrl` admite también `/l/chat/…`, tipo `chat`) y
  «Nueva reunión» abre con el entorno La Caixa ya elegido (`NewMeeting` `env`), aunque Ajustes diga abrir Teams en la app.

## Fase 34: Microsoft List con un marcador, sin Power Automate (rama `dev`, prueba, nov 2026)

Petición de la usuaria: volver a traer la Lista (quitada en la fase 26) sin flujos. Sin app en Entra ID no hay Graph, y la
API de SharePoint no admite CORS, así que lo hace un **marcador del navegador** que se pulsa en la página de la lista.

- **Marcador** (`features/mslist/bookmarklet.ts`, `bridge` convertido en texto con `toString()`: no puede usar nada de fuera
  de la función; un test lo ejecuta suelto y se ha comprobado minificado). En la página `…/Lists/<nombre>/…` usa la API REST
  de SharePoint con la sesión de la persona (`GetList(@u)`, `odata=nometadata`): columnas visibles (`/fields`), elementos
  de 1000 en 1000 (`odata.nextLink`, personas y búsquedas con `$expand`) y escribe con MERGE (`X-RequestDigest` de
  `/_api/contextinfo`). Abre Marea (`#/lista`, ventana `marea-lista`) y hablan por `postMessage`: «hello» cada 700 ms hasta
  que Marea contesta `ready` con los cambios pendientes; los aplica, relee la lista y la manda (`data`, con el resultado de
  cada cambio). Editables: texto, nota, opción, varias opciones, número, moneda, fecha y sí/no (personas y búsquedas, solo
  lectura). Si la página no deja ejecutar marcadores, «Copiar el código» para pegarlo en la consola.
- **Marea** (`ListaBridge` en `Shell`): solo acepta mensajes de `https://<x>.sharepoint.com` (`isSharePointOrigin`) y valida
  lo recibido (`parseSnapshot`, `domain/msListParse.ts`). Columnas por su **nombre visible** («Título» para el título).
- **Prueba sin servidor**: lista, cambios pendientes, errores y configuración en localStorage de ese navegador
  (`listaStore.ts`: `lista-snapshot`, `lista-pending`, `lista-errors`, `lista-config`). `addPending` deja un cambio por
  elemento y columna; `remainingPending` quita los aplicados y los que la lista ya refleja; `withPending` enseña los valores
  pendientes ya puestos (y con ellos se mueven las tareas enlazadas, así no se deshace un cambio).
- **En el gestor** (`#/lista`, «Lista» debajo de Rally; lógica de la fase 23 en `domain/msList.ts`): columna de estado y su
  correspondencia con las columnas del Tablero, «Pasar a mis tareas» (`LS-<id>`), estado en la tabla y ficha lateral con todos
  los campos (los cambiados en ámbar, «deshacer» un pendiente). Mover una tarea enlazada apunta el cambio (`pushToList`).
- **Conexión que se queda** (sin servidor no se puede quitar el clic del todo: solo el código de una página de SharePoint
  puede escribir en la lista): tras pulsar el marcador una vez, mientras su pestaña siga abierta, pregunta cada 4 s
  (`marea-lista:hello`; recuadro abajo a la derecha, clic para encoger) y Marea contesta con los pendientes y `wantList`
  (lista entera cada 2 min, `LIST_EVERY_MS`). Además Marea **manda el cambio al momento** a la pestaña conectada
  (`subscribeLista` en `ListaBridge`), porque Chrome espacia hasta un minuto los temporizadores de las pestañas ocultas. Los
  que fallaron solo se reintentan con la relectura de cada 2 min. Volver a pulsar el marcador para el anterior
  (`__mareaListaStop`); si se cierra la pestaña de Marea, se para y lo dice. Varias pestañas de Marea comparten lista y
  cambios por localStorage (evento `storage`); «Conectado» = «hola» de hace menos de 20 s (`lista-contact`, `isConnected`).

- **Extensión de Chrome «Marea · Lista»** (sin tener SharePoint abierto; Chrome abierto y sesión de SharePoint iniciada):
  carpeta `extension/` (`manifest.json` MV3 con `host_permissions` `https://*.sharepoint.com/*` y `scripting`; `content.js`
  en las páginas de Marea, localhost y las dos de Vercel; `background.template.js`). `scripts/build-extension.mjs` (al final
  de `npm run build`) compila con Vite `features/mslist/spWork.ts` (el trabajo en SharePoint, **común con el marcador**:
  `bridge(app, work)` lo recibe como argumento; sin imports y autocontenido, porque viaja como texto), lo mete en
  `background.js` y deja `dist/marea-lista/` y `dist/marea-lista-extension.zip` (se descarga en Lista → Conectar y se
  instala con «Cargar descomprimida»). En segundo plano llama a la API REST con la sesión; si SharePoint da 401/403, lo hace
  en una pestaña fijada de la lista (`chrome.scripting.executeScript` con `pageJob`). Solo atiende a su `content.js`
  (`sender.id`, `sender.tab`), solo listas `https://<x>.sharepoint.com/…/Lists/…` y de una en una.
- **Marea con la extensión** (`features/mslist/extension.ts`: `marea-ext:ping|hello|sync|result` por `postMessage` del mismo
  origen; `useExtensionSync` en `ListaBridge`): con la dirección de la lista (`lista-url`, `normalizeListUrl`, o la de la
  última lectura) aplica los pendientes al momento (400 ms tras un cambio, en cualquier pestaña) y relee cada 2 min (mira
  cada 20 s). Una sola pestaña sincroniza (`navigator.locks`, `marea-lista-sync`). `lista-ext` guarda cuándo fue bien y el
  último error; «Sincronizada» = bien hace menos de 5 min (`extensionOk`). El marcador sigue como alternativa.

- **Buscar como en SharePoint** (`domain/msListView.ts`, funciones puras con tests): **vistas** de la lista
  (`MsListSnapshot.views`: `spWork` lee `/views` y, para cada una, pide a SharePoint sus elementos con `GetItems` y el CAML de
  la vista sin su tope de página, así filtro y orden (también `[Me]`, `[Today]`…) los aplica SharePoint; guarda sus columnas
  y su agrupación) en pestañas, «Todos» = sin vista; **Filtros** (`FiltersPanel`: casillas con recuento por valor en
  opciones, búsquedas, personas, sí/no y texto o número con hasta 25 valores; desde/hasta en fechas; «(Vacío)»; misma
  columna = o, distintas = y); **Agrupar** (plegable, en el orden de las opciones; por defecto, el de la vista) y
  **Ordenar** (por defecto, el de la vista o por ID; vacíos al final). Búsqueda por todas las palabras sin tildes. Se
  recuerdan en `lista-view`, `lista-filters`, `lista-group` y `lista-sort`. Las listas leídas antes no traen vistas.
- **Mis vistas** (feedback, nov 2026; `SavedViews` en `ListaView.tsx`, `ListaSavedView` en `domain/msListView.ts`): lo que se
  ve (vista de SharePoint, filtros, agrupar, ordenar, «ocultar terminados» y búsqueda) se guarda con un nombre («Vista
  Matías» con el filtro Líder técnico) en `settings.lista_views` (de cada persona, sin migración: zod pone `[]`; se
  sincroniza y entra en las copias). Un clic la aplica (la activa, en azul, se reconoce con `isSameListaView`); si se cambia
  algo, «Guardar cambios en «X»»; guardar con el mismo nombre la sustituye (`saveListaView`); la × la borra. El título del
  botón resume la vista (`describeListaView`).
- **Crear elementos** («Nuevo elemento» y «Crear con petición» en la cabecera de la Lista; `NewListItem.tsx`): formulario
  con el título y las columnas que se pueden rellenar (obligatorias con *, `required` y `defaultValue` de SharePoint en
  `MsListField`), «Crear también la tarea en Marea» con proyecto, y pie Descartar · Crear y otro · Crear. Las altas van a
  `lista-creates` (`MsListCreate`, clave `new:<uuid>`) y viajan con los cambios (`outgoing`: primero las altas, después los
  cambios; los que fallaron solo con la relectura); `spWork` las crea con POST `/items` en `odata=verbose` con
  `ListItemEntityTypeFullName` y devuelve el ID y las columnas que no ha podido rellenar (`skipped`). `receiveSnapshot`
  devuelve las creadas y `afterCreated` crea su tarea enlazada (`LS-<id>`). «Por crear» se ve encima de la tabla (con la × se
  quita). **Petición** (`domain/msListRequest.ts`, `parseListRequest`, sin IA): reconoce los nombres de las columnas (o su
  primera palabra si es única) seguidos del valor, opciones sueltas que solo están en una columna, una fecha suelta si hay
  una sola columna de fecha, y el título entre comillas o al principio; lo demás, «No entendido».
- **Tipo «Lista» en el Tablero** (`LIST_TYPE_ID = 'lista'`, abreviatura LS): un estado por cada valor de la columna de
  estado (las opciones de la columna, en su orden; ids `lista-<valor>`) con el grupo de «Estados» (`listItemType`; siempre
  hay uno de Por hacer y uno de Hecho; «dependencia» cuenta como Bloqueado). Lo crea y lo ajusta la sesión de un
  administrador (`repo.ensureListType`, desde `useListType` en `ListaBridge`; las tareas en estados que desaparecen pasan
  al equivalente) y, en cualquier sesión, las tareas `LS-<id>` que siguen como Tarea pasan a «Lista». Las tareas nuevas de
  la lista se crean ya de ese tipo. Con él los estados van **uno a uno** en los dos sentidos: `listMoves` busca el estado
  con el nombre del valor y `listPushes` manda cualquier cambio de estado con su nombre (`stateName`), aunque sea del mismo
  grupo; sin coincidencia, por grupo como antes.
  Con **solo «Lista»** elegido en los tipos, el Tablero (y el de cada proyecto) usa sus estados como columnas (`Board` con
  ese tipo, en `BoardContent`) en vez de las 7 de Rally; soltar una tarjeta llama a `setState` y el cambio va a la lista.
  Con **todos los tipos** (las 7 columnas de Rally), los elementos de la Lista van por su estado y no por su grupo (petición
  de la usuaria, nov 2026; `listBoardColumn`): backlog → New, in progress → In-Progress, dependencia → Need Review y
  completada → Accepted (sin mayúsculas ni tildes, con variantes como «in progres» o «en curso»). Solo se
  pueden soltar en esas cuatro columnas (`LIST_DROP_COLUMNS`, `listStateForColumn`): en Defined, Blocked o Completed no se
  mueven y sale un aviso. Solo afecta a las tareas de tipo Lista.
- **Versión de la extensión**: al cambiar `spWork` o la extensión, sube `version` en `extension/manifest.json` y
  `LATEST_EXTENSION` en `features/mslist/extension.ts` (un test comprueba que coinciden); si la instalada es anterior, la
  pantalla Lista avisa y explica cómo actualizarla (descargar, sustituir la carpeta y recargar en `chrome://extensions`).

## Fase 35: Asistente sin IA (rama `dev`, nov 2026)

Petición de la usuaria: algo a lo que preguntar y pedir cosas sobre el proyecto, para todo el equipo y **sin gastar tokens**
(un MCP siempre pasa por una IA, así que se hizo un asistente propio). Pantalla `#/asistente` («Asistente», debajo de Notas).

- **Intérprete** (`domain/assistant.ts`, `parseIntent`, con tests): tareas con periodo (hoy, atrasadas, mañana, esta semana,
  la que viene, próximos 7 días, sin fecha, Mi día), persona (`findPerson`: nombre completo o de pila, con o sin @), proyecto
  (`findProject`: nombre o `#token`, con subproyectos) y estado (bloqueadas, en curso, hechas); IDs (`US1234`); lo hecho
  (hoy, ayer, esta semana, la pasada, este mes, del registro); «qué dijo X» (`mentionsOf`), «temas para hablar con X»,
  «quién es X». **Órdenes**: «crea una tarea …» (pasa por `parseCapture` y `submitCapture`: fechas, #proyecto, @persona,
  !1…), «recuérdame …», «crea una nota Título: texto», «completa / reabre / pon X en curso / mueve X a mañana / pospón X /
  añade X a mi día» (`matchTasks` por título; si hay varias, se elige; todo con «Deshacer»). Lo demás, a buscar.
  «¿Qué tengo?» / «¿qué cosas tengo pendientes?» dan las tareas de hoy solo si no dicen nada más (`onlyAsksTasks`): «qué evar
  se usan para las cosas de onboarding» va a buscar.
- **Buscador** (`domain/knowledge.ts`): trozos de tareas, notas (por apartados), personas, proyectos y documentos
  (`splitSections`: títulos Markdown, líneas en mayúsculas o terminadas en «:», párrafos de ~700 caracteres) con BM25
  (`SearchIndex`: título doble, todas las palabras y frase exacta pesan más, prefijos de 4+ letras), palabras sin tildes,
  vacías ni plurales (`terms`, `stem`) y el trozo que mejor responde con las palabras marcadas (`snippet`).
  **Erratas y sinónimos** (nov 2026): una palabra que no sale en ningún sitio se cambia por la más parecida que sí sale
  (`SearchIndex.fix`, `editDistance` con transposiciones: 1 letra, 2 en palabras de 8 o más; «onboardinf» → onboarding), y
  cada palabra busca también sus sinónimos del equipo en español e inglés (`SYNONYM_GROUPS`: analista/analyst,
  responsable/owner, etiquetado/tagging…; de cada grupo cuenta la que más puntúa). Vale para el Asistente, su IA y el MCP.
- **Documentación en SharePoint** (decisión de la usuaria: los documentos se quedan en Microsoft, no en Supabase; la
  migración 013 que los guardaba en Supabase se quitó antes de aplicarse). Por la extensión «Marea · Lista» (1.3.0), con
  la sesión de cada persona (`features/assistant/spDocs.ts`, autocontenido como `spWork`, en `background.js` como
  `spDocs`/`pageDocs`, operaciones `resolve | search | list | upload`, mensaje `marea-ext:docs`, `extDocs` en Marea):
  `resolve` convierte la dirección de una carpeta (o su enlace de «compartir» `/:f:/s/…`, con `/_api/v2.0/shares/u!…`) en
  sitio y ruta; `search` usa el **buscador de SharePoint** (`/_api/search/query`, KQL con `path:"…"`: todas las palabras y,
  si no hay nada, alguna; `kqlFrom`) en todo el sitio o solo en la carpeta, y devuelve título, enlace, autor y el resumen
  con `<c0>` resaltado (`summaryMarks`): lee Word, PDF, PowerPoint o Excel sin descargarlos y cada persona solo ve lo que
  puede abrir; `list` da los últimos archivos de la carpeta y `upload` sube uno (máx. 15 MB, sin sustituir). Panel lateral
  (`SharePointPanel`): pegar la carpeta, «Buscar en: todo el sitio / solo la carpeta», subir (también arrastrando) y los
  últimos archivos; la configuración es de cada persona (`asistente-sharepoint` en localStorage). Cada búsqueda enseña
  «En SharePoint» (`SharePointHits`) y «En Marea». Sin la extensión, el Asistente busca solo en Marea.
- **La carpeta, al momento** (extensión 1.4.0): el buscador de SharePoint tarda de minutos a horas en indexar lo nuevo, así
  que `texts` recorre la carpeta y sus subcarpetas (`walk`: 4 niveles, 400 archivos, sin «Forms») y devuelve el texto de
  los Word `.docx` (su XML descomprimido sin librerías, títulos con «#»), texto, Markdown, CSV y HTML (máx. 5 MB cada uno,
  3 MB de texto en total); con `known` (enlace → fecha) solo baja los que han cambiado. `folderDocs.ts` los guarda en
  memoria y entran en el buscador local: la respuesta enseña primero «En la carpeta» (`FolderHits`), después «En
  SharePoint» sin repetir y después «En Marea». `list` también recorre subcarpetas. La consulta a SharePoint ya no exige
  todas las palabras: si salen menos de 3, se completa con la de alguna; y verbos como «usa» o «sirve» no cuentan.
- **Varias carpetas y la Lista** (petición de la usuaria: la Lista es del SharePoint de La Caixa y la documentación del de
  WPP): `asistente-sharepoint-v2` guarda una lista de carpetas (`SpSource`; la de una sola carpeta de antes se sigue
  leyendo), cada una de cualquier `*.sharepoint.com` con la sesión de ese sitio en el mismo Chrome, con su alcance, su
  subida y sus archivos (`SourceCard`, «Añadir otra carpeta»). `folderDocs.ts` guarda los textos por carpeta (`folderKey`).
  Cada búsqueda enseña «En la carpeta X» de cada una, «En la Lista» (los elementos de `currentItems`, con su estado, enlace
  a SharePoint y «En el gestor» si hay tarea enlazada; chunks `source: 'list'`), «En SharePoint» de cada sitio y «En Marea».

- **Respuestas redactadas sin IA** (`domain/answer.ts`): cada respuesta empieza con un recuadro (`Lead`). En las búsquedas,
  `extractAnswer` elige entre los 6 primeros documentos, notas, elementos de la Lista y fichas la **frase** (`sentences`:
  puntos, líneas y viñetas) con más palabras buscadas (`scoreSentence`: frase exacta y cortas, mejor) y la cita con su
  fuente y enlace («Según «prueba» en Entry points: «La evar 69 es para el login»»); si ninguna tiene al menos la mitad de
  las palabras, no contesta. Sin respuesta en Marea, `SharePointLead` la busca en los resúmenes de SharePoint. En tareas, lo
  hecho, «qué dijo», temas y personas, resúmenes con plantilla (`tasksSummary`, `doneSummary`, `saidSummary`,
  `topicsSummary`, `personSummary`). No se inventa ni se resume con otras palabras.

- **Lista exacta sin IA** (`domain/inventory.ts`, `InventoryAnswer.tsx`, nov 2026): «dame las evar que hay», «¿qué props
  tenemos?», «qué evar se usan para las cosas de onboarding» (en plural; «qué evar se usa para el login», en singular, sigue
  siendo una búsqueda). Recorre todos los trozos (documentación, notas, Lista; no tareas ni proyectos) buscando
  `<palabra><número>` (`eVar69`, `evar 161`, `evar_12`), con la palabra de la pregunta en singular o plural; hace falta una
  familia (2 o más). De cada uno, la línea que mejor lo explica (una fila de tabla si la hay), hasta 3 sitios con enlace y
  cuántas veces sale; todos escritos con la forma más habitual («eVar»). Las demás palabras acotan («onboarding»: solo lo que
  sale donde se habla de ello). Sustituye a la respuesta de la IA en esas preguntas (la IA solo ve 8 trozos); «Copiar lista»
  la copia con tabuladores. Rinde de verdad con las tablas de Confluence bien subidas (`npm run subir-docs`).

## Fase 36: pantallas de cada cuenta (rama `dev`, nov 2026)

Petición de la usuaria: que los administradores elijan qué pantallas ve cada persona.

- **Supabase** (`supabase/migrations/013_pantallas.sql`, después de 001 a 012): `profiles.hidden_screens` (null = las del
  equipo por defecto) y `app_settings` `default_hidden_screens`. `me()` devuelve `hiddenScreens` ya resuelto (`screens_of`);
  `admin_users()` el de cada cuenta y `admin_overview()` `defaultHiddenScreens`. Solo administradores: `admin_set_screens`
  (varias cuentas a la vez; null = volver al defecto) y `admin_set_default_screens`. Claves validadas (`clean_screens`).
- **Catálogo** (`domain/screens.ts`, `SCREENS`): Bandeja, Tablero, Calendario, Notas, Asistente, Rally, Lista, Proyectos,
  Grupos y personas, Revisión semanal, Registro y Buscar. Hoy y Ajustes siempre se ven; Feedback y Analítica ya son de
  administradores. `screenOf` lleva cada ruta a su pantalla (`week` → calendario, `project` → proyectos, `person` →
  personas…). La app lo recibe en `SyncState.hiddenScreens` (cada consulta a `me`, como mucho 30 s) y la barra lateral quita
  las entradas y secciones; `View` enseña «Esta pantalla no está activada para tu cuenta» si se abre por enlace. **Es para
  simplificar la app, no es seguridad**: no cambia qué datos ve nadie.
- **Apagadas para todos desde el código** (`HIDDEN_FOR_ALL` en `domain/screens.ts`, se suma a lo de Supabase, administradores
  incluidos; Ajustes → Pantallas lo avisa). Estuvo el Asistente hasta aplicar la migración 013 (24 nov 2026); ahora está
  vacía y todo lo decide Ajustes → Pantallas.
- **Ajustes → Pantallas** (`ScreensCard`, solo administradores): tabla con una fila por cuenta activa y una columna por
  pantalla (ojo abierto/cerrado), fila «Por defecto» con «Aplicar a todas», y «Por defecto» en cada cuenta elegida a mano.

## Fase 37: carpetas de SharePoint de CaixaBank (rama `sharepoint-carpetas`, nov 2026)

Petición de la usuaria: tener a mano las carpetas del SharePoint de CaixaBank (se abre en el navegador del Mac con la cuenta
de proveedor externo). Son documentos del cliente, así que **nada de su contenido sale de SharePoint**: sin Power Automate
(copiaría de su tenant a uno de WPP) ni Graph (no hay app en Entra ID).


- **Con la extensión de Chrome** (lo recomendado; misma extensión «Marea · Lista» de Marc, versión **1.5.0**): dos operaciones
  más en `features/assistant/spDocs.ts`, `folder` (un nivel: subcarpetas y archivos con tamaño y fecha, sin `Forms` ni las
  ocultas, en el formato de `parseSnapshot`) y `file` (PDF o imagen hasta 10 MB en base64), en `DOC_OPS` de
  `background.template.js` y en `extDocs`. En `sharepointStore.ts`, `openWithExtension(url)` (`resolve` + `folder`) y, con
  `via: 'extension'`, `openFolder` y `loadFile` van por la extensión: sin pestaña de SharePoint, sin marcador y sin guardar
  nada. `openSaved` prueba en este orden: extensión (`extensionReady`: 1.5.0 o posterior) y, sin ella, el marcador. La pantalla enseña el estado de la extensión (instalar, actualizar o «Abrir aquí» un enlace) y deja el
  marcador como alternativa. `content.js` también se mete en la vista previa de esta rama.
- **Paso 1, accesos** (`domain/sharepoint.ts`, `features/sharepoint/folders.ts`): nombre y enlace (solo https de
  `*.sharepoint.com`, `isSharePointUrl`; nombre propuesto con `folderNameFromUrl`). Personales en
  `settings.sharepoint_folders` y de proyecto en `Project.folders` (los ve quien ve el proyecto, con «Deshacer»); sin
  migración (zod los deja opcionales o vacíos). Pantalla `#/sharepoint` («SharePoint» debajo de Rally) y fila «Carpetas» en la
  página del proyecto (`ProjectFolders`). Se abren en SharePoint con la sesión de la persona.
- **Paso 2, ver el contenido** (`features/sharepoint/bookmarklet.ts`, como el de la Lista de Marc en `dev`): marcador «Marea ·
  Carpeta» que, en una carpeta de una biblioteca (`?id=` de la vista o la ruta), **solo lee** nombre, enlace, tamaño y fecha de
  sus subcarpetas y archivos (`GetFolderByServerRelativePath`, máx. 2.000; sin la carpeta interna `Forms`; nombres codificados
  por tramo y `?web=1` para abrir Office en el navegador) y se los pasa a Marea por `postMessage`. Marea solo contesta a orígenes
  https de `*.sharepoint.com` (`isSharePointOrigin`) y valida todo con `parseSnapshot`. Lo recibido se queda **solo en memoria
  de esa pestaña** (`sharepointStore.ts`): ni Supabase, ni IndexedDB, ni localStorage. «Guardar en mis carpetas» guarda solo
  el enlace. Si la página no deja usar marcadores, «Copiar el código» para la consola. Tests en `tests/sharepoint.test.ts`
  (el marcador se ejecuta suelto; comprobado también minificado).
- **Navegar y vista previa dentro de Marea** (misma rama): la pestaña de SharePoint donde se pulsó el marcador se queda de
  **puente** mientras siga abierta. Marea (`sharepointStore.ts`: `openFolder`, `loadFile`, `handleBridgeMessage`) le pide otra
  carpeta (`marea-sp:list`) o un archivo (`marea-sp:file`) con un número de petición; solo vale la respuesta del puente
  conectado y el puente solo atiende a Marea (origen y ventana) y **solo dentro del sitio** de la carpeta inicial (`inSite`).
  Migas de pan desde la biblioteca (`breadcrumbs`). **Vista previa** solo de PDF e imágenes hasta 20 MB (`previewType`,
  `MAX_PREVIEW_BYTES`, comprobado en los dos lados): el archivo llega como `ArrayBuffer`, se enseña como `blob:` de la pestaña
  (PDF en un iframe, imágenes en `<img>`) y la URL se libera al cerrar la vista previa. Nada se guarda. Word, Excel y
  PowerPoint se siguen abriendo en SharePoint (Office web no se deja incrustar; el inicio de sesión de Microsoft responde
  `X-Frame-Options: DENY`). **Pendiente**: el visto bueno de José a la vista previa (trae contenido de documentos de
  CaixaBank a la pestaña) antes de pasarla a `main`.
- **Carpetas guardadas dentro de Marea** (misma rama): pulsar un acceso (pantalla o fila «Carpetas» del proyecto,
  `openSaved`) lo enseña en Marea. `folderLocation` saca dominio y ruta del enlace (`?id=`, `/:f:/r/…` o la ruta; los enlaces
  de compartir con código no se pueden: se abren en SharePoint). Con puente de ese dominio, `openFolder` al momento; si no,
  `waitingFor` y la tarjeta «Conecta con SharePoint»: «Abrir en SharePoint» abre la carpeta **sin `noopener`**
  (`openForBridge`) para que el marcador, pulsado allí, hable con esta misma pestaña (`window.opener`, con `postMessage` al
  origen de Marea; si no contesta en 2,5 s abre Marea en otra) y, al llegar su primera carpeta, se abre la pedida. El puente
  lee cualquier sitio (`/sites/…` o `/teams/…`) del mismo dominio de SharePoint, con la sesión de la persona. Si SharePoint
  bloquea los marcadores, el código se pega en la consola.
- **Subir archivos** (nov 2026; La Caixa no deja descargar fuera de sus ordenadores, pero sí subir): con una carpeta abierta
  con la extensión, «Subir archivos» o arrastrarlos a la lista (`uploadFiles` en `sharepointStore.ts`, operación `upload` de
  `spDocs`, la del Asistente: hasta 15 MB, nunca sustituye). Va del Mac a SharePoint con la sesión de la persona, como
  «Cargar»; al acabar se relee la carpeta y se ve cuántos se han subido y por qué no los demás. Con el marcador, no.
- **Adjuntar en Rally y subir también a SharePoint** (nov 2026): en la ficha de Rally (pantalla Rally y panel de una tarea
  enlazada), tras adjuntar y con la extensión al día, `SharePointCopy` pregunta «¿Lo subes también a SharePoint?»; si sí, se
  elige la carpeta (la última usada, `sp-upload-last` en localStorage, las guardadas en Marea o un enlace) y se navega por sus
  subcarpetas (`resolveFolder`/`browseFolder`, sin tocar la carpeta de la pantalla SharePoint) hasta «Subir a «X»»
  (`uploadTo`). Avisa si ya hay un archivo con ese nombre (no se sustituye). Va en un portal con `data-popover` y su Esc no
  cierra la ficha. El alta de «Nuevo en Rally» no lo pregunta.
- **Versión del marcador** (`BRIDGE_VERSION`, `v` en el «hola»): el código de un marcador se queda como estaba al
  arrastrarlo, así que Marea no se conecta con uno antiguo y pide volver a arrastrarlo (`OLD_BOOKMARKLET`). Si se cambia
  el protocolo del puente, hay que subir la versión en los dos sitios. El marcador lleva dentro la dirección de Marea desde
  la que se arrastró: en producción hay que arrastrarlo desde la app publicada.
- **Power Automate** (se probó en esta rama: flujo que escribía `Gestor/sharepoint.json`, subida desde el Mac y migración 014): **quitado** al llegar la extensión, que lo hace al momento y sin guardar la lista en Supabase.

## Fase 38: conector MCP de Marea para Claude (rama `mcp-marea`, nov 2026)

Petición de la usuaria: que Claude (de pago o gratuito, navegador o app) tenga el contexto de Marea, Confluence y Notion. Copilot
descartado (sin licencia de M365 Copilot). Notion **no** pasa por Marea: cada persona conecta el conector oficial de Notion en
Claude. Confluence (export mensual, aprobado por José y Mati) va en la fase 2. Fase 1 = solo lectura.

- **Función** `api/mcp.ts` (Vercel, MCP «Streamable HTTP» sin sesiones, `WebStandardStreamableHTTPServerTransport` de
  `@modelcontextprotocol/sdk`, respuestas JSON). En Claude: Ajustes → Conectores → Añadir conector personalizado →
  `https://gestor-tareas-prod.vercel.app/api/mcp`. Se carga con Node sin empaquetar: los imports de valores de `servidor/mcp.ts`
  y `src/domain/mcpTools.ts` (y de lo que importan: `knowledge`, `notes`, `projects`, `text`, `dates`) llevan `.ts`.
- **Entrar**: OAuth 2.1 de **Supabase Auth** (servidor OAuth de Supabase, con registro dinámico de clientes). Sin sesión, 401 con
  `WWW-Authenticate: Bearer resource_metadata=…`; `/.well-known/oauth-protected-resource` (rewrite a `?route=prm`) apunta a
  `<supabase>/auth/v1`. La página de permiso es `/oauth-consent` de la app (`OAuthConsent.tsx`: `getAuthorizationDetails`,
  `approveAuthorization`/`denyAuthorization`; dentro de `AuthGate`). Va en la raíz (no `/oauth/consent`) porque los assets son
  relativos (`base: './'`). El token es una sesión normal de Supabase: las reglas RLS deciden qué se ve, igual que en la app.
  **En Supabase** (una vez): Authentication → OAuth Server → activar, «Authorization path» = `/oauth-consent` y permitir el
  registro dinámico de clientes.
- **Datos** (`servidor/mcp.ts`, `loadMarea`): `records` (tareas, notas, proyectos, tipos; personas y registro solo los propios),
  `overlays` (Mi día), `profiles` (nombres) y `docs` (documentación del equipo, global), con la sesión de la persona; 30 s en
  memoria. Hoy = día de Madrid (`madridToday`).
- **Herramientas** (`src/domain/mcpTools.ts`, funciones puras con tests en `tests/mcp.test.ts`, también una ida y vuelta del
  protocolo): `buscar` (BM25 de `knowledge.ts`, solo contenido de Marea: tareas, notas, personas, proyectos), `listar_tareas`
  (persona, proyecto con subproyectos, estado, periodo, tipo, texto, solo mías), `ver_tarea` (id, ID de Rally o título),
  `ver_nota`, `ver_persona` (temas, tareas, quién dijo qué, reuniones), `ver_proyecto`, `listar_proyectos`, `mi_registro` y
  `buscar_en_documentacion` (ver fase 2) y `carpetas_sharepoint` (las carpetas guardadas en la pantalla SharePoint: las de
  cada proyecto, con subproyectos, y las personales de `settings.sharepoint_folders`; solo nombre y enlace, nunca el contenido;
  `ver_proyecto` también las enseña). Todas `readOnlyHint`. Devuelven texto con enlaces a Marea, Rally y Confluence para
  que Claude cite. Las instrucciones del servidor (`MCP_INSTRUCTIONS`) llevan el glosario (US, TS, DE…).
- Privacidad: sin plan Team de Claude, cada persona debe desactivar en Claude el uso de sus conversaciones para entrenar.

### Claude dentro de las carpetas de SharePoint (fase 38, nov 2026, visto bueno de José)

El conector corre en Vercel y no tiene la sesión de SharePoint de nadie; la tiene la extensión de Chrome. Así que va de paso
por Supabase (`supabase/migrations/018_sharepoint_claude.sql`, después de 001 a 017):

- **Conector** (`askSharePoint` en `servidor/mcp.ts`): `sp_request` deja la petición y espera hasta 40 s con `sp_collect`, que al
  recogerla **borra la fila**; si nadie contesta, `sp_cancel` y le dice a Claude que abra Marea. Lo no recogido se borra a los
  10 min y como mucho hay 30 por persona. Herramientas `sharepoint_ver_carpeta`, `sharepoint_buscar` (buscador de SharePoint
  dentro de las carpetas, con resumen) y `sharepoint_leer` (texto por partes de 60.000 caracteres, `textPart`). La carpeta se
  dice por nombre, enlace o proyecto (`findFolder`); formato en `formatSpFolder`/`formatSpSearch`/`formatSpRead`.
- **Pestaña de Marea** (`SharePointClaudeBridge` en `Main`, `features/sharepoint/claudeBridge.ts`): solo con «Dejar que Claude
  lea mis carpetas» (`ClaudeAccessCard` en la pantalla SharePoint, `sharepoint-claude` en localStorage, apagado por defecto) y
  la extensión 1.6.0. Se entera por tiempo real (`onSpRequest`) y, por si se corta, cada 15 s y al volver (`sp_pending`);
  `sp_take` hace que solo una pestaña la atienda. **Solo dentro de las carpetas guardadas** (personales o de un proyecto que
  ve): `rootFor`/`serverPath` (`domain/spClaude.ts`) rechazan rutas fuera, `..` y otros dominios; las búsquedas se limitan a
  la carpeta y se filtran. Solo lee. Lo último pedido se ve en la tarjeta (en memoria).
- **Extensión 1.6.0**: operación `text` en `spDocs.ts` (Word, PowerPoint por diapositivas, Excel por hojas con `|`, texto,
  CSV, HTML; hasta 15 MB y 400.000 caracteres). Los PDF y los formatos antiguos no: Claude usa el resumen de la búsqueda.
- El texto de los documentos pasa por Supabase un momento y llega a Claude (Anthropic): es lo que aprobó José.

### Fase 2 (fase 38): documentación de Confluence en el MCP

El equipo descarga una vez al mes el export **HTML** de los espacios de Confluence (aprobado por José y Mati: solo cómo trabaja
el equipo y para qué sirve cada cosa, sin documentación privada del cliente). Se saca del entorno de Caixa por OneDrive y,
como es texto sin adjuntos, pesa poco (los 3 zips de prueba, ~700 páginas, ~2,6 MB de texto). Fuera de git (`importar/`).

- **Parser** (`src/domain/confluence.ts`, puro y con tests, sin DOMParser para correr igual en navegador y en Node):
  `parseConfluencePage(html, fileName)` saca el id del nombre del fichero (`…_4511892904.html`), el título y el espacio de
  `#title-text` (`Espacio : Página`), la ruta de `#breadcrumbs`, el cuerpo de `#main-content` (hasta el footer) con
  `htmlToText`, y arma el enlace `…/pages/viewpage.action?pageId=<id>` (`CONFLUENCE_BASE`, Data Center de CaixaBank, solo se
  abre desde su red). `pageChunks` trocea por apartados reutilizando `splitSections`/`Chunk` (fuente `doc`).
- **Supabase** (`supabase/migrations/014_documentacion.sql`, después de 001 a 013): tabla global `docs` (id, space, title,
  path, url, body); la leen los miembros activos por RLS (`me_active`) y nadie la escribe directamente. `docs_info()` da el
  recuento y la fecha. La sube **una sola persona** con el script del Mac (decisión de la usuaria: solo ella, no desde la
  app), con una «clave de subida» propia (`docs_token`, una para el equipo, huella sha256; la última generada manda), como
  el calendario (fase 27): `create_docs_token`/`revoke_docs_token`/`docs_token_info` (solo administradores) y
  `upload_docs(p_token, p_docs, p_reset)`, que llama el script sin sesión (rol anon) solo con la clave y exige que quien la
  generó siga siendo administradora activa; el primer lote vacía lo anterior.
- **Subida** (`scripts/subir-docs.ts`, `npm run subir-docs -- [dsub_…] <zips>`): reutiliza `supabaseConfig` del script del
  calendario; `src/features/docs/unzip.ts` abre los .zip sin librerías (lee el directorio central del ZIP y descomprime con
  `DecompressionStream`, también en Node 24); parsea cada página, deduplica por id y sube en lotes de 120. La clave se guarda
  en `servidor/datos/docs-subida.json`. En Ajustes → Documentación (solo administradores, `src/features/docs/DocsCard.tsx`)
  se genera/quita la clave y se ve el recuento; no se suben zips desde ahí.
- **MCP**: `loadMarea` añade la tabla `docs` a los datos; `chunksOf` mete sus trozos; la herramienta `buscar_en_documentacion`
  (fuente `doc`) devuelve el apartado y el enlace a Confluence. `buscar` se queda con el contenido de Marea para no mezclarlos.

### Más adelante (MCP)

- **Notion**: cada persona conecta en Claude el **conector oficial de Notion** (no pasa por Marea ni se mete en nuestro
  conector: nada de guardar tokens de Notion). Claude admite varios conectores en el mismo chat, así que con Marea y Notion
  conectados los cruza en una sola conversación. El mensaje de «Preguntar a Claude» (`claudePrompt` en `askClaude.tsx`) invita
  a usar también Notion «si lo tienes conectado», así la respuesta combinada vuelve a Marea por `responder_en_marea` igual que
  la de solo Marea. La tarjeta `ClaudeCard` lo explica como paso opcional.
- **Escritura** (crear tareas, mover estados) más adelante, si el solo-lectura cuaja. Rally por el conector necesitaría el OK
  de José.

## Fase 39: respuestas con IA en el Asistente (rama `dev`, nov 2026)

Petición de la usuaria: que el Asistente responda de verdad («¿qué evar uso para el login?» → «la eVar69 [1]»), gratis y sin
que los documentos (también los de CaixaBank) salgan del ordenador. RAG **local en el navegador**, sin servidor ni APIs.

- **Opcional y de cada persona** (`asistente-ia` en localStorage; panel «Respuestas con IA», `AiPanel`): al activarlo se
  descarga una vez **Qwen2.5-3B-Instruct** de WebLLM (~2 GB, en la caché del navegador; `q4f16` si la gráfica admite
  `shader-f16`, si no `q4f32`). Necesita WebGPU (Chrome/Edge); sin él, `unsupported` y se queda la respuesta sin IA
  (`extractAnswer`). «Borrar el modelo» lo quita de la caché.
- **Modelo normal o grande** (nov 2026; `MODELS`, `asistente-ia-modelo` en localStorage, elegido en el panel): Normal =
  Qwen2.5-3B (~2 GB, ventana 4k, 8 trozos y ~6.500 caracteres) y Grande = **Qwen3.5-9B** (~6,5 GB; ventana de **16k**
  con `context_window_size`, **20 trozos** y ~26.000 caracteres, 40 de la búsqueda por significado y 40 por palabras,
  respuestas de hasta 800 tokens; para un Mac con chip M y 16 GB o más). Qwen3 «piensa en voz alta»: se le pide
  `enable_thinking: false` y `withoutThinking` quita cualquier `<think>…</think>`. Cambiar suelta el modelo que hay y carga
  el otro (`startLlm(size)`); si la gráfica no tiene memoria para el grande, lo dice. «Borrar el modelo» borra todos (también
  el Qwen2.5-7B que fue el grande un día). Un test comprueba que los ids existen en WebLLM y que el contexto cabe.
- **Variedad de páginas**: `pickContext` da como mucho 3 partes de una misma página (`MAX_PER_PAGE`), para que una página
  larga (p. ej. «Prioridades de equipo», una parte por fecha) no se lleve todo y la que responde llegue a la IA.
- **Nunca en blanco**: si la IA responde «No lo encuentro» o falla, debajo sale la frase que mejor responde sin IA
  (`extractAnswer`, el `Lead` de siempre, prop `fallback` de `AiAnswer`) con su enlace.
- **Motor** (`features/assistant/ai/engine.ts`): el modelo va en un worker (`llmWorker.ts`, `CreateWebWorkerMLCEngine`), en
  cola y con «Parar» (`interruptGenerate`). Búsqueda por significado con transformers.js en otro worker (`embedWorker.ts`,
  `Xenova/multilingual-e5-small` q8 en WASM, ~120 MB, prefijos `passage:`/`query:`): `indexChunks` calcula en segundo plano
  los vectores de los trozos (sin tareas ni proyectos) y los guarda **solo en memoria** (`chunkKey`: id + huella del texto).
- **Parte pura** (`domain/rag.ts`, tests en `tests/rag.test.ts`): `fuseRanks` (RRF de BM25 top 30 y significado top 20),
  `pickContext` (hasta 8 trozos y ~6.500 caracteres, el modelo tiene 4.096 tokens), `buildMessages` (reglas cortas, **un
  ejemplo de pregunta y respuesta**, que a un modelo de 3B le enseña el formato mejor que las reglas; sin él contestaba
  «[eVar69]» o «no lo encuentro» teniendo la fuente) y `splitCitations`/`citedSources` para enlazar las citas [n].
- **Pantalla**: solo las preguntas que van a buscar (`search`) las responde la IA (`AiAnswer`, morado, en streaming, con
  las fuentes enlazadas debajo); las de tareas, hecho, personas y órdenes siguen igual. Si el modelo aún carga, espera y
  responde. Las respuestas se quedan en memoria de la sesión.
- **PWA**: `webllm.ts` reexporta lo que se usa de WebLLM para que vaya en su propio trozo; `globIgnores` deja fuera del
  precache `llmWorker-*`, `embedWorker-*` y `webllm-*` (varios MB que solo descarga quien activa la IA).
- Probado en el Mac (M, f16): carga en ~70 s la primera vez y ~25 s con el modelo en caché; ~5 s por respuesta.
- **Documentación de Confluence también en el Asistente** (`features/assistant/confluenceDocs.ts`): la misma tabla `docs` del
  conector MCP (migración 014), leída con la sesión de la persona al abrir el Asistente (páginas de 500 en 500; se vuelve a
  pedir solo si `docs_info.updatedAt` cambia; en memoria). `confluenceChunks` (`domain/confluence.ts`, con test) les pone id
  `cf:` y el enlace de la página como `ref`; salen en «En Confluence» y la IA las cita. Tarjeta «Documentación de
  Confluence» con el número de páginas. Sus vectores de significado se guardan en IndexedDB (`marea-ia`, `vectors`; ese
  export está aprobado para salir de CaixaBank) para no recalcular cientos de páginas cada sesión; los demás, solo en memoria.
- **Tablas de Confluence** (`htmlToText`, `tableToText`): una línea por fila con «Columna: valor | …» (cabecera de `<th>`).
  Antes cada celda (con sus `<p>`) quedaba en una línea suelta y las celdas en mayúsculas (`COD_POSTEVAR6`) se tomaban por
  apartados, así la IA mezclaba filas («evar161 se usa para el login»). `pageChunks` usa `splitSections(…, { markdownOnly })`.
  **Lo ya subido no cambia hasta volver a subir el export** con `npm run subir-docs`.
- **«Preguntar a Claude»** (`features/assistant/askClaude.tsx`): para lo que el modelo de 3B no razona (comparar, explicar,
  juntar muchas páginas), sin API: debajo de cada búsqueda abre `claude.ai/new?q=…` en una ventana estrecha a la derecha con
  la pregunta y la indicación de usar el conector de Marea (MCP, fase 38); solo hay que enviarla. Solo viaja la pregunta (nada
  de SharePoint). También «copiar» para la app de escritorio o el panel de Chrome. Tarjeta `ClaudeCard` con cómo añadir el
  conector (`MCP_URL`). Claude no deja incrustarse en un iframe y manejar claude.ai por detrás iría contra sus condiciones.
- **La respuesta de Claude vuelve a Marea** (migración `015_respuestas_claude.sql`, después de 001 a 014): Claude y la pestaña
  de Marea no pueden hablar directamente (Claude corre en Anthropic y llama a `/api/mcp`, que no puede avisar al navegador),
  así que pasa por Supabase. Cada «Preguntar a Claude» lleva un id (`newRequestId`, `m-…`) en el mensaje y la petición de
  guardar la respuesta con la herramienta **`responder_en_marea`** del conector (la única que escribe; `saveAnswer` llama a
  `save_assistant_answer` con la sesión de la persona). Tabla `assistant_answers` (dueño, pregunta, respuesta en Markdown):
  cada uno lee solo las suyas por RLS; se borran a los 30 días. El Asistente pregunta cada 3 s (hasta 15 min, y 1 min más
  tras llegar por si Claude la corrige) y la pinta con `Markdown` en «Respuesta de Claude»; si no llega, «Volver a mirar» o
  pedirle a Claude «guárdala en Marea». La primera vez Claude pide permiso para la herramienta («Permitir siempre»).
  **No se puede** cerrar, minimizar ni saber cuándo se envía en la ventana de Claude: claude.ai manda
  `Cross-Origin-Opener-Policy: same-origin`, así que el navegador corta la relación con la página que la abrió (para Marea la
  ventana pasa a estar «cerrada»). Se probó y se quitó (nov 2026). Enviar la pregunta sola tampoco: pulsar Enter con un
  script iría contra las condiciones de claude.ai; lo totalmente automático sería la API de Anthropic, de pago.

## Fase 40: Hoy como portada (rama `dev`, nov 2026)

Petición de la usuaria: que Hoy resuma todas las pantallas, más visual y con los colores de Marea.

- **Cabecera** azul marino (`#1B2B4B`): día, saludo con el nombre de pila, cifras (para hoy, en curso, atrasadas,
  reuniones, temas) y anillo coral de lo hecho hoy. Dentro, la captura de siempre (`QuickAdd`, con fecha de hoy) y debajo la
  guía «Cómo escribir una tarea» de la Bandeja, **plegada** por defecto (`CaptureGuide` con `storageKey`
  `today-capture-guide`; sus ejemplos se escriben en la captura).
- **Tarjetas** (`features/views/TodayView.tsx`): **Mi día** (atrasadas con su bloque, Mi día y lo que vence hoy, y «En
  curso»: grupo `doing`; sin los temas; se pueden soltar tareas), **Reuniones** de hoy en línea de tiempo (`useMeetings`; la
  de ahora en coral con «Unirse», las pasadas atenuadas), **Para hablar** (temas pendientes por persona), **Rally · últimos
  cambios en lo tuyo**, **Últimas notas** (por `updated_at`) y **Tu tablero** (solo cuántas hay en cada una de las 7
  columnas, con `rallyBoardColumns` de `Board.tsx`, la misma cuenta que el Tablero). Las tarjetas de pantallas ocultas
  para esa cuenta no salen.
- **Rally** (`rally.recent`, `POST /api/rally/recent`, `features/today/rallyRecent.ts`): lo que **otras personas** han
  hecho en los últimos 3 días en tus elementos (los enlazados a tareas del gestor y los que tienes de Assignee u Owner):
  comentarios y adjuntos (WSAPI), cambios de columna y de Blocked (Lookback API) y elementos nuevos para ti. Al abrir Hoy y
  cada 5 min; en memoria. Sin Rally conectado, la tarjeta lo dice.
- **Personalizar**: cada persona mueve las tarjetas a donde quiera (también a un hueco vacío, sin quitarle el sitio a otra),
  cambia su ancho (1 a 3 columnas) y las oculta o las vuelve a poner; «Restablecer» vuelve al de serie. En pantalla ancha
  (≥ 1280 px) cada tarjeta guarda columna y fila (`x`, `y` en filas de 4 px) y ocupa solo su alto real (`Tile` lo mide).
  `placeTodayCards` las coloca: las que tienen sitio van a él y, si se montan con otra (porque ha crecido), bajan al primer
  hueco libre; las que no tienen sitio (las de serie, las que se vuelven a mostrar) van al hueco más alto donde caben.
  Mientras se arrastra, la tarjeta ya se ve donde caería (se pega a los bordes cercanos) y al soltar se fija todo
  (`pinTodayLayout`). En ventanas estrechas van una debajo de otra en ese orden, en mosaico, y no se arrastran. Dentro de
  cada tarjeta, la distribución va por su ancho (`@container`) y nada se sale (`overflow-hidden`, textos cortados). Se guarda
  en `settings.today_layout` (sin migración: zod pone null), así se sincroniza y entra en las copias. Lógica pura en
  `domain/todayLayout.ts`, con tests.
- **Fuera la Bandeja**: sin entrada en la barra lateral, sin `G B` ni comando, y fuera de Ajustes → Pantallas; `#/inbox`
  lleva a Hoy. Las tareas sin fecha ni proyecto siguen en el Tablero, la búsqueda y la Revisión semanal. En el feedback,
  la parte de la web «inbox» pasa a llamarse «Captura rápida». Ya no sale el resumen del día (`DailySummary`) en Hoy.

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
