import { useEffect, useRef, useState } from 'react';
import { BookText, Upload } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { sync } from '../../data/sync';
import { parseConfluencePage, type ConfluencePage } from '../../domain/confluence';
import { unzip } from './unzip';

/**
 * Ajustes → Documentación (solo administradores; migración 014). Se suben los export HTML de Confluence (uno o varios
 * zips, aprobados por José y Mati: solo cómo trabaja el equipo, sin documentación privada del cliente). El navegador los
 * abre, saca el texto de cada página y lo guarda en Supabase; el conector MCP lo busca después con «buscar_en_documentacion».
 * Se rehace entero cada vez (subida mensual): el primer lote vacía lo anterior.
 */

const BATCH = 120;
const isHtml = (name: string) => /\.html?$/i.test(name) && !name.includes('__MACOSX');

export function DocsCard() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<{ count: number; updatedAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadInfo = async () => {
    try {
      const { data, error: e } = await sync().supabase.rpc('docs_info');
      if (e) throw new Error(e.message);
      setInfo(data as { count: number; updatedAt: string | null });
    } catch (e) {
      setError(mensaje(e));
    }
  };
  useEffect(() => { void loadInfo(); }, []);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede abrir los zips. Usa Chrome.');
      // 1) Abrir los zips y parsear cada página.
      setStatus('Abriendo los archivos…');
      const byId = new Map<string, ConfluencePage>();
      for (const file of Array.from(files)) {
        const entries = await unzip(await file.arrayBuffer(), isHtml);
        for (const { name, text } of entries) {
          const page = parseConfluencePage(text, name);
          if (page) byId.set(page.id, page); // dedup por id
        }
        setStatus(`Leídas ${byId.size} páginas…`);
      }
      const pages = [...byId.values()];
      if (!pages.length) throw new Error('No he encontrado páginas en esos archivos. ¿Son export HTML de un espacio de Confluence?');

      // 2) Subir en lotes; el primero vacía lo anterior.
      let saved = 0;
      for (let i = 0; i < pages.length; i += BATCH) {
        const batch = pages.slice(i, i + BATCH);
        const { data, error: e } = await sync().supabase.rpc('admin_save_docs', { p_docs: batch, p_reset: i === 0 });
        if (e) throw new Error(e.message);
        saved = (data as { count: number }).count;
        setStatus(`Subiendo… ${Math.min(i + BATCH, pages.length)} de ${pages.length}`);
      }
      setStatus(null);
      toast(`Documentación actualizada: ${saved} páginas`);
      await loadInfo();
    } catch (e) {
      setStatus(null);
      setError(mensaje(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <section className="mb-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><BookText size={16} /> Documentación</h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Sube el export HTML de Confluence (uno o varios .zip) para que el asistente de Claude pueda consultarlo con el
        conector de Marea. Se reemplaza entero cada vez, así que vuelve a subir el export completo cada mes.
      </p>
      {info && (
        <p className="mb-3 text-sm">
          {info.count > 0
            ? <>Hay <strong>{info.count}</strong> páginas{info.updatedAt ? `, actualizadas el ${new Date(info.updatedAt).toLocaleDateString('es-ES')}` : ''}.</>
            : 'Aún no hay documentación subida.'}
        </p>
      )}
      <input ref={fileInput} type="file" accept=".zip" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
      <button
        disabled={busy}
        onClick={() => fileInput.current?.click()}
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
      >
        <Upload size={15} /> {busy ? 'Procesando…' : 'Subir export de Confluence'}
      </button>
      {status && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{status}</p>}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

function mensaje(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/docs_info|admin_save_docs|function.*does not exist|404/i.test(m)) {
    return 'Falta preparar la documentación en Supabase: un administrador tiene que ejecutar supabase/migrations/014_documentacion.sql.';
  }
  return m;
}
