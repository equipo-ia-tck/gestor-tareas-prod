// Empaqueta scripts/subir-onedrive.ts en un solo archivo, dist/subir-calendario.mjs, con la configuración de Supabase
// dentro (la URL y la clave anon, que ya van en la app). Es lo que se descarga en Ajustes → Calendario de Outlook para
// subir el calendario sin tener el repositorio. Se ejecuta al final de `npm run build` (también en Vercel).
import { readFileSync, writeFileSync } from 'node:fs';
import { build, loadEnv } from 'vite';

const OUT_DIR = 'dist';
const FILE = 'subir-calendario.mjs';

const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env };
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('build-subida: faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.');

await build({
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: 'scripts/subir-onedrive.ts',
    outDir: OUT_DIR,
    emptyOutDir: false,
    minify: false,
    target: 'node18',
    rollupOptions: { output: { format: 'es', entryFileNames: FILE } },
  },
});

const path = `${OUT_DIR}/${FILE}`;
const code = readFileSync(path, 'utf8');
const header = `#!/usr/bin/env node
// Gestor de tareas · subir el calendario de Outlook (OneDrive/Gestor/calendario.json) a tu cuenta.
// Uso: node subir-calendario.mjs <clave de Ajustes → Calendario de Outlook> --instalar
globalThis.GESTOR_EMBEDDED = ${JSON.stringify({ url: url.replace(/\/+$/, ''), key })};
`;
writeFileSync(path, header + code);
console.log(`build-subida: ${path} (${Math.round((header.length + code.length) / 1024)} KB)`);
