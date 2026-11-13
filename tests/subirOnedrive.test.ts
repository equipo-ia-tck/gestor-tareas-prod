import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supabaseConfig, uploadCalendar } from '../scripts/subir-onedrive.ts';

const FLOW = JSON.stringify({ value: [
  { subject: 'Daily', start: '2026-11-13T09:00:00', end: '2026-11-13T09:15:00', body: { content: 'x'.repeat(5000) } },
  { subject: 'Cancelada', isCancelled: true, start: '2026-11-13T10:00:00' },
] });

describe('subir el calendario de OneDrive a Supabase', () => {
  it('lee la configuración del .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subir-'));
    writeFileSync(join(dir, '.env'), '# comentario\nVITE_SUPABASE_URL="https://abc.supabase.co/"\nVITE_SUPABASE_ANON_KEY=anon\n');
    expect(supabaseConfig({}, join(dir, '.env'))).toEqual({ url: 'https://abc.supabase.co', key: 'anon' });
    expect(() => supabaseConfig({}, join(dir, 'no-existe'))).toThrow(/Falta la configuración/);
  });

  it('sube solo las reuniones recortadas, con la clave y la fecha del archivo', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify('Marta García'), { status: 200 });
    }) as unknown as typeof fetch;
    const done = await uploadCalendar({ url: 'https://abc.supabase.co', key: 'anon', token: 'gsub_1', text: `﻿${FLOW}`, fileAt: new Date('2026-11-13T08:00:00Z') }, fake);
    expect(done).toEqual({ count: 1, account: 'Marta García' });
    expect(sent!.url).toBe('https://abc.supabase.co/rest/v1/rpc/upload_connector_file');
    const body = JSON.parse(String(sent!.init.body));
    expect(body).toMatchObject({ p_token: 'gsub_1', p_kind: 'calendario', p_file_at: '2026-11-13T08:00:00.000Z' });
    expect(body.p_data).toHaveLength(1);
    expect(body.p_data[0].title).toBe('Daily');
    expect(body.p_data[0].description.length).toBeLessThanOrEqual(2000);
  });

  it('explica los errores de Supabase y del archivo', async () => {
    const answer = (status: number, message: string) => (async () => new Response(JSON.stringify({ message }), { status })) as unknown as typeof fetch;
    const base = { url: 'https://x', key: 'k', token: 't', fileAt: new Date() };
    await expect(uploadCalendar({ ...base, text: FLOW }, answer(401, 'Clave de subida no válida: genera otra en Ajustes → Calendario.'))).rejects.toThrow(/Clave de subida/);
    await expect(uploadCalendar({ ...base, text: FLOW }, answer(404, 'Could not find the function public.upload_connector_file'))).rejects.toThrow(/migración 005/);
    await expect(uploadCalendar({ ...base, text: '{a medias' }, answer(200, ''))).rejects.toThrow(/no es JSON válido/);
  });
});
