// Conector MCP de Marea para Claude (lectura, más guardar la respuesta para el Asistente). Claude se conecta a https://<marea>/api/mcp; la primera vez pide
// «Entrar con Marea» (OAuth 2.1 de Supabase Auth, con la página de permiso /oauth-consent de la app) y después manda la
// sesión de la persona en cada petición. Variables de Vercel: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SearchIndex } from '../src/domain/knowledge.ts';
import { bearerOf, SupabaseAuth } from '../servidor/auth.ts';
import { askSharePoint, chunksOf, loadMarea, mareaServer, saveAnswer } from '../servidor/mcp.ts';

const config = { url: (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''), key: process.env.VITE_SUPABASE_ANON_KEY ?? '' };
const auth = new SupabaseAuth(config);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...CORS, ...headers } });

/** Metadatos del recurso protegido (RFC 9728): dice a Claude que el login es el de Supabase Auth. */
export function resourceMetadata(origin: string, supabaseUrl: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [`${supabaseUrl}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'Marea',
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!config.url || !config.key) return json(503, { error: 'Falta configurar Supabase en Vercel.' });
    // vercel.json manda aquí /.well-known/oauth-protected-resource(/api/mcp) y /.well-known/oauth-authorization-server.
    const route = url.searchParams.get('route');
    if (route === 'prm') return json(200, resourceMetadata(origin, config.url));
    if (route === 'asm') {
      // Clientes que buscan el servidor de autorización en este dominio: se les da el de Supabase tal cual.
      const res = await fetch(`${config.url}/.well-known/oauth-authorization-server/auth/v1`);
      return json(res.status, await res.json().catch(() => ({})));
    }

    const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`;
    const token = bearerOf(request.headers.get('authorization') ?? undefined);
    let user;
    try {
      user = token ? await auth.userFor(token) : null;
    } catch {
      return json(503, { error: 'No se puede conectar con Supabase.' });
    }
    if (!user || !token) return json(401, { error: 'Entra con tu cuenta de Marea.' }, { 'WWW-Authenticate': challenge });

    // Sin sesiones: cada petición crea su servidor (Vercel puede atender cada una en una instancia distinta).
    const server = mareaServer(async () => {
      const entry = await loadMarea(config, token, user);
      const data = { ...entry.data, base: origin };
      return { data, index: () => (entry.index ??= new SearchIndex(chunksOf(data))) };
    }, (id, question, answer) => saveAnswer(config, token, id, question, answer),
    (op, args) => askSharePoint(config, token, op, args));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};
