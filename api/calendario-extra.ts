// Otro calendario por enlace ICS (p. ej. La Caixa) en Vercel: las mismas rutas que el servidor del Mac
// (`servidor/icsExtra.ts`), con el enlace de cada persona cifrado en Supabase con RALLY_SECRET (el secreto de los
// conectores). Variables de entorno de Vercel: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y RALLY_SECRET.
import { ApiError } from '../servidor/api.ts';
import { bearerOf, SupabaseAuth } from '../servidor/auth.ts';
import { IcsExtra, icsExtraRoute } from '../servidor/icsExtra.ts';
import { SupabaseIcsAccounts } from '../servidor/supabaseAccounts.ts';

const config = { url: (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''), key: process.env.VITE_SUPABASE_ANON_KEY ?? '' };
const auth = new SupabaseAuth(config);
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const secret = process.env.RALLY_SECRET;
      if (!config.url || !config.key || !secret) throw new ApiError(503, 'Falta configurar los conectores en Vercel.');
      const token = bearerOf(request.headers.get('authorization') ?? undefined);
      const user = await auth.userFor(token);
      if (!user || !token) throw new ApiError(401, 'Inicia sesión.');
      // vercel.json lleva /api/calendario-extra/<ruta> a esta función con ?route=<ruta>.
      const route = new URL(request.url).searchParams.get('route');
      const path = route ? `/api/calendario-extra/${route}` : '/api/calendario-extra';
      const cal = new IcsExtra(new SupabaseIcsAccounts(config, token, secret));
      const readBody = async () => {
        const text = await request.text();
        if (!text) return {};
        try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new ApiError(400, 'La petición no es JSON válido.'); }
      };
      return json(200, await icsExtraRoute(cal, user, request.method, path, readBody));
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'Error del servidor.' });
    }
  },
};
