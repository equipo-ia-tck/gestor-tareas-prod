import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SearchIndex } from '../src/domain/knowledge.ts';
import {
  activityLog, CATEGORY_KEYS, chunksOf, listProjects, listTasks, MCP_INSTRUCTIONS, noteDetail, personDetail, projectDetail,
  search, searchDocs, sharePointFolders, taskDetail, WHEN_KEYS, type MareaData,
} from '../src/domain/mcpTools.ts';
import type { ConfluencePage } from '../src/domain/confluence.ts';
import type { TeamUser } from './auth.ts';

/** Guardar la respuesta de Claude en Marea (migración 015) con la sesión de la persona. */
export async function saveAnswer(config: { url: string; key: string }, token: string, id: string, question: string, answer: string, fetchImpl: Fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${config.url}/rest/v1/rpc/save_assistant_answer`, {
    method: 'POST',
    headers: { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id, p_question: question, p_answer: answer }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  const m = body?.message ?? `Supabase respondió ${res.status}`;
  throw new Error(/save_assistant_answer|function|404/i.test(m) && res.status === 404
    ? 'Falta preparar Marea: una administradora tiene que ejecutar supabase/migrations/015_respuestas_claude.sql.' : m);
}

/**
 * Conector MCP de Marea (lectura, y una herramienta que escribe: guardar la respuesta para el Asistente). Lee de Supabase con la sesión de la persona (la que Claude obtiene al conectarse
 * con «Entrar con Marea»), así que las reglas de la base de datos deciden qué ve: lo mismo que en la app.
 */

type Fetch = typeof fetch;
interface Row { tbl: string; key: string; scope: string; owner: string | null; data: Record<string, unknown> }

const PAGE = 1000;
const CACHE_MS = 30_000;
const cache = new Map<string, { data: Omit<MareaData, 'base'>; index?: SearchIndex; until: number }>();

/** Día de hoy en Madrid (Vercel va en UTC). */
export function madridToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function fetchAll<T>(config: { url: string; key: string }, token: string, path: string, fetchImpl: Fetch): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetchImpl(`${config.url}/rest/v1/${path}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${token}`, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`Supabase respondió ${res.status} al leer los datos.`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Todo lo que ve la persona, en el formato de la app (con «Mi día» de cada uno). */
export async function loadMarea(config: { url: string; key: string }, token: string, user: TeamUser, fetchImpl: Fetch = fetch) {
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit;
  const tables = 'tasks,notes,projects,people,item_types,activity,settings';
  const [rows, overlays, profiles, docs] = await Promise.all([
    fetchAll<Row>(config, token, `records?select=tbl,key,scope,owner,data&tbl=in.(${tables})&data=not.is.null&order=tbl,key`, fetchImpl),
    fetchAll<{ key: string; data: { my_day?: string | null } }>(config, token, `overlays?select=key,data&tbl=eq.tasks&user_id=eq.${user.id}`, fetchImpl),
    fetchAll<{ id: string; name: string }>(config, token, 'profiles?select=id,name', fetchImpl),
    fetchAll<ConfluencePage>(config, token, 'docs?select=id,space,title,path,url,body&order=id', fetchImpl),
  ]);
  const myDay = new Map(overlays.map((o) => [o.key, o.data.my_day ?? null]));
  const of = (tbl: string, personal = false) => rows.filter((r) => r.tbl === tbl && (!personal || r.scope === user.id));
  const data: Omit<MareaData, 'base'> = {
    today: madridToday(),
    me: { id: user.id, name: user.name },
    tasks: of('tasks').map((r) => ({ ...(r.data as unknown as MareaData['tasks'][number]), my_day: myDay.get(r.key) ?? null, owner: r.owner })),
    notes: of('notes').map((r) => ({ ...(r.data as unknown as MareaData['notes'][number]), owner: r.owner })),
    projects: of('projects').map((r) => r.data as unknown as MareaData['projects'][number]),
    people: of('people', true).map((r) => r.data as unknown as MareaData['people'][number]),
    types: of('item_types').map((r) => r.data as unknown as MareaData['types'][number]),
    activity: of('activity', true).map((r) => r.data as unknown as MareaData['activity'][number]),
    folders: of('settings', true).flatMap((r) => (r.data as { sharepoint_folders?: MareaData['folders'] }).sharepoint_folders ?? []),
    accounts: new Map(profiles.map((p) => [p.id, p.name])),
    docs: docs.map((p) => ({
      id: p.id, space: p.space ?? '', title: p.title ?? '', path: p.path ?? '', url: p.url ?? '', body: p.body ?? '',
    })),
  };
  // Valores por defecto de lo que puede faltar en registros antiguos.
  data.tasks = data.tasks.map((t) => ({ ...t, people: t.people ?? [], tags: t.tags ?? [], checklist: t.checklist ?? [], notes: t.notes ?? '' }));
  data.notes = data.notes.map((n) => ({ ...n, people: n.people ?? [], body: n.body ?? '' }));
  if (cache.size > 200) cache.clear();
  const entry = { data, until: Date.now() + CACHE_MS } as { data: Omit<MareaData, 'base'>; index?: SearchIndex; until: number };
  cache.set(token, entry);
  return entry;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Servidor MCP con las herramientas de Marea. `load` da los datos (se piden solo cuando se usa una herramienta). */
export function mareaServer(
  load: () => Promise<{ data: MareaData; index: () => SearchIndex }>,
  save?: (id: string, question: string, answer: string) => Promise<void>,
): McpServer {
  const server = new McpServer({ name: 'marea', title: 'Marea', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });
  const run = (fn: (d: MareaData, index: () => SearchIndex) => string) => async () => {
    try {
      const { data, index } = await load();
      return text(fn(data, index));
    } catch (e) {
      return { ...text(`No se ha podido leer Marea: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('buscar', {
    title: 'Buscar en Marea',
    description: 'Busca por palabras en tareas, notas y actas, fichas de personas y proyectos. Devuelve los fragmentos que mejor responden, con su enlace. Úsala para preguntas abiertas sobre el trabajo del equipo: qué se habló de algo, dónde está algo. Para procesos o conceptos del equipo usa «buscar_en_documentacion».',
    inputSchema: {
      consulta: z.string().min(1).describe('Palabras a buscar, p. ej. «evar 69 login» o «entrega de guía»'),
      tipos: z.array(z.enum(['task', 'note', 'person', 'project'])).optional().describe('Limitar a estos tipos'),
      limite: z.number().int().min(1).max(40).optional(),
    },
    annotations: readOnly,
  }, async (a) => run((d, index) => search(d, a.consulta, { sources: a.tipos ?? ['task', 'note', 'person', 'project'], limit: a.limite, index: index() }))());

  server.registerTool('buscar_en_documentacion', {
    title: 'Buscar en la documentación del equipo',
    description: 'Busca en la documentación del equipo (export de Confluence): cómo trabaja el equipo, modelos operativos, glosarios, procesos y para qué sirve cada cosa. Úsala para «cómo se hace…», «qué es…», «cuál es el proceso de…». Devuelve el apartado y el enlace a la página de Confluence.',
    inputSchema: {
      consulta: z.string().min(1).describe('Palabras a buscar, p. ej. «modelo operativo guías» o «owners de etiquetado»'),
      limite: z.number().int().min(1).max(20).optional(),
    },
    annotations: readOnly,
  }, async (a) => run((d, index) => searchDocs(d, a.consulta, { limit: a.limite, index: index() }))());

  server.registerTool('listar_tareas', {
    title: 'Listar tareas',
    description: 'Lista tareas con filtros: persona, proyecto (incluye subproyectos), estado, periodo, tipo (US, TS, DE…) y texto. Sin estado, solo las pendientes.',
    inputSchema: {
      persona: z.string().optional().describe('Nombre completo o de pila'),
      proyecto: z.string().optional().describe('Nombre del proyecto o ruta «padre/hijo»'),
      estado: z.enum(Object.keys(CATEGORY_KEYS) as [keyof typeof CATEGORY_KEYS, ...(keyof typeof CATEGORY_KEYS)[]]).optional(),
      cuando: z.enum(WHEN_KEYS).optional().describe('Periodo por fecha de vencimiento (mi_dia = Mi día de hoy)'),
      tipo: z.string().optional().describe('Abreviatura o nombre del tipo: US, TS, DE, FE, Tarea, Para hablar…'),
      solo_mias: z.boolean().optional().describe('Solo las creadas por la persona conectada'),
      texto: z.string().optional().describe('Palabras que tienen que estar en el título, ID, descripción o etiquetas'),
      limite: z.number().int().min(1).max(200).optional(),
    },
    annotations: readOnly,
  }, async (a) => run((d) => listTasks(d, a))());

  server.registerTool('ver_tarea', {
    title: 'Ver una tarea',
    description: 'Todo sobre una tarea: estado, fechas, personas, descripción, pasos, notas relacionadas, historial y enlaces a Marea y Rally.',
    inputSchema: { tarea: z.string().min(1).describe('id de la tarea, ID de Rally (US1234567) o su título') },
    annotations: readOnly,
  }, async (a) => run((d) => taskDetail(d, a.tarea))());

  server.registerTool('ver_nota', {
    title: 'Ver una nota o acta',
    description: 'El texto completo de una nota o acta de reunión, con sus acciones y el estado de las tareas que salieron de ella.',
    inputSchema: { nota: z.string().min(1).describe('id de la nota o su título') },
    annotations: readOnly,
  }, async (a) => run((d) => noteDetail(d, a.nota))());

  server.registerTool('ver_persona', {
    title: 'Ver una persona',
    description: 'Ficha de una persona: rol, temas pendientes para hablar con ella, tareas pendientes, lo que dijo o se habló en las notas (quién dijo qué) y sus últimas reuniones.',
    inputSchema: { persona: z.string().min(1).describe('Nombre completo o de pila') },
    annotations: readOnly,
  }, async (a) => run((d) => personDetail(d, a.persona))());

  server.registerTool('ver_proyecto', {
    title: 'Ver un proyecto',
    description: 'Resumen de un proyecto con sus subproyectos: cifras, tareas pendientes, carpetas de SharePoint y notas recientes.',
    inputSchema: { proyecto: z.string().min(1).describe('Nombre del proyecto o ruta «padre/hijo»') },
    annotations: readOnly,
  }, async (a) => run((d) => projectDetail(d, a.proyecto))());

  server.registerTool('listar_proyectos', {
    title: 'Listar proyectos',
    description: 'Todos los proyectos y subproyectos que ve la persona, con cuántas tareas pendientes tiene cada uno.',
    annotations: readOnly,
  }, run((d) => listProjects(d)));

  server.registerTool('carpetas_sharepoint', {
    title: 'Carpetas de SharePoint',
    description: 'Las carpetas de SharePoint guardadas en Marea: las de cada proyecto (con subproyectos) y las personales, con su enlace. Úsala para «¿dónde está la documentación / los entregables / las guías de X?». Solo da nombre y enlace: no puede leer los documentos.',
    inputSchema: {
      proyecto: z.string().optional().describe('Nombre del proyecto o ruta «padre/hijo» (incluye sus subproyectos)'),
      texto: z.string().optional().describe('Palabras del nombre de la carpeta o del proyecto, p. ej. «entregables»'),
    },
    annotations: readOnly,
  }, async (a) => run((d) => sharePointFolders(d, a.proyecto, a.texto))());

  server.registerTool('mi_registro', {
    title: 'Mi registro de actividad',
    description: 'Lo que ha hecho la persona conectada entre dos días: tareas hechas, creadas, pospuestas, eliminadas y cambios de estado. Por defecto, esta semana.',
    inputSchema: {
      desde: z.string().optional().describe('YYYY-MM-DD'),
      hasta: z.string().optional().describe('YYYY-MM-DD'),
      tipo: z.enum(['completed', 'created', 'postponed', 'deleted', 'archived', 'reopened', 'state']).optional(),
    },
    annotations: readOnly,
  }, async (a) => run((d) => activityLog(d, a.desde, a.hasta, a.tipo))());

  if (save) {
    server.registerTool('responder_en_marea', {
      title: 'Guardar la respuesta en Marea',
      description: 'Guarda tu respuesta final para que se vea en el Asistente de Marea. Úsala SOLO cuando el mensaje de la persona traiga un «id de Marea» (viene de «Preguntar a Claude»): al terminar, llama una vez con ese id y la respuesta completa en Markdown, con los enlaces a las fuentes.',
      inputSchema: {
        id: z.string().regex(/^[a-z0-9-]{6,64}$/).describe('El id de Marea que viene en el mensaje'),
        respuesta: z.string().min(1).max(100000).describe('La respuesta completa, en Markdown, con los enlaces a las páginas, tareas o notas'),
        pregunta: z.string().max(4000).optional().describe('La pregunta, tal cual'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (a) => {
      try {
        await save(a.id, a.pregunta ?? '', a.respuesta);
        return text('Guardada: ya se ve en el Asistente de Marea.');
      } catch (e) {
        return { ...text(`No se ha podido guardar en Marea: ${e instanceof Error ? e.message : String(e)}`), isError: true };
      }
    });
  }

  return server;
}

export { chunksOf };
