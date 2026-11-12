import { sync } from './sync';

/**
 * Si la app la sirve el servidor del Mac (localhost: 4173 o el 5173 de desarrollo). En Vercel solo existe Rally
 * (`api/rally.ts`); calendario, chats, lista y Confluence necesitan el servidor local y allí se ocultan.
 */
export const LOCAL_SERVER = typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * Llamada al servidor del equipo (servidor/), que hoy solo hace de puente con los conectores: Rally, Confluence,
 * calendario, chats y Microsoft List. Va con la sesión de Supabase (Bearer), y el servidor la comprueba con Supabase.
 */
export async function serverCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = (await sync().supabase.auth.getSession()).data.session?.access_token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || method === 'POST') headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
  });
  const json = await res.json().catch(() => null);
  if (json === null) {
    throw new Error(LOCAL_SERVER ? 'El servidor del equipo no responde. ¿Está en marcha (npm start)?'
      : 'No se puede conectar con el servicio. Vuelve a intentarlo en un momento.');
  }
  if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
  return json as T;
}
