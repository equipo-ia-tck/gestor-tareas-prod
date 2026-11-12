// Rally en Vercel: las mismas rutas que el servidor local (`servidor/rallyRoutes.ts`), con la clave de cada persona
// cifrada en Supabase. Variables de entorno de Vercel: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y RALLY_SECRET.
import { ApiError } from '../servidor/api.ts';
import { bearerOf, SupabaseAuth } from '../servidor/auth.ts';
import { Rally } from '../servidor/rally.ts';
import { rallyRoute } from '../servidor/rallyRoutes.ts';
import { SupabaseRallyAccounts } from '../servidor/supabaseAccounts.ts';

const config = { url: (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''), key: process.env.VITE_SUPABASE_ANON_KEY ?? '' };
const auth = new SupabaseAuth(config);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const secret = process.env.RALLY_SECRET;
      if (!config.url || !config.key || !secret) throw new ApiError(503, 'Falta configurar Rally en Vercel.');
      const token = bearerOf(request.headers.get('authorization') ?? undefined);
      const user = await auth.userFor(token);
      if (!user || !token) throw new ApiError(401, 'Inicia sesión.');
      const url = new URL(request.url);
      // vercel.json lleva /api/rally/<ruta> a esta función con ?route=<ruta>.
      const route = url.searchParams.get('route');
      url.searchParams.delete('route');
      const path = route ? `/api/rally/${route}` : '/api/rally';
      const rally = new Rally(new SupabaseRallyAccounts(config, token, secret));
      const readBody = async () => {
        const text = await request.text();
        if (!text) return {};
        try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new ApiError(400, 'La petición no es JSON válido.'); }
      };
      return json(200, await rallyRoute(rally, user, request.method, path, url.searchParams, readBody));
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'Error del servidor.' });
    }
  },
};
