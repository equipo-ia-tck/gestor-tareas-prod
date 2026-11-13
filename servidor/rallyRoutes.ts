import { ApiError } from './api.ts';
import type { TeamUser } from './auth.ts';
import type { Rally } from './rally.ts';

type Body = () => Promise<Record<string, unknown>>;

/**
 * Rutas de Rally (`/api/rally…`), iguales en el servidor local y en la función de Vercel (`api/rally.ts`). Devuelve lo
 * que se responde en JSON; `ApiError(404)` si la ruta no existe.
 */
export async function rallyRoute(rally: Rally, user: TeamUser, method: string, path: string, params: URLSearchParams, readBody: Body): Promise<unknown> {
  const log = (msg: string) => console.log(`[Rally] ${user.login}: ${msg}`);
  switch (`${method} ${path}`) {
    case 'GET /api/rally':
      return rally.status(user);
    case 'POST /api/rally/connect':
      return rally.connect(user, await readBody());
    case 'POST /api/rally/disconnect':
      return rally.disconnect(user);
    case 'GET /api/rally/projects':
      return { projects: await rally.projects(user) };
    case 'POST /api/rally/move': {
      const body = await readBody();
      try {
        const item = await rally.move(user, body);
        if (body.dryRun !== true) log(`${String(body.id)} → ${String(body.category)} · ahora "${item.state}" (${item.category})`);
        return { item };
      } catch (e) {
        log(`${String(body.id)} → ${String(body.category)} · ERROR: ${(e as Error).message}`);
        throw e;
      }
    }
    case 'POST /api/rally/create': {
      const body = await readBody();
      try {
        const item = await rally.create(user, body);
        log(`creado ${item.id} "${item.name}"`);
        return { item };
      } catch (e) {
        log(`crear ${String(body.kind)} · ERROR: ${(e as Error).message}`);
        throw e;
      }
    }
    case 'POST /api/rally/flag': {
      const body = await readBody();
      const item = await rally.flag(user, body);
      log(`${String(body.id)} · Ready ${item.ready ? 'sí' : 'no'} · Blocked ${item.blocked ? 'sí' : 'no'}`);
      return { item };
    }
    case 'POST /api/rally/need-review': {
      const body = await readBody();
      const done = await rally.needReview(user, body);
      log(`${String(body.id)} → Need Review + Blocked (${String(body.defectId)})${done.commentError ? ` · comentario falló: ${done.commentError}` : ''}`);
      return done;
    }
    case 'POST /api/rally/message': {
      const body = await readBody();
      const done = await rally.messagePost(user, body);
      log(`mensaje en ${String(body.id)}${done.mentioned.length ? ` · menciona a ${done.mentioned.join(', ')}` : ''}`);
      return done;
    }
    case 'POST /api/rally/move-comment': {
      const body = await readBody();
      const done = await rally.moveCommentPost(user, body);
      log(`comentario de movimiento en ${String(body.id)}${done.analyst ? ` · analista ${done.analyst}` : ''}`);
      return done;
    }
    case 'POST /api/rally/comment': {
      const body = await readBody();
      try {
        const post = await rally.comment(user, body);
        log(`comentario en ${String(body.kind)} ${String(body.objectId)}`);
        return { post };
      } catch (e) {
        log(`comentario en ${String(body.kind)} ${String(body.objectId)} · ERROR: ${(e as Error).message}`);
        throw e;
      }
    }
    case 'POST /api/rally/attach': {
      const body = await readBody();
      try {
        const file = await rally.attach(user, body);
        log(`adjunto "${file.name}" en ${String(body.kind)} ${String(body.objectId)}`);
        return { file };
      } catch (e) {
        log(`adjunto en ${String(body.kind)} ${String(body.objectId)} · ERROR: ${(e as Error).message}`);
        throw e;
      }
    }
    case 'POST /api/rally/attachment-delete': {
      const body = await readBody();
      try {
        await rally.deleteAttachment(user, body);
        log(`adjunto ${String(body.objectId)} eliminado`);
        return { ok: true };
      } catch (e) {
        log(`eliminar adjunto ${String(body.objectId)} · ERROR: ${(e as Error).message}`);
        throw e;
      }
    }
    case 'POST /api/rally/lookup':
      return { items: await rally.lookup(user, await readBody()) };
    case 'GET /api/rally/users':
      return { users: await rally.searchUsers(user, params.get('q')) };
    case 'GET /api/rally/pick':
      return rally.searchArtifacts(user, Object.fromEntries(params));
    case 'GET /api/rally/tags':
      return rally.searchTags(user, Object.fromEntries(params));
    case 'GET /api/rally/form':
      return rally.formOptions(user, params.get('kind'), params.get('project'));
    case 'GET /api/rally/detail':
      return rally.detail(user, params.get('kind'), params.get('id'));
    case 'GET /api/rally/items': {
      const projects = (params.get('projects') ?? '').split(',').filter(Boolean);
      const tags = params.getAll('tag').filter(Boolean);
      return rally.itemsReport(user, Number(params.get('days') ?? 90) || 0, projects, tags);
    }
  }
  throw new ApiError(404, 'No existe.');
}
