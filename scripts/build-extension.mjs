// Empaqueta la extensión de Chrome «Marea · Lista» (carpeta extension/) en dist/marea-lista/ y en
// dist/marea-lista-extension.zip, que se descarga desde la pantalla Lista. Mete en background.js el trabajo en SharePoint
// de src/features/mslist/spWork.ts y la documentación de src/features/assistant/spDocs.ts (compilados con Vite, sin minificar, para no depender de la versión de Node). Se
// ejecuta al final de `npm run build`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const TMP = 'dist/.extension-tmp';
await build({
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: true,
    outDir: TMP,
    emptyOutDir: true,
    minify: false,
    target: 'node18',
    rollupOptions: {
      input: { spWork: 'src/features/mslist/spWork.ts', spDocs: 'src/features/assistant/spDocs.ts' },
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
});
const { spWork } = await import(pathToFileURL(`${TMP}/spWork.mjs`).href);
const { spDocs } = await import(pathToFileURL(`${TMP}/spDocs.mjs`).href);
rmSync(TMP, { recursive: true, force: true });

const OUT = 'dist/marea-lista';
const ZIP = 'dist/marea-lista-extension.zip';
mkdirSync(OUT, { recursive: true });

const files = {
  'manifest.json': readFileSync('extension/manifest.json'),
  'content.js': readFileSync('extension/content.js'),
  'background.js': Buffer.from(readFileSync('extension/background.template.js', 'utf8')
    .replaceAll('/*SPWORK*/', spWork.toString()).replaceAll('/*SPDOCS*/', spDocs.toString())),
  'icon.png': readFileSync('public/pwa-192.png'),
};
for (const [name, data] of Object.entries(files)) writeFileSync(`${OUT}/${name}`, data);

// ZIP sin comprimir (método «store»), sin dependencias: todo dentro de una carpeta «marea-lista/».
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const local = [];
const central = [];
let offset = 0;
for (const [name, data] of Object.entries(files)) {
  const path = Buffer.from(`marea-lista/${name}`);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0, 8);
  head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(path.length, 26); head.writeUInt16LE(0, 28);
  local.push(head, path, data);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(0, 10);
  dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(path.length, 28); dir.writeUInt32LE(0, 30); dir.writeUInt32LE(0, 34); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
  central.push(dir, path);
  offset += head.length + path.length + data.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
const count = Object.keys(files).length;
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, ...central, end]);
writeFileSync(ZIP, zip);
console.log(`build-extension: ${ZIP} (${Math.round(zip.length / 1024)} KB)`);
