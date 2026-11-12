import { useState } from 'react';
import { LOCAL_SERVER } from '../data/serverApi';
import { AppProvider, useApp } from './AppContext';
import { WideContext, type WideMode } from './Layout';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { BoardView } from '../features/board/BoardView';
import { CalendarView } from '../features/calendar/CalendarView';
import { NotesView } from '../features/notes/NotesView';
import { RallyView } from '../features/rally/RallyView';
import { ConfluenceView } from '../features/confluence/ConfluenceView';
import { ListaView } from '../features/mslist/ListaView';
import { ListaSync } from '../features/mslist/ListaSync';
import { ChatsView } from '../features/chats/ChatsView';
import { NeedReviewPrompt } from '../features/rally/NeedReviewPrompt';
import { AnalystPrompt } from '../features/rally/AnalystPrompt';
import { RallySync } from '../features/rally/RallySync';
import { LogView } from '../features/log/LogView';
import { ReviewView } from '../features/review/ReviewView';
import { ReminderCenter } from '../features/reminders/ReminderCenter';
import { routeHref, useRoute, type Route } from './router';
import { Sidebar } from './Sidebar';
import { ToastProvider } from '../components/Toast';
import { CommandCenterProvider } from '../features/command/CommandCenter';
import { HistoryBridge } from '../features/history/HistoryBridge';
import { BulkBar } from '../features/selection/BulkBar';
import { SelectionProvider, useSelection } from '../features/selection/SelectionContext';
import { SearchView } from '../features/views/SearchView';
import { BackupReminder } from '../features/backup/BackupReminder';
import { SettingsView } from '../features/backup/SettingsView';
import { InboxView } from '../features/views/InboxView';
import { PeopleView, PersonView } from '../features/views/PeopleViews';
import { ProjectView } from '../features/project/ProjectPage';
import { TodayView } from '../features/views/TodayView';

function View({ route }: { route: Route }) {
  switch (route.view) {
    case 'today': return <TodayView />;
    case 'week': return <CalendarView initial="week" />;
    case 'board': return <BoardView />;
    case 'all': return <BoardView />; // la antigua vista "Todo" ahora es el Tablero
    case 'notes': return <NotesView id={route.id} />;
    case 'log': return <LogView />;
    case 'review': return <ReviewView />;
    case 'calendar': return <CalendarView />;
    case 'rally': return <RallyView />;
    case 'confluence': return LOCAL_SERVER ? <ConfluenceView /> : <LocalOnly name="Confluence" />;
    case 'lista': return LOCAL_SERVER ? <ListaView /> : <LocalOnly name="La lista" />;
    case 'chats': return LOCAL_SERVER ? <ChatsView /> : <LocalOnly name="Los chats" />;
    case 'projects': return <TodayView />; // la pantalla "Proyectos" se quitó: se gestionan desde la barra lateral
    case 'inbox': return <InboxView />;
    case 'project': return <ProjectView key={route.id} id={route.id} />;
    case 'people': return <PeopleView />;
    case 'person': return <PersonView key={route.name} name={route.name} />;
    case 'settings': return <SettingsView />;
    case 'search': return <SearchView q={route.q} />;
  }
}

function Main({ route }: { route: Route }) {
  const { clear } = useSelection();
  const [wide, setWide] = useState<WideMode>(false);
  const full = wide === 'full';
  return (
    <main
      className="min-w-0 overflow-y-auto"
      // Clic en una zona vacía: se quita la selección.
      onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-task-id], button, a, input, textarea, select, [role="toolbar"], aside, [data-popover]')) clear(); }}
    >
      <div className={full ? 'flex h-full flex-col px-4 py-3' : `mx-auto px-6 py-6 pb-28 max-sm:px-4 ${wide ? 'max-w-none' : 'max-w-4xl'}`}>
        <BackupReminder />
        <ReminderCenter />
        <RallySync />
        <AnalystPrompt />
        <NeedReviewPrompt />
        {LOCAL_SERVER && <ListaSync />}
        <WideContext.Provider value={setWide}>
          {/* Siempre el mismo envoltorio: así la vista no se vuelve a montar al cambiar de modo. */}
          <div className={full ? 'min-h-0 flex-1' : undefined}><View route={route} /></div>
        </WideContext.Provider>
      </div>
    </main>
  );
}

/** Columnas: barra lateral · contenido · panel de detalle (si hay una tarea abierta). */
function Shell({ route }: { route: Route }) {
  const { detailId } = useApp();
  return (
    // En pantallas anchas el panel es una columna más; en las estrechas se superpone por la derecha. La fila mide
    // lo que la pantalla (minmax(0,1fr)): así cada columna hace scroll por su cuenta y no se desplaza la página entera.
    <div className={`grid h-dvh grid-rows-[minmax(0,1fr)] grid-cols-[232px_1fr] max-sm:grid-cols-1 ${detailId ? 'xl:grid-cols-[232px_1fr_420px]' : ''}`}>
      <div className="max-sm:hidden"><Sidebar route={route} /></div>
      <Main route={route} />
      {detailId && (
        <div className="fixed inset-y-0 right-0 z-30 w-[420px] max-w-full shadow-2xl xl:static xl:z-auto xl:h-full xl:min-h-0 xl:w-auto xl:min-w-0 xl:shadow-none">
          <TaskDetailPanel />
        </div>
      )}
    </div>
  );
}

export function App() {
  const route = useRoute();
  // La búsqueda cambia en cada tecla: no debe reiniciar la selección.
  const resetKey = route.view === 'search' ? 'search' : routeHref(route);
  return (
    <ToastProvider>
      <HistoryBridge />
      <AppProvider>
        <SelectionProvider resetKey={resetKey}>
          <CommandCenterProvider>
            <Shell route={route} />
            <BulkBar />
          </CommandCenterProvider>
        </SelectionProvider>
      </AppProvider>
    </ToastProvider>
  );
}

/** Pantallas que necesitan el servidor del Mac (archivos de OneDrive o la red del cliente): en Vercel no están. */
function LocalOnly({ name }: { name: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-zinc-500">
      <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">{name} solo funciona en la versión local</p>
      <p>Necesita el servidor del equipo de tu ordenador. Ábrela en http://localhost:4173.</p>
    </div>
  );
}
